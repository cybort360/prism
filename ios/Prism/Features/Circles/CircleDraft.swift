import Foundation

/// A person who could be in a Circle, resolved to a real Prism identity.
///
/// `id` is their Prism id, and it is not optional on purpose: a Circle admin is an authority on
/// Monad, so someone who cannot be resolved to a Prism identity cannot be added at all. Resolving
/// happens at selection time — through the same Protected Alias Resolver a payment uses — rather
/// than at creation time, so a person who has not finished setting up their account is refused
/// while there is still a screen to explain it on.
struct CircleCandidate: Identifiable, Equatable, Hashable {
  let id: String
  let name: String
  let handle: String?
  let initials: String
}

/// Everything the creation flow is holding, and the rules about when it may move forward.
///
/// The draft owns the network calls too, so each step view stays a rendering of state rather than a
/// small program of its own. Two rules are enforced here rather than in any view:
///
///  - **A Circle is created with its admins, and only its admins.** Admins are the Safe's owner set
///    and have to exist at deployment; everyone else is invited afterwards. So `create()` is a
///    creation followed by invitations, and it reports honestly if the second half partly fails.
///  - **A spending limit is never promised.** Limits are changes the Circle approves on Monad, so
///    the most this flow can do is prepare the first proposal for each and say that it is waiting.
@MainActor
final class CircleDraft: ObservableObject {
  enum Step: Int, CaseIterable, Identifiable {
    case name, people, admins, approvalRule, spending, review
    var id: Int { rawValue }

    var question: String {
      switch self {
      case .name: return "What are you managing together?"
      case .people: return "Who is part of it?"
      case .admins: return "Who can approve payments?"
      case .approvalRule: return "How many admins are needed?"
      case .spending: return "Who can spend without asking every time?"
      case .review: return "Ready to create?"
      }
    }
  }

  /// The kind of Circle, which is what makes a threshold recommendation possible. These map onto the
  /// backend's templates; a template only ever *recommends*, and never picks a person or overrides
  /// a choice the creator made.
  enum Kind: String, CaseIterable, Identifiable {
    case trip = "TRIP"
    case family = "FAMILY"
    case community = "COMMUNITY"
    var id: String { rawValue }

    var label: String {
      switch self {
      case .trip: return "Trip"
      case .family: return "Household"
      case .community: return "Group"
      }
    }
    var blurb: String {
      switch self {
      case .trip: return "A shared pot for a trip, closed when everyone gets home."
      case .family: return "A household account a couple of people keep an eye on."
      case .community: return "A group fund where no single person should move money alone."
      }
    }
  }

  enum SpendingAccess: String, CaseIterable, Identifiable, Equatable {
    case canSpend, contributeOnly, approvalRequired
    var id: String { rawValue }

    var shortLabel: String {
      switch self {
      case .canSpend: return "Can spend"
      case .contributeOnly: return "Add money"
      case .approvalRequired: return "Ask first"
      }
    }
    var summary: String {
      switch self {
      case .canSpend: return "Can pay from the Circle on their own, up to a limit"
      case .contributeOnly: return "Can add money and suggest payments"
      case .approvalRequired: return "Every payment they make needs approval"
      }
    }
    /// The role this maps to on the wire. "Ask first" and "add money" are the same authority — the
    /// difference is only what the person expects — so both are CONTRIBUTOR, and the UI does not
    /// pretend they are two different powers.
    var role: CircleVocabulary.Role { self == .canSpend ? .spender : .contributor }
  }

  enum Creation: Equatable {
    case idle, creating, confirming, inviting, ready
    case failed(String)
  }

  // MARK: state
  @Published var step: Step = .name
  @Published var name = ""
  @Published var icon: String?
  @Published var kind: Kind = .trip
  @Published var people: [CircleCandidate] = []
  @Published var adminIds: Set<String> = []
  @Published var threshold = 1
  @Published var spendingAccess: [String: SpendingAccess] = [:]
  @Published var spendingAmount: [String: String] = [:]
  @Published var spendingPeriod: [String: String] = [:]
  @Published var error: String?
  @Published var showAuthorization = false
  @Published var creation: Creation = .idle
  @Published private(set) var created: CircleSummary?
  @Published private(set) var me: CircleCandidate?
  @Published private(set) var guidance: CircleTemplateGuidance?
  @Published private(set) var loadingGuidance = false
  @Published private(set) var limitsEnabled = false
  @Published private(set) var limitsReason: String?

