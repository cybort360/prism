import Foundation

/// Wire models for Prism Circles — shared USDC accounts governed by a Safe Smart Account on Monad.
///
/// Everything here is *untrusted backend input*. The Circle's balance, its admin set and its
/// threshold are chain-owned facts that the backend reads live and may report as unavailable; the
/// phone renders "unknown" rather than inventing a number, which is why `CircleBalance` and
/// `CircleAuthority` are both nullable and both carry an `unavailable` flag.
///
/// The payment models below feed `CircleApprovalPayload`, which the device re-derives and validates
/// before Face ID is ever presented. Nothing in this file is trusted for signing.

// MARK: - the Circle

struct CircleSummary: Codable, Identifiable, Equatable {
  var id: String { circleId }
  let circleId: String
  let name: String
  let icon: String?
  let safeAddress: String?
  let chainId: String
  let asset: String
  let status: String
  let myRole: String?
  let myStatus: String?
  /// True only when Prism holds a chain-verification receipt for this Circle. An ACTIVE Circle
  /// without one is never reported as verified.
  let verifiedOnChain: Bool?
  /// What the creator *asked for*, which is not the same thing as what Monad says is true. Present
  /// while a Circle is still being created, when there is no on-chain threshold to show yet.
  let requested: CircleRequestedShape?
  /// Why creation stopped, when it did. Never invented — it is the mismatch list from verification.
  let failureReason: String?

  var isActive: Bool { status == "ACTIVE" }
  /// Still working its way onto Monad: deployed or deploying, but not yet verified.
  var isBeingCreated: Bool {
    ["CREATED", "MEMBERS_SELECTED", "POLICY_REVIEWED", "AWAITING_AUTHORIZATION", "DEPLOYING", "CONFIRMING", "RECONCILING"].contains(status)
  }
  var hasFailed: Bool { status == "VERIFICATION_FAILED" }
  var isClosed: Bool { status == "CLOSED" }
}

struct CircleRequestedShape: Codable, Equatable {
  let threshold: Int?
  let adminCount: Int?
}

struct CircleBalance: Codable, Equatable {
  let amountAtomic: String?
  let decimals: Int?
  let symbol: String?
  let unavailable: Bool?
  let reason: String?

  var isKnown: Bool { unavailable != true && amountAtomic != nil }
}

struct CircleAuthority: Codable, Equatable {
  let threshold: Int?
  let adminCount: Int?
  let nonce: Int?
  let spare: Int?
  let unavailable: Bool?
  let reason: String?

  var isKnown: Bool { unavailable != true && threshold != nil }
}

struct CircleMember: Codable, Identifiable, Equatable, Hashable {
  var id: String { prismId }
  let prismId: String
  let displayName: String?
  let handle: String?
  let role: String
  let status: String
  /// Nil for non-admins. False means "accepted in Prism, not yet an owner on Monad" — a distinction
  /// the UI must keep, because only the owner set confers authority.
  let authorityConfirmedOnChain: Bool?
  /// The account that signs for this member. Shown nowhere; used to tell whether an approval on a
  /// proposal is *this* person's, which is a question only the signing address can answer.
  let authorityAddress: String?
  let joinedAt: String?
}

struct CircleDetail: Codable, Equatable {
  let circleId: String
  let name: String
  let icon: String?
  let safeAddress: String?
  let chainId: String
  let status: String
  let verifiedOnChain: Bool?
  let authority: CircleAuthority?
  let balance: CircleBalance?
  let members: [CircleMember]?
}

struct CirclesResponse: Codable { let circles: [CircleSummary] }

// MARK: - activity (one feed: money and governance, kept distinguishable)

