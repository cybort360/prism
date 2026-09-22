import Foundation
import SwiftUI

/// Everything the Circle detail screen reads, in one place.
///
/// Four calls make a Circle screen: the Circle itself (which carries the live balance, the live
/// authority and the members), the approval inbox, the money history, and the limits. They are
/// fetched together and each is allowed to fail on its own — a Circle whose limits could not be read
/// still has a balance worth showing, and pretending otherwise would hide the whole screen behind
/// the least important call on it.
///
/// The rule this model exists to hold: **a value that could not be read is absent, not stale.**
/// `balanceLine` returns a dash rather than the number from the previous load, because a shared
/// account showing a balance nobody can confirm is exactly how two people end up disagreeing about
/// what is in it.
@MainActor
final class CircleDetailModel: ObservableObject {
  @Published var route: [CircleDetailRoute] = []
  @Published var payPickerPresented = false
  @Published var governanceUnderReview: CircleGovernanceProposal?
  @Published var activityLimit = 6

  @Published private(set) var detail: CircleDetail?
  @Published private(set) var pending: [CirclePendingItem] = []
  @Published private(set) var activity: [CircleActivityItem] = []
  @Published private(set) var limits: [CircleSpendingLimit] = []
  @Published private(set) var limitsEnabled = false
  @Published private(set) var error: String?
  @Published private(set) var loaded = false
  /// Why the approval inbox is empty, when the reason is "we could not tell" rather than "nothing".
  @Published private(set) var pendingUnavailable: String?
  /// True when the feed had to fall back to the local money-only merge, so the screen can say that
  /// joins, removals and limit changes are missing rather than implying nothing happened.
  @Published private(set) var activityUnavailable = false
  /// The closure state, once someone opens it. Nil until asked for: it is a live read every time.
  @Published var closeState: CircleCloseState?
  /// What this member could withdraw right now, read live alongside everything else. Nil means
  /// unknown (not yet loaded, or not a member) — never treated as zero.
  @Published private(set) var withdrawable: CircleWithdrawableResponse?

  private var circleId: String?
  private var myPrismId: String?

  func start(circleId: String) async {
    self.circleId = circleId
    await reload()
  }

  func reload() async {
    guard let circleId else { return }
    // Seven reads, each allowed to fail on its own. A Circle whose limits could not be read still has
    // a balance worth showing; hiding the screen behind its least important call would be worse.
    async let detailTask = PrismAPI.shared.circle(circleId)
    async let pendingTask = PrismAPI.shared.circlePending(circleId)
    async let activityTask = PrismAPI.shared.circleActivity(circleId)
    async let contributionsTask = PrismAPI.shared.contributions(circleId: circleId)
    async let paymentsTask = PrismAPI.shared.circlePayments(circleId)
    async let spendsTask = PrismAPI.shared.circleSpends(circleId)
    async let limitsTask = PrismAPI.shared.circleLimits(circleId)
    // Fails silently for someone who isn't an active member yet — that's an ordinary "not yet
    // known" here, the same as every other read this screen tolerates failing on its own.
    async let withdrawableTask = PrismAPI.shared.circleWithdrawable(circleId)

    let fetchedDetail = try? await detailTask
    let fetchedPending = try? await pendingTask
    let fetchedActivity = try? await activityTask
    let contributions = (try? await contributionsTask) ?? []
    let payments = (try? await paymentsTask) ?? []
    let spends = (try? await spendsTask) ?? []
    let fetchedLimits = try? await limitsTask
    withdrawable = try? await withdrawableTask

    if let fetchedDetail { detail = fetchedDetail }
    error = fetchedDetail == nil ? "Prism couldn't reach this Circle just now. Pull down to try again." : nil

    pending = fetchedPending?.pending ?? []
    pendingUnavailable = fetchedPending?.unavailable ?? fetchedPending?.note

    limitsEnabled = fetchedLimits?.limitsEnabled ?? false
    limits = fetchedLimits?.limits ?? []

    // The Circle's feed comes from the backend, where it is projected from records already
    // reconciled against the chain — money AND governance, in one list. The local merge below is a
    // fallback for when that call fails: narrower (money only), built from the same reconciled
    // records, and never a history the phone invented.
    if let fetchedActivity {
      activity = fetchedActivity.activity.map(CircleActivityItem.init(wire:))
      activityUnavailable = false
    } else {
      let names = Dictionary(
        uniqueKeysWithValues: (detail?.members ?? []).map {
          ($0.prismId, $0.displayName ?? $0.handle ?? "A member")
        })
      activity = CircleActivityItem.feed(
        contributions: contributions, payments: payments, spends: spends,
        memberName: { id in id.flatMap { names[$0] } ?? "Someone" })
      activityUnavailable = true
    }

    loaded = true
  }

  func setMe(_ prismId: String?) { myPrismId = prismId }

  // MARK: what the screen asks for

  func name(fallback: String) -> String { detail?.name ?? fallback }