  /// One retry token for the whole creation, so a tap that times out and is repeated resumes the
  /// same Circle rather than deploying a second one.
  private let idempotencyKey = "circle-create:\(UUID().uuidString)"

  // MARK: derived

  var allPeople: [CircleCandidate] { [me].compactMap { $0 } + people }

  var admins: [CircleCandidate] { allPeople.filter { $0.id == me?.id || adminIds.contains($0.id) } }
  var adminCount: Int { admins.count }
  var adminNames: [String] { admins.map { $0.id == me?.id ? "\($0.name) (you)" : $0.name } }

  /// The rules on offer — and only once the backend has told us what each one costs.
  ///
  /// Empty while guidance is missing, deliberately. A locally-invented list would show 2-of-2
  /// without its warning, and 2-of-2 is the one configuration a Circle cannot recover from. Offering
  /// it un-warned, and then having the backend refuse the creation for a missing acknowledgement,
  /// would be the worst of both.
  var thresholdChoices: [CircleThresholdChoice] {
    guard let guidance, guidance.adminCount == adminCount else { return [] }
    return guidance.choices
  }

  /// True once this device has the consequences for the admin count actually selected.
  var hasGuidance: Bool { guidance?.adminCount == adminCount }

  /// The warning codes the chosen rule carries, which the backend requires an explicit
  /// acknowledgement of. Selecting the option on screen *is* that acknowledgement — the consequence
  /// was shown next to it — so this is what gets sent.
  var acknowledgedWarnings: [String] {
    thresholdChoices.first { $0.threshold == threshold }?.warnings.map(\.code) ?? []
  }

  var authorizationDetail: String {
    "Creates \(name) on Monad with \(adminCount) admin\(adminCount == 1 ? "" : "s"), where \(CircleVocabulary.approvalRule(threshold: threshold, admins: adminCount)) must approve every payment."
  }

