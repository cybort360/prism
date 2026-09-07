import Foundation

// MARK: - The one canonical payment model beneath every monetary action.
// Mirrors the backend projection at GET /v1/payments/:id/canonical → { payment, events, receipt }.
// The chain stays the source of truth for money; these are representations, not a ledger.

enum PrismPaymentKind: String, Codable {
  case direct, requestPayment, qrPayment, linkPayment, claimFunding, claimSettlement, refund
}

enum PrismEntryMethod: String, Codable {
  case contact, phone, handle, qr, paymentLink, request, claim, internalRecovery
}

enum PrismPaymentDirection: String, Codable { case sent, received }

/// Full lifecycle vocabulary. Decoding is lenient — an unrecognized state becomes `.requiresAttention`
/// rather than failing the whole payload.
enum PrismLifecycleState: String, Codable {
  case created, resolving, resolved, awaitingAuthorization, authorized, submitted, processing
  case confirming, confirmed, indexing, indexed, reconciling, reconciled, completed
  case identityChanged, claimWaiting, claimable, expired, refundAvailable, refunding, refunded
  case failedRetryable, failedTerminal, reverted, cancelled, requiresAttention

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = PrismLifecycleState(rawValue: raw) ?? .requiresAttention
  }

  /// A payment is only truly done once the chain confirmed AND effects reconciled.
  var isSettled: Bool { self == .completed }
  var isTerminalFailure: Bool { self == .failedTerminal || self == .reverted || self == .cancelled }
}

enum PrismEventSource: String, Codable {
  case app, resolver, userAuthorization, backend, relayer, monad, alchemy, envio, claimContract, unknown
  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = PrismEventSource(rawValue: raw) ?? .unknown
  }
}

struct PrismParty: Codable, Hashable {
  let prismIdentityId: String?
  let displayName: String
  let handle: String?
  let accountAddress: String?
}

struct PrismLifecycleEvent: Codable, Identifiable, Hashable {
  let id: String
  let paymentId: String
  let state: PrismLifecycleState
  let source: PrismEventSource
  let occurredAt: String
  let displayTitle: String
  let displayDetail: String?
  let evidenceReference: String?
}

struct PrismPayment: Codable, Identifiable, Equatable {
  var id: String { paymentId }
  let paymentId: String
  let operationId: String
  let kind: PrismPaymentKind
  let direction: PrismPaymentDirection
  let entryMethod: PrismEntryMethod
  let sender: PrismParty
  let recipient: PrismParty
  let amountAtomic: String?
  let asset: String
  let memo: String?
  let requestId: String?
  let claimId: String?
  let resolutionId: String?
  let resolutionVersion: Int?
  let lifecycleState: PrismLifecycleState
  let createdAt: String?
  let authorizedAt: String?
  let submittedAt: String?
  let confirmedAt: String?
  let indexedAt: String?
  let reconciledAt: String?
  let completedAt: String?
  let transactionHash: String?
  let blockNumber: String?
  let gasSponsored: Bool?
  let failureCode: String?
  let failureMessage: String?

  /// A receipt must never claim settled merely because it was submitted.
  var isSettled: Bool { lifecycleState.isSettled && completedAt != nil }
  var dollars: String { amountAtomic.map { Money.dollars(fromAtomic: $0) } ?? "$0.00" }
}

/// Durable receipt derived from real settlement state (mirrors the backend receipt).
struct PrismReceipt: Codable, Identifiable, Equatable {
  var id: String { receiptId }
  let receiptId: String
  let paymentId: String
  let operationId: String
  let amountAtomic: String?
  let asset: String
  let memo: String?
  let sender: PrismParty
  let recipient: PrismParty
  let entryMethod: PrismEntryMethod
  let resolutionId: String?
  let resolutionVersion: Int?
  let finalStatus: PrismLifecycleState
  let transactionHash: String?
  let blockNumber: String?
  let gasSponsored: Bool?
  let createdAt: String?
  let settledAt: String?
  let requestId: String?
  let claimId: String?