/// One row of a Circle's activity, as the backend projects it.
///
/// Two things are worth knowing about this type. First, a financial row is a *view of a reconciled
/// record* — a contribution's settled payment, a Safe execution and its USDC Transfer, an allowance
/// transfer — never a ledger entry Prism keeps. Second, a governance row carries no money fields at
/// all (`amountAtomic` and `direction` are nil), so a limit change can never be summed into a
/// balance or rendered with a payment's vocabulary.
struct CircleActivityWireItem: Codable, Equatable {
  let id: String
  /// "financial" or "governance". Sent as `class`, which is a Swift keyword, so it is mapped.
  let eventClass: String
  let type: String
  let occurredAt: String?
  let title: String
  var subtitle: String? = nil
  var detail: String? = nil
  /// "in", "out", or nil for a governance event.
  var direction: String? = nil
  var amountAtomic: String? = nil
  var amountDisplay: String? = nil
  var signedAmountDisplay: String? = nil
  var asset: String? = nil
  var status: String? = nil
  var settled: Bool? = nil
  var actor: CircleActivityParty? = nil
  var subject: CircleActivityParty? = nil
  var counterparty: CircleActivityParty? = nil
  /// The canonical payment id this row is a view of — what opens the receipt. Nil on governance.
  var paymentId: String? = nil
  var operationId: String? = nil
  var transactionHash: String? = nil
  var proposalId: String? = nil
  var approvalRule: String? = nil
  /// Where the evidence for this row came from ("safe execution + USDC Transfer", …).
  var evidenceSource: String? = nil

  enum CodingKeys: String, CodingKey {
    case id, type, occurredAt, title, subtitle, detail, direction, amountAtomic, amountDisplay
    case signedAmountDisplay, asset, status, settled, actor, subject, counterparty
    case paymentId, operationId, transactionHash, proposalId, approvalRule, evidenceSource
    case eventClass = "class"
  }
}

struct CircleActivityParty: Codable, Equatable {
  let prismId: String?
  let displayName: String
  var handle: String? = nil
}

struct CircleActivityResponse: Codable {
  let circleId: String
  var circleName: String? = nil
  let activity: [CircleActivityWireItem]
  /// Always "reconciled" — stated by the backend so no client has to assume it.
  var source: String? = nil
}

// MARK: - closing

/// What stands between a Circle and being closed, each checked against live state.
struct CircleCloseState: Codable, Equatable {
  let circleId: String
  let status: String
  let canClose: Bool
  var alreadyClosed: Bool? = nil
  var requirements: [String] = []
  var checks: [CircleCloseCheck] = []
  var blockers: [CircleCloseBlocker] = []
  var balance: CircleBalance? = nil
  var closing: CircleClosingRecord? = nil
  /// Closing ends a Circle's life, never its record.
  var historyRetained: Bool? = nil

  var fundsBlocker: CircleCloseBlocker? { blockers.first { $0.code == "REMAINING_FUNDS" } }
}

struct CircleCloseCheck: Codable, Equatable {
  let code: String
  let ok: Bool
  var count: Int? = nil
  var balanceAtomic: String? = nil
  var source: String? = nil
}

struct CircleCloseBlocker: Codable, Equatable, Identifiable {
  var id: String { code }
  let code: String
  let title: String
  let detail: String
  var balanceAtomic: String? = nil
  var balanceDisplay: String? = nil
  /// True only for the remaining-balance blocker: the one thing the members must decide themselves.
  var requiresExplicitDecision: Bool? = nil
}

struct CircleClosingRecord: Codable, Equatable {
  var startedAt: String? = nil
  var startedByPrismId: String? = nil
  var reason: String? = nil
  var cancelledAt: String? = nil
  var finalizedAt: String? = nil
  var finalizedByPrismId: String? = nil
}

// MARK: - contributions (money in)

struct CircleBalanceDelta: Codable, Equatable {
  let before: String?
  let after: String?
  let delta: String?
}

struct CircleContribution: Codable, Identifiable, Equatable {
  var id: String { contributionId }
  let contributionId: String
  let circleId: String
  let circleName: String?
  let contributorPrismId: String
  let amount: String
  let asset: String
  /// PREPARED · SUBMITTED · CONFIRMING · COMPLETED · FAILED. COMPLETED is only ever written from an
  /// on-chain receipt, so the UI may treat it — and only it — as money that has arrived.
  let status: String
  let operationId: String
  let transactionHash: String?
  let failureReason: String?
  let balance: CircleBalanceDelta?
  let createdAt: String?
  let completedAt: String?

  var isComplete: Bool { status == "COMPLETED" }
  var isFailed: Bool { status == "FAILED" }
}

