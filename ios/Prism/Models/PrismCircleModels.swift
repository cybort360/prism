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

  var isActive: Bool { status == "ACTIVE" }
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

struct CircleMember: Codable, Identifiable, Equatable {
  var id: String { prismId }
  let prismId: String
  let displayName: String?
  let handle: String?
  let role: String
  let status: String
  /// Nil for non-admins. False means "accepted in Prism, not yet an owner on Monad" — a distinction
  /// the UI must keep, because only the owner set confers authority.
  let authorityConfirmedOnChain: Bool?
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
struct CirclePendingResponse: Codable { let circleId: String; let pending: [CirclePayment]; let authority: CircleAuthority? }
struct CircleApprovalResult: Codable { let proposalId: String; let approvedBy: String?; let signatureType: String?; let payment: CirclePayment }

// MARK: - presentation

/// A recipient resolved for a Circle payment. Carries the Circle so the review screen can say
/// "Paid from Lagos Trip" without inferring it, and the resolution so the proposal is built from
/// the resolver's signed attestation rather than from an address the UI happened to hold.
struct CirclePayTarget: Identifiable {
  let id = UUID()
  let circleId: String
  let circleName: String
  let contact: ContactPerson
  let resolution: ResolutionResponse
}

/// An approval an admin has been asked for. The `circle` is this device's own record of the Circle,
/// and it is what the payment is validated against — taking both halves from the same response
/// would make the check circular.
struct CircleApprovalPresentation: Identifiable {
  let id = UUID()
  let payment: CirclePayment
  let circle: CircleDetail
}