  var isSettled: Bool { finalStatus.isSettled && settledAt != nil }
  var dollars: String { amountAtomic.map { Money.dollars(fromAtomic: $0) } ?? "$0.00" }
}

/// The full canonical projection returned by GET /v1/payments/:id/canonical.
struct PrismCanonicalPayment: Codable {
  let payment: PrismPayment
  let events: [PrismLifecycleEvent]
  let receipt: PrismReceipt
}

// MARK: - Migration bridges from the legacy models (remove once all call sites are canonical)

extension PrismLifecycleState {
  init(legacyStatus s: String) {
    switch s.uppercased() {
    case "COMPLETED", "PAID": self = .completed
    case "FAILED": self = .failedTerminal
    case "PENDING", "SUBMITTED", "CONFIRMING": self = .confirming
    case "OPEN": self = .claimWaiting
    case "PREPARED", "CREATED": self = .created
    default: self = .requiresAttention
    }
  }
}

extension PrismPaymentKind {
  init(legacyActivityKind k: String, hasRequest: Bool) {
    switch k {
    case "claim-funding": self = .claimFunding
    case "claim-refund": self = .refund
    case "claim-received": self = .claimSettlement
    case "request": self = .requestPayment
    default: self = hasRequest ? .requestPayment : .direct
    }
  }
}

extension PrismPayment {
  /// Best-effort projection of a legacy Activity row into the canonical model. Lossy (Activity omits
  /// full parties/timestamps) — the authoritative canonical payment comes from the backend endpoint.
  init(activity a: ActivityRecord, viewerHandle: String? = nil) {
    let incoming = a.direction == "incoming" || a.kind == "received" || a.kind == "claim-received"
    let counterparty = PrismParty(prismIdentityId: a.counterpartyPrismId, displayName: a.counterpartyHandle ?? "Someone", handle: a.counterpartyHandle, accountAddress: nil)
    let me = PrismParty(prismIdentityId: nil, displayName: "You", handle: viewerHandle, accountAddress: nil)
    let completed = a.status.uppercased() == "COMPLETED"
    self.init(
      paymentId: a.id, operationId: a.id,
      kind: PrismPaymentKind(legacyActivityKind: a.kind, hasRequest: a.requestId != nil),
      direction: incoming ? .received : .sent,
      entryMethod: a.requestId != nil ? .request : (a.claimId != nil ? .claim : .contact),
      sender: incoming ? counterparty : me, recipient: incoming ? me : counterparty,
      amountAtomic: a.amountAtomic, asset: "USDC", memo: a.memo,
      requestId: a.requestId, claimId: a.claimId, resolutionId: nil, resolutionVersion: nil,
      lifecycleState: PrismLifecycleState(legacyStatus: a.status),
      createdAt: a.createdAt, authorizedAt: nil, submittedAt: nil, confirmedAt: nil,
      indexedAt: nil, reconciledAt: nil, completedAt: completed ? a.createdAt : nil,
      transactionHash: a.transactionHash, blockNumber: nil, gasSponsored: true,
      failureCode: a.status.uppercased() == "FAILED" ? "failed" : nil, failureMessage: nil)
  }
}

extension PrismReceipt {
  /// Derive a durable receipt from a canonical payment (lossless — used to replace the ephemeral
  /// ReceiptPresentation once views are migrated). Never marks settled unless the payment is settled.
  init(payment p: PrismPayment) {
    self.init(
      receiptId: "rcpt_\(p.paymentId)", paymentId: p.paymentId, operationId: p.operationId,
      amountAtomic: p.amountAtomic, asset: p.asset, memo: p.memo,
      sender: p.sender, recipient: p.recipient, entryMethod: p.entryMethod,
      resolutionId: p.resolutionId, resolutionVersion: p.resolutionVersion,
      finalStatus: p.lifecycleState, transactionHash: p.transactionHash, blockNumber: p.blockNumber,
      gasSponsored: p.gasSponsored, createdAt: p.createdAt,
      settledAt: p.isSettled ? p.completedAt : nil, requestId: p.requestId, claimId: p.claimId)
  }
}