/// The signable envelope for adding money, plus the contribution it belongs to. Identical in shape
/// to a personal payment's prepare response, because that is exactly what it is.
struct PreparedContribution: Codable {
  let paymentId: String
  let asset: TokenConfig?
  let typedData: TypedDataPair
  let expiresAt: String
  let contribution: CircleContribution
  let circle: PreparedContributionCircle
}

struct PreparedContributionCircle: Codable, Equatable {
  let circleId: String
  let name: String
  let icon: String?
  let safeAddress: String
}

struct CircleContributionsResponse: Codable { let circleId: String; let contributions: [CircleContribution] }
struct CircleContributionStatus: Codable { let contribution: CircleContribution }

// MARK: - payments (money out, under the threshold)

/// The exact ten fields that were hashed. The phone rebuilds the digest from these rather than
/// trusting `safeTxHash`, so every one of them matters — see `CircleApprovalValidator`.
struct CircleSafeTransaction: Codable, Equatable {
  let to: String
  let value: String
  let data: String
  let operation: Int
  let safeTxGas: String
  let baseGas: String
  let gasPrice: String
  let gasToken: String
  let refundReceiver: String
  let nonce: String
}

struct CircleApprovalRecord: Codable, Equatable {
  let authorityAddress: String
  let signatureType: String
  let prismId: String?
}

struct CircleBindingReport: Codable, Equatable {
  let ok: Bool
  let reasons: [String]?
}

struct CircleTransferEvidence: Codable, Equatable {
  let from: String
  let to: String
  let amountAtomic: String
  let token: String
}

struct CirclePaymentEvidence: Codable, Equatable {
  let transactionHash: String?
  let blockNumber: String?
  let safeExecutionSuccess: Bool?
  let transfer: CircleTransferEvidence?
}

struct CircleSimulation: Codable, Equatable {
  let ok: Bool
  let reason: String?
}

struct CircleLifecycleStep: Codable, Equatable {
  let state: String
  let at: String?
}

/// A threshold-governed Circle payment.
///
/// `lifecycle` is the *effective* state, recomputed by the backend on every read from signatures
/// verified against the live Safe owner set — so a payment can go from APPROVED back to
/// APPROVAL_PENDING when an admin is removed on-chain. `storedLifecycle` is what the backend's own
/// row says; when the two disagree the effective one is the honest answer, and the UI shows it.
struct CirclePayment: Codable, Identifiable, Equatable {
  var id: String { proposalId }
  let proposalId: String
  let circleId: String
  let circleName: String?
  let lifecycle: String
  let storedLifecycle: String?
  let proposerPrismId: String?
  let recipientPrismId: String?
  let recipientAccount: String?
  let recipientDisplayName: String?
  let recipientHandle: String?
  let amount: String?
  let asset: String?
  let memo: String?

  let safeAddress: String?
  let chainId: String?
  let token: String?
  let safeTxHash: String?
  let safeNonce: String?
  let safeTransaction: CircleSafeTransaction?

  let requiredApprovals: Int?
  let collectedApprovals: Int?
  let approvals: [CircleApprovalRecord]?
  let binding: CircleBindingReport?

  let executionTxHash: String?
  let evidence: CirclePaymentEvidence?
  let failureReason: String?
  let lastSimulation: CircleSimulation?
  let balance: CircleBalanceDelta?
  let trace: [CircleLifecycleStep]?
  let createdAt: String?
  let executedAt: String?
  let expiresAt: String?

  /// Non-nil when the backend declined to send: not enough approvals, an earlier transaction must
  /// land first, or a simulation that would have failed.
  let blocked: String?
  /// Present on a freshly proposed payment: whether the Circle currently holds enough. Advisory —
  /// a Circle can be topped up while approvals are collected, and simulation is the real gate.
  let sufficientBalance: Bool?

  var isComplete: Bool { lifecycle == "COMPLETED" }
  var isAwaitingApproval: Bool { lifecycle == "APPROVAL_PENDING" }
  var isReadyToSend: Bool { lifecycle == "APPROVED" }
  var isDead: Bool { ["INVALIDATED", "EXPIRED", "CANCELLED", "FAILED"].contains(lifecycle) }

  /// "1 of 2" — the sentence the approval sheet leads with.
  var approvalProgress: String? {
    guard let required = requiredApprovals else { return nil }
    guard let collected = collectedApprovals else { return "approvals unknown" }
    return "\(collected) of \(required)"
  }