  var members: [CircleMember] {
    (detail?.members ?? []).filter { $0.status != "REMOVED" && $0.status != "LEFT" }
  }

  var activeMemberCount: Int { members.count }

  var peopleLine: String {
    guard detail != nil else { return "…" }
    let count = activeMemberCount
    return "\(count) \(count == 1 ? "person" : "people")"
  }

  var balanceUnavailable: Bool {
    guard let balance = detail?.balance else { return detail != nil }
    return !balance.isKnown
  }

  /// A dash means "not known right now". It never means zero, and it is never the last number seen.
  var balanceLine: String {
    guard let balance = detail?.balance, balance.isKnown, let atomic = balance.amountAtomic else { return "-" }
    return Money.assetAmount(fromAtomic: atomic, decimals: balance.decimals ?? 6)
  }

  var balanceAccessibilityLine: String {
    balanceUnavailable
      ? "Balance unavailable. Prism couldn't read it from Monad."
      : "Balance \(balanceLine)"
  }

  /// The blocking state, if the Circle is not usable at all yet. Nil means show the real screen.
  ///
  /// `failureReason` comes from the caller's Circle summary rather than from the detail, because the
  /// detail read does not carry one — and inventing a reason for a verification failure would
  /// undo the point of verifying.
  func blockingState(failureReason: String?) -> CircleState? {
    guard let detail else { return loaded ? .networkUnavailable(detail: nil) : nil }
    switch detail.status {
    // A Circle that is winding down is still a usable Circle: money can still be paid out of it,
    // which is how the remaining balance leaves. Blocking the screen would strand it.
    case "ACTIVE", "CLOSING": return nil
    case "VERIFICATION_FAILED": return .setupFailed(reason: failureReason)
    case "CLOSED": return nil
    default: return .deploymentPending(status: detail.status)
    }
  }

  private var me: CircleMember? {
    guard let myPrismId else { return nil }
    return detail?.members?.first { $0.prismId == myPrismId }
  }

  var myRole: CircleVocabulary.Role { .init(wire: me?.role) }

  /// Admin authority is the *chain's* answer, not Prism's: someone who accepted an admin invitation
  /// but has not been added on Monad is not an admin, and must not be offered admin controls.
  var isAdmin: Bool {
    guard let me else { return false }
    return CircleVocabulary.Role(wire: me.role) == .admin && me.authorityConfirmedOnChain == true
  }

  var canContribute: Bool {
    guard let me, me.status == "ACTIVE" || me.status == "PENDING_ACTIVATION" else { return false }
    return [.admin, .spender, .contributor].contains(CircleVocabulary.Role(wire: me.role))
  }

  var canPropose: Bool { canContribute }

  /// Whether the Withdraw action should be offered at all. Backed entirely by the backend's live
  /// `withdrawableAtomic` — never a number this screen derives from contributions it read itself.
  var canWithdraw: Bool {
    guard let withdrawable, let amount = Decimal(string: withdrawable.withdrawableAtomic) else { return false }
    return amount > 0
  }

  func limit(for prismId: String) -> CircleSpendingLimit? {
    limits.first { $0.prismId == prismId }
  }

  /// The inbox, split by whether this person still has to do something about it.
  ///
  /// "Still has to" is decided from the approval records, which carry the authority address that
  /// actually signed — so an admin who has already approved sees the item under "also pending"
  /// rather than being asked twice.
  var awaitingMyApproval: [CirclePendingItem] {
    guard isAdmin else { return [] }
    return pending.filter { !hasMyApproval($0) && !isDead($0) }
  }

  var pendingNotMine: [CirclePendingItem] {
    let mine = Set(awaitingMyApproval.map(\.id))
    return pending.filter { !mine.contains($0.id) }
  }

  /// Has this person's approval already been counted?
  ///
  /// Checked against the authority address that actually signed, not against a Prism id, because
  /// that address is what the Safe counts. A governance approval comes back without a Prism id at
  /// all, so an id-only check would ask an admin to approve the same change twice.
  private func hasMyApproval(_ item: CirclePendingItem) -> Bool {
    guard let myPrismId else { return false }
    let approvals = item.payment?.approvals ?? item.governance?.approvals ?? []
    if approvals.contains(where: { $0.prismId == myPrismId }) { return true }
    guard let mine = me?.authorityAddress?.lowercased() else { return false }
    return approvals.contains { $0.authorityAddress.lowercased() == mine }
  }

  private func isDead(_ item: CirclePendingItem) -> Bool {
    if let payment = item.payment { return payment.isComplete || payment.isDead }
    if let governance = item.governance { return governance.isComplete || governance.isDead }
    return false
  }

  func requesterLabel(_ prismId: String?, me myPrismId: String?) -> String {
    guard let prismId else { return "a member" }
    if prismId == myPrismId { return "you" }
    if let member = detail?.members?.first(where: { $0.prismId == prismId }) {
      return member.displayName ?? member.handle ?? "a member"
    }
    return "a member"
  }
}