  /// The plain statements the review screen leads with. Assembled here so they are one list that
  /// can be read in order, rather than three fragments scattered across a card.
  var authorityStatements: [String] {
    var statements: [String] = []
    statements.append(CircleVocabulary.approvalRuleConsequence(threshold: threshold, admins: adminCount))

    if limitsEnabled {
      let spenders = allPeople.filter { spendingAccess[$0.id] == .canSpend }
      for spender in spenders {
        let amount = spendingAmount[spender.id].flatMap { Decimal(string: $0) }
        let period = periodPhrase(spendingPeriod[spender.id] ?? "DAILY")
        if let amount {
          let rendered = NSDecimalNumber(decimal: amount).doubleValue.formatted(
            .currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
          statements.append("\(spender.name) can pay up to \(rendered) \(period) on their own, once the Circle approves that limit on Monad.")
        }
      }
      if spenders.isEmpty {
        statements.append("Nobody can pay out of this Circle without the admins approving it.")
      }
    } else {
      statements.append("Nobody can pay out of this Circle without the admins approving it.")
    }

    let others = allPeople.filter { !admins.contains($0) }
    if !others.isEmpty {
      statements.append("\(others.map(\.name).joined(separator: ", ")) can add money and suggest payments, but cannot approve them.")
    }
    statements.append("Prism cannot move this money. Only the approvals above can.")
    return statements
  }

  struct SpendingSummaryLine: Identifiable, Equatable {
    var id: String { who }
    let who: String
    let what: String
  }

  var spendingSummaryLines: [SpendingSummaryLine] {
    allPeople.compactMap { person in
      guard spendingAccess[person.id] == .canSpend,
        let raw = spendingAmount[person.id], let amount = Decimal(string: raw), amount > 0
      else { return nil }
      let rendered = NSDecimalNumber(decimal: amount).doubleValue.formatted(
        .currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
      return SpendingSummaryLine(
        who: "\(person.name) can spend",
        what: "up to \(rendered) \(periodPhrase(spendingPeriod[person.id] ?? "DAILY"))")
    }
  }

  var canAdvance: Bool {
    switch step {
    case .name: return name.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
    case .people: return true                      // a Circle of one is legitimate
    case .admins: return adminCount >= 1
    // A rule cannot be confirmed before its consequences have been shown — which is also what the
    // backend requires an acknowledgement of, so this is the same gate on both sides.
    case .approvalRule: return hasGuidance && threshold >= 1 && threshold <= adminCount
    case .spending: return spendingStepIsValid
    case .review: return true
    }
  }

  private var spendingStepIsValid: Bool {
    guard limitsEnabled else { return true }
    // A "can spend" with no amount is not a limit, and shipping it would create an allowance
    // proposal for zero.
    for person in allPeople where spendingAccess[person.id] == .canSpend {
      guard let raw = spendingAmount[person.id], let value = Decimal(string: raw), value > 0 else { return false }
    }
    return true
  }

  // MARK: actions

  func load(me identity: PrismIdentity?) async {
    if let identity {
      me = CircleCandidate(
        id: identity.prismId,
        name: identity.displayName ?? identity.handle.map { "@\($0)" } ?? "You",
        handle: identity.handle.map { $0.hasPrefix("@") ? $0 : "@\($0)" },
        initials: Self.initials(for: identity))
    }
    if let status = try? await PrismAPI.shared.circleLimitsStatus() {
      limitsEnabled = status.enabled
      limitsReason = status.reason
    }
    await refreshGuidance()
  }

  func refreshGuidance() async {
    loadingGuidance = true
    defer { loadingGuidance = false }
    guidance = try? await PrismAPI.shared.circleTemplateGuidance(template: kind.rawValue, admins: adminCount)
    // Land on the recommendation, but only while the person has not chosen for themselves.
    if let recommended = guidance?.recommendedThreshold, !thresholdTouched {
      threshold = recommended
    }
    threshold = min(max(1, threshold), max(1, adminCount))
  }

  private var thresholdTouched = false

  func add(name: String, handle: String?, initials: String, resolution: ResolutionResponse) throws {
    guard resolution.found, let attestation = resolution.attestation else {
      throw CircleDraftError.notOnPrism(name)
    }
    let prismId = attestation.prismIdentity
    guard prismId != me?.id else { throw CircleDraftError.alreadyIncluded(name) }
    guard !people.contains(where: { $0.id == prismId }) else { throw CircleDraftError.alreadyIncluded(name) }
    people.append(CircleCandidate(id: prismId, name: name, handle: handle, initials: initials))
    spendingAccess[prismId] = .contributeOnly
    error = nil
  }

  func remove(_ person: CircleCandidate) {
    people.removeAll { $0.id == person.id }
    adminIds.remove(person.id)
    spendingAccess[person.id] = nil
    spendingAmount[person.id] = nil
    spendingPeriod[person.id] = nil
  }

  func toggleAdmin(_ person: CircleCandidate) {
    if adminIds.contains(person.id) { adminIds.remove(person.id) } else { adminIds.insert(person.id) }
  }

  func advance() {
    error = nil
    guard let next = Step(rawValue: step.rawValue + 1) else { return }
    if step == .approvalRule { thresholdTouched = true }
    // With limits unavailable there is nothing to choose on the spending step, but it is still
    // shown: "every payment is approved by the admins" is a fact people need, not a blank to skip.
    step = next
  }

  func back() {
    error = nil
    guard let previous = Step(rawValue: step.rawValue - 1) else { return }
    step = previous
  }

  /// Create the Circle, then invite everyone who is not an admin, then prepare any limits.
  ///
  /// Only the first of those three can fail in a way that means "there is no Circle". The other two
  /// are reported without pretending the Circle failed, because it did not — it exists, and some
  /// people still need adding.
  func create(pin: String?, useFaceID: Bool) async {
    error = nil
    do {
      creation = .creating
      try await localApproval(pin: pin, useFaceID: useFaceID)

      var circle = try await PrismAPI.shared.createCircle(
        name: name.trimmingCharacters(in: .whitespacesAndNewlines),
        icon: icon, template: kind.rawValue,
        adminPrismIds: admins.map(\.id).filter { $0 != me?.id },
        threshold: threshold,
        acknowledgement: CirclePolicyAcknowledgement(
          threshold: threshold, adminCount: adminCount, acknowledgedWarnings: acknowledgedWarnings),
        idempotencyKey: idempotencyKey)
      created = circle

      // "Ready" is a chain fact. Reading the Circle is also what advances it, so this loop is not
      // idle polling — it is what moves DEPLOYING to CONFIRMING to ACTIVE.
      creation = .confirming
      for _ in 0..<45 {
        if circle.isActive { break }
        if circle.hasFailed {
          creation = .failed(circle.failureReason ?? "Prism checked this Circle on Monad and it didn't match what you authorized, so it wasn't activated.")
          PrismHaptics.error()
          return
        }
        try await Task.sleep(for: .milliseconds(500))
        if let detail = try? await PrismAPI.shared.circle(circle.circleId) {
          circle = Self.summary(from: detail, template: kind.rawValue, previous: circle)
          created = circle
        }
      }

      guard circle.isActive else {
        // Still confirming. Not a failure and not a success — the Circle is real and will finish.
        creation = .ready
        PrismHaptics.warning()
        return
      }

      creation = .inviting
      let problems = await inviteEveryoneElse(circleId: circle.circleId)
      if !problems.isEmpty {
        error = "The Circle was created. \(problems.joined(separator: " "))"
      }

      creation = .ready
      PrismHaptics.success()
    } catch {
      creation = .failed(CircleCoordinator.message(for: error))
      PrismHaptics.error()
    }
  }

  /// Invite the non-admins, and prepare a limit proposal for anyone who was given one.
  /// Returns human-readable problems; an empty array means everything landed.
  private func inviteEveryoneElse(circleId: String) async -> [String] {
    var problems: [String] = []
    for person in people where !adminIds.contains(person.id) {
      let access: SpendingAccess = limitsEnabled ? (spendingAccess[person.id] ?? .contributeOnly) : .contributeOnly
      let role = access.role
      do {
        _ = try await PrismAPI.shared.inviteToCircle(
          circleId: circleId, prismId: person.id, handle: nil, role: role.rawValue)
      } catch {
        problems.append("\(person.name) couldn't be invited. You can add them from the Circle.")
      }
    }

    guard limitsEnabled else { return problems }
    for person in allPeople where spendingAccess[person.id] == .canSpend {
      guard let raw = spendingAmount[person.id], let atomic = Money.atomic(fromDollars: raw) else { continue }
      do {
        _ = try await PrismAPI.shared.prepareCircleLimit(
          circleId: circleId, prismId: person.id, amountAtomic: atomic,
          period: spendingPeriod[person.id] ?? "DAILY")
      } catch {
        // Expected for anyone who has not accepted their invitation yet. It is not a failure of the
        // Circle, and the limit can be set from the member's own screen.
        problems.append("\(person.name)'s spending limit still needs to be set up from their member page.")
      }
    }
    return problems
  }

  private func localApproval(pin: String?, useFaceID: Bool) async throws {
    if useFaceID {
      try await BiometricService().authenticate()
    } else {
      guard let pin, try PINService.shared.verify(pin) else { throw PaymentError.badPIN }
    }
  }

  private func periodPhrase(_ period: String) -> String {
    switch period {
    case "WEEKLY": return "per week"
    case "MONTHLY": return "per month"
    case "TOTAL": return "in total"
    default: return "per day"
    }
  }

  private static func initials(for identity: PrismIdentity) -> String {
    let source = identity.displayName ?? identity.handle?.replacingOccurrences(of: "@", with: "") ?? ""
    let value = source.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    return value.isEmpty ? "U" : value
  }

  /// The detail read while waiting carries the live status; fold it back onto the summary the list
  /// and the detail screen both take.
  private static func summary(from detail: CircleDetail, template: String, previous: CircleSummary) -> CircleSummary {
    CircleSummary(
      circleId: detail.circleId, name: detail.name, icon: detail.icon,
      safeAddress: detail.safeAddress, chainId: detail.chainId, asset: previous.asset,
      status: detail.status, myRole: previous.myRole, myStatus: previous.myStatus,
      verifiedOnChain: detail.verifiedOnChain, requested: previous.requested,
      failureReason: previous.failureReason)
  }
}

enum CircleDraftError: LocalizedError {
  case notOnPrism(String)
  case alreadyIncluded(String)

  var errorDescription: String? {
    switch self {
    case .notOnPrism(let name):
      return "\(name) isn't on Prism yet. Everyone in a Circle needs a Prism account, because the Circle is shared with their account and not with their phone number."
    case .alreadyIncluded(let name):
      return "\(name) is already in this Circle."
    }
  }
}