  /// A person-shaped name for the recipient, never a raw address.
  var recipientLabel: String {
    recipientDisplayName ?? recipientHandle ?? "this recipient"
  }
}

struct CirclePaymentsResponse: Codable { let circleId: String; let payments: [CirclePayment] }

// MARK: - member withdrawals (money OUT of a Circle, capped by a member's own net contribution)

/// What `memberPrismId` may withdraw right now: their own COMPLETED contributions minus their own
/// COMPLETED withdrawals, never negative, capped by what the Safe actually holds on Monad. This is
/// the ONLY ceiling a withdrawal screen may use — never a number computed on the phone.
struct CircleWithdrawableResponse: Codable, Equatable {
  let circleId: String
  let memberPrismId: String
  let netContributedAtomic: String
  let balanceAtomic: String
  let withdrawableAtomic: String
}

/// A withdrawal is an ordinary threshold PAYMENT proposal to the withdrawing member's own account —
/// this IS a `CirclePayment`, plus the internal withdrawal record's id. Proposing signs nothing: the
/// Circle's normal approvals still gate whether it ever executes.
struct CircleWithdrawalProposalResponse: Codable { let proposal: CirclePayment; let withdrawalId: String }

/// One member's share of a Circle close, as `planClosePayouts` would pay it out right now.
struct CircleClosePayout: Codable, Equatable, Identifiable {
  var id: String { prismId }
  let prismId: String
  let account: String?
  let amountAtomic: String
}

/// The pro-rata preview of a Circle close: each member's net contribution split across the Safe's
/// live balance. A preview only — nothing here has been proposed yet.
struct CircleClosePlan: Codable, Equatable { let balanceAtomic: String; let payouts: [CircleClosePayout] }

/// What turning a `CircleClosePlan` into real proposals produced: one withdrawal-tagged PAYMENT
/// proposal per member with a positive payout, each still needing the Circle's own approvals.
struct CircleClosePayoutsResult: Codable { let proposals: [CircleWithdrawalProposalResponse] }

struct CircleApprovalResult: Codable { let proposalId: String; let approvedBy: String?; let signatureType: String?; let payment: CirclePayment }

// MARK: - presentation

/// A recipient resolved for a Circle payment. Carries the Circle so the review screen can say
/// "Paid from Lagos Trip" without inferring it, and the resolution so the proposal is built from
/// the resolver's signed attestation rather than from an address the UI happened to hold.
struct CirclePayTarget: Identifiable, Equatable {
  let id = UUID()
  let circleId: String
  let circleName: String
  let contact: ContactPerson
  let resolution: ResolutionResponse
}

/// An approval an admin has been asked for. The `circle` is this device's own record of the Circle,
/// and it is what the payment is validated against — taking both halves from the same response
/// would make the check circular.
struct CircleApprovalPresentation: Identifiable, Equatable {
  let id = UUID()
  let payment: CirclePayment
  let circle: CircleDetail
}

// MARK: - member spending limits

/// Whether limits are available on this deployment at all.
///
/// They are off unless a verified Safe Allowance Module v1.0.0 exists on the target chain, and
/// `reason` says why when they are not. The UI must render that as an ordinary state rather than an
/// error: a Circle without limits is a perfectly good Circle, it just spends by threshold.
struct CircleLimitsStatus: Codable, Equatable {
  let enabled: Bool
  let reason: String?
  let module: CircleLimitsModule?
  let asset: String?
}

struct CircleLimitsModule: Codable, Equatable {
  let address: String
  let version: String
  let codeHash: String
}

/// One member's limit, as the module reports it.
///
/// Every figure here came from `AllowanceModule.getTokenAllowance` on the read that produced it —
/// none of it is derived from Prism's activity, which would drift on a period rollover or on a
/// transfer Prism did not originate. `source` is always `"chain"`, and the UI says so.
struct CircleSpendingLimit: Codable, Identifiable, Equatable {
  var id: String { prismId }
  let prismId: String
  let displayName: String?
  let handle: String?
  let authorityAddress: String?
  let hasSpendingAccess: Bool
  /// "No spending access", or "$100.00 per day" — the one line a list row shows.
  let summary: String

