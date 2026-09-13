import Foundation

/// The words Circles uses with people, in one place.
///
/// There is a hard rule here and it is worth stating plainly: **no Safe, multisig, wallet, owner,
/// signer, threshold, nonce, delegate or allowance vocabulary reaches a normal screen.** A person
/// managing a trip fund is not operating a treasury. They have a Circle, it has admins, payments
/// need a number of approvals, and some people can spend up to a limit. The underlying mechanism is
/// real and load-bearing, and it is exactly as visible to them as ACH is inside a bank app.
///
/// Everything in this file is a pure function of wire values, so the copy is testable without a
/// screen and cannot quietly diverge between the six places it appears.
enum CircleVocabulary {

  // MARK: roles

  /// What a member may do, in the app's own words. The raw wire roles are ADMIN · SPENDER ·
  /// CONTRIBUTOR · VIEWER; none of those four words is shown to a person as-is except "Admin".
  enum Role: String, CaseIterable, Identifiable {
    case admin = "ADMIN"
    case spender = "SPENDER"
    case contributor = "CONTRIBUTOR"
    case viewer = "VIEWER"

    var id: String { rawValue }

    init(wire: String?) { self = Role(rawValue: wire ?? "") ?? .viewer }

    var title: String {
      switch self {
      case .admin: return "Admin"
      case .spender: return "Can spend"
      case .contributor: return "Can add money"
      case .viewer: return "Can view"
      }
    }

    /// The one line a picker row shows under the title.
    var summary: String {
      switch self {
      case .admin: return "Approves payments and changes to the Circle"
      case .spender: return "Can spend up to a limit without asking each time"
      case .contributor: return "Adds money and suggests payments for approval"
      case .viewer: return "Sees the Circle, moves nothing"
      }
    }

    /// What granting this actually hands over. Shown before the tap that grants it, because these
    /// are financial authorities and "Admin" on its own does not tell anyone what they cost.
    var consequence: String {
      switch self {
      case .admin:
        return "An admin's approval counts toward every payment out of this Circle, and toward changes to how it works — including adding or removing other admins. Becoming an admin has to be approved by the Circle on Monad, so it is not immediate."
      case .spender:
        return "A spender can move money out of the Circle on their own, up to the limit the Circle sets, without anyone approving each payment. Anything above their limit still needs the Circle's approval."
      case .contributor:
        return "They can add their own money to the Circle and suggest payments. Every payment they suggest waits for the Circle's admins to approve it."
      case .viewer:
        return "They can see the balance and everything that moves. They cannot add money or suggest a payment."
      }
    }

    /// True for roles whose authority lives on Monad and therefore cannot be granted by Prism alone.
    var needsCircleApproval: Bool { self == .admin }

    /// The roles an invite sheet may offer. SPENDER appears only where limits actually work — see
    /// `invitableRoles(limitsEnabled:)`.
    static func invitableRoles(limitsEnabled: Bool) -> [Role] {
      limitsEnabled ? [.contributor, .spender, .admin] : [.contributor, .admin]
    }
  }

  // MARK: membership status

  /// How a member's standing reads, and why. The distinction that matters is ACTIVE vs
  /// PENDING_ACTIVATION for an admin: accepted in Prism is not the same as holding authority on
  /// Monad, and collapsing the two would be the single most misleading thing this screen could do.
  static func memberStatus(_ member: CircleMember) -> (text: String, tone: CircleTone, symbol: String) {
    switch member.status {
    case "ACTIVE":
      if Role(wire: member.role) == .admin && member.authorityConfirmedOnChain != true {
        return ("Not yet active", .waiting, "clock.fill")
      }
      return ("Active", .positive, "checkmark.circle.fill")
    case "INVITED":
      return ("Invited", .waiting, "envelope.fill")
    case "PENDING_ACTIVATION":
      return ("Waiting on the Circle", .waiting, "clock.fill")
    case "PENDING_REMOVAL":
      return ("Being removed", .waiting, "person.badge.minus")
    case "LEFT":
      return ("Left", .neutral, "arrow.right.square")
    case "REMOVED":
      return ("Removed", .neutral, "person.badge.minus")
    default:
      return (member.status.replacingOccurrences(of: "_", with: " ").capitalized, .neutral, "circle")
    }
  }

  // MARK: payment lifecycle

