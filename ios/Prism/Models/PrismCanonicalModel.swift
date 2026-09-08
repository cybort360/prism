import Foundation

// MARK: - The one canonical payment model beneath every monetary action.
// Mirrors the backend projection at GET /v1/payments/:id/canonical → { payment, events, receipt }.
// The chain stays the source of truth for money; these are representations, not a ledger.

enum PrismPaymentKind: String, Codable {
  case direct, requestPayment, qrPayment, linkPayment, claimFunding, claimSettlement, refund
  /// USDC on Monad routed out to another chain and asset. The Monad leg is an ordinary settlement;
  /// what makes it a different kind is that delivery happens off this chain.
  case crossChainSend

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = PrismPaymentKind(rawValue: raw) ?? .direct
  }
}

enum PrismEntryMethod: String, Codable {
  case contact, phone, handle, qr, paymentLink, request, claim, internalRecovery
  case anyChain

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = PrismEntryMethod(rawValue: raw) ?? .contact
  }
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

/// Where a cross-chain send is actually going. Nil for every other kind.
///
/// `state` is the ROUTED leg and is deliberately separate from the payment's `lifecycleState`,
/// which describes only the Monad leg. A confirmed Monad transaction is not delivery.
struct PrismRouteSummary: Codable, Equatable {
  let routeId: String
  let state: AuroraRouteState
  let destinationChain: String?
  let destinationChainLabel: String?
  let destinationSymbol: String?
  let destinationAddress: String?
  let minAmountOut: String?
  let destinationDecimals: Int?
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
  /// Present only on a cross-chain send. Optional, so an older backend simply yields nil.
  let route: PrismRouteSummary?

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

#if DEBUG
// Test/preview fixtures — compiled only in DEBUG, never in production. Not real receipts.
extension PrismParty {
  static func fx(_ name: String, handle: String? = nil) -> PrismParty {
    PrismParty(prismIdentityId: "id_\(name)", displayName: name, handle: handle, accountAddress: "0x00")
  }
}
extension PrismLifecycleEvent {
  static func fx(_ state: PrismLifecycleState, _ source: PrismEventSource, _ title: String, _ at: String) -> PrismLifecycleEvent {
    PrismLifecycleEvent(id: UUID().uuidString, paymentId: "fx", state: state, source: source, occurredAt: at, displayTitle: title, displayDetail: nil, evidenceReference: nil)
  }
}
extension PrismRouteSummary {
  static func fx(
    state: AuroraRouteState = .routing,
    chainLabel: String = "Arbitrum",
    symbol: String = "ETH",
    address: String = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    minAmountOut: String? = "19899000000000000"
  ) -> PrismRouteSummary {
    PrismRouteSummary(
      routeId: "route_fx", state: state, destinationChain: "arb", destinationChainLabel: chainLabel,
      destinationSymbol: symbol, destinationAddress: address, minAmountOut: minAmountOut,
      destinationDecimals: 18)
  }
}

extension PrismPayment {
  static func fixture(
    kind: PrismPaymentKind = .direct, direction: PrismPaymentDirection = .sent,
    entryMethod: PrismEntryMethod = .contact, lifecycleState: PrismLifecycleState = .completed,
    amountAtomic: String? = "20000000", memo: String? = "Dinner",
    sender: PrismParty = .fx("You"), recipient: PrismParty = .fx("Tobi Bakare", handle: "@tobi"),
    requestId: String? = nil, claimId: String? = nil, transactionHash: String? = "0x72f5a9b3c1d4e6f70123456789abcdef0123456789abcdef0123456789ab91a",
    blockNumber: String? = "38420119", completedAt: String? = "2026-09-05T02:31:00.000Z", failureCode: String? = nil,
    route: PrismRouteSummary? = nil
  ) -> PrismPayment {
    PrismPayment(
      paymentId: "0xpay", operationId: "0xpay", kind: kind, direction: direction, entryMethod: entryMethod,
      sender: sender, recipient: recipient, amountAtomic: amountAtomic, asset: "USDC", memo: memo,
      requestId: requestId, claimId: claimId, resolutionId: "r1", resolutionVersion: 1,
      lifecycleState: lifecycleState, createdAt: "2026-09-05T02:30:00.000Z", authorizedAt: "2026-09-05T02:30:20.000Z",
      submittedAt: "2026-09-05T02:30:30.000Z", confirmedAt: completedAt, indexedAt: nil, reconciledAt: completedAt,
      completedAt: lifecycleState == .completed ? completedAt : nil, transactionHash: transactionHash,
      blockNumber: blockNumber, gasSponsored: true, failureCode: failureCode, failureMessage: nil, route: route)
  }
  static var fixtureEvents: [PrismLifecycleEvent] {
    [.fx(.created, .app, "Payment created", "2026-09-05T02:30:00.000Z"),
     .fx(.authorized, .userAuthorization, "Authorized on device", "2026-09-05T02:30:20.000Z"),
     .fx(.submitted, .relayer, "Submitted", "2026-09-05T02:30:30.000Z"),
     .fx(.confirmed, .monad, "Confirmed on-chain", "2026-09-05T02:30:55.000Z"),
     .fx(.completed, .backend, "Completed", "2026-09-05T02:31:00.000Z")]
  }
}
#endif

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