  let period: String?
  let periodLabel: String?
  let limitAtomic: String?
  let spentAtomic: String?
  let availableAtomic: String?
  let limitDisplay: String?
  let spentDisplay: String?
  let availableDisplay: String?
  let resetsAt: String?
  let nonce: Int?
  let asset: String?
  let token: String?
  let source: String?

  /// How much of the window is used, 0...1. Nil when there is no limit to be a fraction of.
  var usedFraction: Double? {
    guard let limit = limitAtomic.flatMap(Double.init), limit > 0,
      let spent = spentAtomic.flatMap(Double.init)
    else { return nil }
    return min(1, max(0, spent / limit))
  }
}

struct CircleLimitsResponse: Codable {
  let circleId: String
  let limitsEnabled: Bool
  let reason: String?
  let unavailable: String?
  let module: CircleLimitsModule?
  let limits: [CircleSpendingLimit]
}

struct CircleMyLimitResponse: Codable {
  let circleId: String
  let limitsEnabled: Bool
  let reason: String?
  let limit: CircleSpendingLimit?
}

/// How a member's intended payment can actually happen, decided from live chain state.
///
/// `ALLOWANCE` — they authorize it alone, within a limit the Circle already agreed.
/// `THRESHOLD` — it needs the Circle. Over a limit, without one, or with limits off entirely.
///
/// Over the limit is not an error state. `reason` and `prompt` are the sentence and the question the
/// sheet shows, and the route that remains open is the whole point of asking.
struct CirclePaymentPreview: Codable, Equatable, Identifiable {
  /// Presenting this as a sheet needs an identity; the decision is identified by what it is a
  /// decision about, so a new amount is a new sheet rather than a stale one.
  var id: String { "\(circleId):\(amountAtomic):\(route)" }
  let circleId: String
  let amountAtomic: String
  let route: String
  let requiresApproval: Bool
  let overLimit: Bool?
  let reason: String?
  let prompt: String?
  let shortfallAtomic: String?
  let requiredApprovals: Int?
  let limit: CircleSpendingLimit?

  var isWithinLimit: Bool { route == "ALLOWANCE" }
  var isOverLimit: Bool { overLimit == true }
}

/// A spend prepared for the member to sign, with the digest the device must re-derive for itself.
struct PreparedCircleSpend: Codable {
  let spend: CircleSpend
  let transferHash: String
  let limit: CircleSpendingLimit?
}

struct CircleSpend: Codable, Identifiable, Equatable {
  var id: String { spendId }
  let spendId: String
  let circleId: String
  let spenderPrismId: String
  let recipientPrismId: String?
  let recipientAccount: String?
  let recipientDisplayName: String?
  let recipientHandle: String?
  let amount: String
  let amountDisplay: String?
  let asset: String?
  let memo: String?
  let route: String?
  /// PREPARED · SUBMITTED · CONFIRMING · COMPLETED · FAILED. COMPLETED needs a USDC Transfer from
  /// the Circle to the reviewed recipient for the exact amount — nothing is rounded up to it.
  let status: String
  let transactionHash: String?
  let evidence: CirclePaymentEvidence?
  let failureReason: String?
  let allowanceNonce: Int?
  /// The limit as it stood when this was signed, and as it stands after — so a receipt can show
  /// "$58 left" without recomputing anything.
  let limitAtSigning: CircleSpendLimitSnapshot?
  let limitAfter: CircleSpendLimitSnapshot?
  let createdAt: String?
  let completedAt: String?

  var isComplete: Bool { status == "COMPLETED" }
  var isFailed: Bool { status == "FAILED" }
}

struct CircleSpendLimitSnapshot: Codable, Equatable {
  let amountAtomic: String?
  let spentAtomic: String?
  let availableAtomic: String?
  let period: String?
}

struct CircleSpendStatusResponse: Codable { let spend: CircleSpend }

// MARK: - creation

/// What the creation sheet is allowed to recommend.
///
/// The recommendation is a UX default and the wire format says so: `recommendedThreshold` is
/// nullable (CUSTOM makes no recommendation), every valid choice is listed with its own
/// consequences, and `twoPersonTradeoff` exists because a two-admin Circle has no safe default —
/// 1-of-2 lets either person move money alone, 2-of-2 freezes the money if either phone is lost.
/// The UI shows both consequences rather than dressing one up as safe.
struct CircleTemplateGuidance: Codable, Equatable {
  let template: String
  let label: String
  let blurb: String
  let adminCount: Int
  let recommendedThreshold: Int?
  let twoPersonTradeoff: CircleTwoPersonTradeoff?
  let choices: [CircleThresholdChoice]
}