  /// One payment's state, as a person would say it. The eleven-state lifecycle is an implementation
  /// detail; what a person needs is whether it has happened, is happening, or is waiting on someone.
  static func paymentStatus(_ lifecycle: String) -> (text: String, tone: CircleTone, symbol: String) {
    switch lifecycle {
    case "CREATED", "RESOLVING", "RESOLVED", "PROPOSED":
      return ("Suggested", .waiting, "clock.fill")
    case "APPROVAL_PENDING":
      return ("Waiting for approval", .waiting, "clock.fill")
    case "APPROVED":
      return ("Ready to send", .positive, "checkmark.circle.fill")
    case "SUBMITTED", "CONFIRMING", "CONFIRMED", "RECONCILED":
      return ("Sending", .waiting, "arrow.up.circle.fill")
    case "COMPLETED":
      return ("Paid", .positive, "checkmark.circle.fill")
    case "EXPIRED":
      return ("Needs suggesting again", .attention, "arrow.counterclockwise")
    case "INVALIDATED":
      return ("No longer valid", .attention, "exclamationmark.triangle.fill")
    case "CANCELLED":
      return ("Cancelled", .neutral, "xmark.circle.fill")
    case "FAILED":
      return ("Didn't go through", .attention, "exclamationmark.triangle.fill")
    default:
      return (lifecycle.replacingOccurrences(of: "_", with: " ").capitalized, .neutral, "circle")
    }
  }

  /// A Circle's own standing, for the list row and the detail header.
  static func circleStatus(_ circle: CircleSummary) -> (text: String, tone: CircleTone, symbol: String)? {
    if circle.isActive { return nil }              // the normal case needs no badge at all
    if circle.hasFailed { return ("Setup failed", .attention, "exclamationmark.triangle.fill") }
    if circle.isClosed { return ("Closed", .neutral, "lock.fill") }
    if circle.isBeingCreated { return ("Setting up", .waiting, "clock.fill") }
    return nil
  }

  // MARK: governance changes

  /// What a governance proposal is, in one line — never "OWNER_ADD".
  static func governanceTitle(_ proposal: CircleGovernanceProposal) -> String {
    if let memo = proposal.memo, !memo.isEmpty { return memo }
    switch proposal.kind {
    case "OWNER_ADD": return "Add an admin"
    case "OWNER_REMOVE": return "Remove an admin"
    case "THRESHOLD_CHANGE":
      guard let threshold = proposal.subject?.threshold else { return "Change how many approvals are needed" }
      return "Require \(threshold) approval\(threshold == 1 ? "" : "s")"
    case "MODULE_ENABLE": return "Turn on spending limits"
    case "SPEND_DELEGATE_ADD": return "Give someone spending access"
    case "SPEND_DELEGATE_REMOVE": return "Remove someone's spending access"
    case "SPEND_LIMIT_SET": return "Set a spending limit"
    case "SPEND_LIMIT_DELETE": return "Clear a spending limit"
    default: return "A change to this Circle"
    }
  }

  /// Setting a limit can need up to three separate approvals, and the honest thing is to say so
  /// rather than let someone think they are finished after the first.
  static func remainingStepsNote(_ proposal: CircleGovernanceProposal) -> String? {
    guard let remaining = proposal.remainingSteps, !remaining.isEmpty else { return nil }
    return remaining.count == 1
      ? "One more approval like this is needed after this one to finish the change."
      : "\(remaining.count) more approvals like this are needed after this one to finish the change."
  }

  // MARK: approval rule

  /// "2 of 3 admins" — the phrase the whole product uses for the approval rule.
  static func approvalRule(threshold: Int?, admins: Int?) -> String {
    guard let threshold else { return "Unknown" }
    guard let admins else { return "\(threshold) approval\(threshold == 1 ? "" : "s")" }
    return "\(threshold) of \(admins) admins"
  }

  /// The consequence of one approval rule, in the creator's own terms. This is the text the
  /// creation flow makes someone read before they authorize the Circle.
  static func approvalRuleConsequence(threshold: Int, admins: Int) -> String {
    if admins == 1 {
      return "You're the only admin, so your approval alone sends every payment."
    }
    if threshold == 1 {
      return "Any one of the \(admins) admins can send a payment on their own, without the others agreeing."
    }
    if threshold == admins {
      return "Every one of the \(admins) admins has to approve every payment. If any of them loses access to their phone and can't recover it, the money can't be moved at all."
    }
    let spare = admins - threshold
    return "\(threshold) of the \(admins) admins have to approve each payment. The Circle still works if \(spare == 1 ? "one admin" : "\(spare) admins") can't be reached."
  }
}

// MARK: - one Circle's activity