struct CircleTwoPersonTradeoff: Codable, Equatable {
  let oneOfTwo: [CircleThresholdWarning]
  let twoOfTwo: [CircleThresholdWarning]
}

struct CircleThresholdChoice: Codable, Equatable, Identifiable {
  var id: Int { threshold }
  let threshold: Int
  let label: String
  let recommended: Bool
  let warnings: [CircleThresholdWarning]
}

/// A consequence the creator has to see — and, when it applies to the shape they chose, acknowledge
/// by code before the Circle is created. `code` is what gets acknowledged; the two strings are what
/// a person reads.
struct CircleThresholdWarning: Codable, Equatable, Identifiable {
  var id: String { code }
  let code: String
  let title: String
  let detail: String
}

/// The creator's explicit confirmation of the approval rule, sent with the create request.
///
/// It carries the shape it is confirming, so an acknowledgement cannot be replayed against a
/// different Circle: the backend re-derives the warnings for the threshold and admin count it was
/// actually given and refuses if any of them is unacknowledged.
struct CirclePolicyAcknowledgement: Encodable, Equatable {
  let threshold: Int
  let adminCount: Int
  let acknowledgedWarnings: [String]
}

// MARK: - governance (changes that are not payments)

/// A Circle change that moves no money: adding or removing an admin, changing the approval rule, or
/// setting a member's spending limit.
///
/// It shares the Safe transaction and the approval mechanics with a payment and almost nothing
/// else, which is why it is a separate type rather than a payment with empty recipient fields. Note
/// that `lifecycle` and `status` are both optional and both real: a freshly prepared proposal
/// reports `status` (PENDING · READY · EXPIRED), while one that has been executed reports the same
/// `lifecycle` vocabulary a payment does.
struct CircleGovernanceProposal: Codable, Identifiable, Equatable {
  var id: String { proposalId }
  let proposalId: String
  let circleId: String
  let circleName: String?
  let kind: String
  let isSpendingLimitChange: Bool?

  let lifecycle: String?
  let storedLifecycle: String?
  let status: String?
  /// Built against a Safe transaction number the Circle has already used, so it can never execute
  /// however many approvals it collects. It has to be proposed again.
  let staleNonce: Bool?

  let proposerPrismId: String?
  let memo: String?
  let subject: CircleProposalSubject?

  let safeAddress: String?
  let safeTxHash: String?
  let safeNonce: String?
  let safeTransaction: CircleSafeTransaction?

  let requiredApprovals: Int?
  let collectedApprovals: Int?
  let approvals: [CircleApprovalRecord]?

  let executionTxHash: String?
  let evidence: CirclePaymentEvidence?
  let failureReason: String?
  let lastSimulation: CircleSimulation?
  let blocked: String?

  let createdAt: String?
  let executedAt: String?
  let expiresAt: String?

  /// A spending limit can need up to three Safe transactions (enable the module, register the
  /// member, set the amount) and they cannot be batched. These are the ones still to come after
  /// this proposal executes — the UI counts them so it never says "done" halfway through.
  let remainingSteps: [String]?
  /// True when there was nothing left to change: the limit already is what the Circle approved.
  let complete: Bool?

  /// The effective state, preferring the executed lifecycle over the prepared status.
  var state: String { lifecycle ?? status ?? "PENDING" }
  var isComplete: Bool { lifecycle == "COMPLETED" }
  var isReadyToApply: Bool { lifecycle == "APPROVED" || status == "READY" }
  var isDead: Bool {
    staleNonce == true || ["INVALIDATED", "EXPIRED", "CANCELLED", "FAILED"].contains(state)
  }

  /// "1 of 2" — the same sentence a payment leads with, and unknown when the chain could not be read.
  var approvalProgress: String? {
    guard let required = requiredApprovals else { return nil }
    guard let collected = collectedApprovals else { return nil }
    return "\(collected) of \(required)"
  }
}

/// Who or what a governance change is about. Every field is optional because each kind of change
/// fills in a different subset — an approval-rule change has a threshold and no person, a spending
/// limit has both.
struct CircleProposalSubject: Codable, Equatable {
  let prismId: String?
  let authorityAddress: String?
  let threshold: Int?
  let ownerCountAfter: Int?
  let amount: String?
  let period: String?
  let step: String?
}

/// One row of a Circle's approval inbox.
///
/// The inbox holds two genuinely different things, so this decodes the union rather than forcing
/// one shape onto the other: a payment view carries a lifecycle and no `kind`, a governance view
/// carries a `kind`. Getting this wrong is not a cosmetic problem — a governance proposal decoded
/// as a payment would show an empty recipient and a blank amount next to an Approve button.
struct CirclePendingItem: Identifiable, Equatable {
  let payment: CirclePayment?
  let governance: CircleGovernanceProposal?

  /// Both halves always carry a proposal id, so the fallback is unreachable — but it is a constant
  /// rather than a fresh UUID, because an id that changes on every read would make `ForEach` rebuild
  /// the row and lose its state.
  var id: String { payment?.proposalId ?? governance?.proposalId ?? "unknown" }
}

extension CirclePendingItem: Decodable {
  private enum ProbeKey: String, CodingKey { case kind }

  init(from decoder: Decoder) throws {
    let probe = try decoder.container(keyedBy: ProbeKey.self)
    if let kind = try probe.decodeIfPresent(String.self, forKey: .kind), kind != "PAYMENT" {
      governance = try CircleGovernanceProposal(from: decoder)
      payment = nil
    } else {
      payment = try CirclePayment(from: decoder)
      governance = nil
    }
  }
}

/// Decodable, not Codable: `CirclePendingItem` decodes a union of two different proposal shapes and
/// has no encoded form to round-trip back to. (Found by `swiftc -typecheck`: declaring it Codable
/// asked the compiler for an Encodable conformance that cannot exist.)
struct CirclePendingInboxResponse: Decodable {
  let circleId: String
  let pending: [CirclePendingItem]
  let authority: CircleAuthority?
  /// Set when the Circle is not yet on Monad, or when Monad could not be read — in which case the
  /// honest answer is that pending approvals are unknown, not that there are none.
  let note: String?
  let unavailable: String?
}

// MARK: - membership

struct CircleMembersResponse: Codable { let members: [CircleMember] }

/// An invitation addressed to this person. Carries who is asking, because that — not the role name
/// — is what makes an invitation something a person can reasonably judge.
struct CircleInvitation: Codable, Identifiable, Equatable {
  var id: String { inviteId }
  let inviteId: String
  let circleId: String
  let circleName: String?
  let icon: String?
  let role: String
  let invitedBy: String?
  let expiresAt: String?
  let createdAt: String?
}

struct CircleInvitationsResponse: Codable { let invitations: [CircleInvitation] }

struct CircleInviteResult: Codable, Equatable {
  let inviteId: String
  let circleId: String
  let role: String
  let status: String
  let expiresAt: String?
}

/// The result of accepting. `authorityConfirmedOnChain` is the whole point: accepting an admin
/// invitation makes someone a member immediately and an admin not at all — that waits on the Circle
/// approving it on Monad, and `note` is the sentence that says so.
struct CircleInvitationAcceptance: Codable, Equatable {
  let circleId: String
  let role: String
  let status: String
  let authorityConfirmedOnChain: Bool?
  let note: String?
}

struct CircleMemberRoleResult: Codable, Equatable {
  let circleId: String
  let prismId: String
  let role: String
  let unchanged: Bool?
}

struct CircleMemberRemovalResult: Codable, Equatable {
  let circleId: String
  let prismId: String
  let status: String
  let alreadyRemoved: Bool?
}

struct CircleSpendsResponse: Codable { let circleId: String; let spends: [CircleSpend] }

/// The result of approving a Circle change. `governance` is the change as it now stands, with its
/// approval count recomputed from signatures against the live admin set.
struct CircleGovernanceApprovalResult: Codable {
  let proposalId: String
  let approvedBy: String?
  let signatureType: String?
  let governance: CircleGovernanceProposal
}