/// A single line in a Circle's activity, whatever produced it.
///
/// A Circle's history comes from three separate places — money in, payments the Circle approved,
/// and payments a member made inside their own limit — and a person thinks of them as one list.
/// Merging happens here rather than in a view so the ordering rule and the sign convention are
/// stated once and can be tested.
struct CircleActivityItem: Identifiable, Equatable {
  enum Kind: Equatable { case contribution, payment, spend }

  let id: String
  let kind: Kind
  /// Who or what the line is about: "Tobi added", "Airbnb", "Sarah · Groceries".
  let title: String
  let subtitle: String?
  /// Signed for display: money in is positive, money out negative.
  let amountAtomic: String
  let incoming: Bool
  let status: String
  let tone: CircleTone
  let symbol: String
  let at: Date?
  let transactionHash: String?
  /// Set for a payment still collecting approvals, so the row can be tapped through to it.
  let proposalId: String?

  var signedAmount: String {
    (incoming ? "+" : "−") + Money.assetAmount(fromAtomic: amountAtomic)
  }
}

extension CircleActivityItem {
  /// Build one Circle's feed. Newest first; anything without a usable timestamp sorts last rather
  /// than being dropped, because a line with an unknown time is still a line that happened.
  static func feed(
    contributions: [CircleContribution],
    payments: [CirclePayment],
    spends: [CircleSpend],
    memberName: @escaping (String?) -> String
  ) -> [CircleActivityItem] {
    var items: [CircleActivityItem] = []

    for c in contributions {
      let status = contributionStatus(c)
      items.append(.init(
        id: "contribution:\(c.contributionId)",
        kind: .contribution,
        title: "\(memberName(c.contributorPrismId)) added",
        subtitle: c.isFailed ? c.failureReason : nil,
        amountAtomic: c.amount,
        incoming: true,
        status: status.text, tone: status.tone, symbol: status.symbol,
        at: c.completedAt.flatMap(Date.prismParse) ?? c.createdAt.flatMap(Date.prismParse),
        transactionHash: c.transactionHash,
        proposalId: nil))
    }

    for p in payments {
      let status = CircleVocabulary.paymentStatus(p.lifecycle)
      let label = p.memo?.isEmpty == false ? p.memo! : p.recipientLabel
      items.append(.init(
        id: "payment:\(p.proposalId)",
        kind: .payment,
        title: label,
        subtitle: p.memo?.isEmpty == false ? "to \(p.recipientLabel)" : nil,
        amountAtomic: p.amount ?? "0",
        incoming: false,
        status: status.text, tone: status.tone, symbol: status.symbol,
        at: p.executedAt.flatMap(Date.prismParse) ?? p.createdAt.flatMap(Date.prismParse),
        transactionHash: p.executionTxHash,
        // Only a payment that is still open is worth opening; a settled one is a receipt.
        proposalId: p.isComplete || p.isDead ? nil : p.proposalId))
    }

    for s in spends {
      let status = spendStatus(s)
      let who = memberName(s.spenderPrismId)
      let what = s.memo?.isEmpty == false ? s.memo! : (s.recipientDisplayName ?? s.recipientHandle ?? "a payment")
      items.append(.init(
        id: "spend:\(s.spendId)",
        kind: .spend,
        title: "\(who) · \(what)",
        subtitle: s.isFailed ? s.failureReason : nil,
        amountAtomic: s.amount,
        incoming: false,
        status: status.text, tone: status.tone, symbol: status.symbol,
        at: s.completedAt.flatMap(Date.prismParse) ?? s.createdAt.flatMap(Date.prismParse),
        transactionHash: s.transactionHash,
        proposalId: nil))
    }

    return items.sorted { lhs, rhs in
      switch (lhs.at, rhs.at) {
      case let (l?, r?): return l > r
      case (nil, _?): return false      // unknown time sorts after a known one
      case (_?, nil): return true
      case (nil, nil): return lhs.id < rhs.id
      }
    }
  }

  private static func contributionStatus(_ c: CircleContribution) -> (text: String, tone: CircleTone, symbol: String) {
    switch c.status {
    case "COMPLETED": return ("Added", .positive, "checkmark.circle.fill")
    case "FAILED": return ("Didn't go through", .attention, "exclamationmark.triangle.fill")
    default: return ("Adding", .waiting, "clock.fill")
    }
  }

  private static func spendStatus(_ s: CircleSpend) -> (text: String, tone: CircleTone, symbol: String) {
    switch s.status {
    case "COMPLETED": return ("Paid", .positive, "checkmark.circle.fill")
    case "FAILED": return ("Didn't go through", .attention, "exclamationmark.triangle.fill")
    default: return ("Sending", .waiting, "arrow.up.circle.fill")
    }
  }
}
