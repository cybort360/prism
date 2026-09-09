import Foundation

typealias RuntimeConfig = PrismNetworkConfig

enum MainTab: String, CaseIterable, Identifiable {
  case home, people, activity, profile
  var id: String { rawValue }
  var title: String { rawValue.capitalized }
  var icon: String {
    switch self {
    case .home: "house"
    case .people: "person.2"
    case .activity: "chart.bar.xaxis"
    case .profile: "person.circle"
    }
  }
}

struct PrismIdentity: Codable, Equatable {
  let prismId: String
  var displayName: String? = nil
  var handle: String?
  var accountAddress: String?
  var aliasVersion: Int
  /// The Mera passkey-derived EVM account address holds supported Prism assets.
  var account: String? = nil
  var phoneMasked: String? = nil
  var hasVerifiedPhone: Bool? = nil
  var phoneDiscoverable: Bool? = nil
  var handleSearchable: Bool? = nil
}

struct AuthResponse: Codable {
  let session: String
  let identity: PrismIdentity
}
/// A single-use, short-lived challenge the app signs to prove Mera-account control (non-replayable).
struct BindingChallenge: Codable {
  let nonce: String
  var expiresAt: String? = nil
}
struct BalanceResponse: Codable {
  let token: String
  let symbol: String
  let amountAtomic: String
  let decimals: Int
}

struct TokenConfig: Codable, Identifiable, Equatable {
  var id: String { symbol }
  let symbol: String
  let name: String
  let address: String
  let decimals: Int
}

struct PublicServiceKey: Codable, Hashable {
  let qx: String
  let qy: String
  let keyId: String?
}
struct PrismNetworkConfig: Codable {
  let chainId: String
  let usdc: String
  let usdcDecimals: Int
  let asset: TokenConfig
  let paymentRouter: String?
  let claimVault: String?
  let resolverPublicKey: PublicServiceKey?
  let claimAuthorizerAddress: String?
  let relayerAddress: String?
}

struct ResolutionResponse: Codable, Equatable, Hashable {
  let found: Bool
  let reason: String?
  let attestation: ResolutionAttestation?
  let signature: String?
  let resolverKeyId: String?
}
struct ResolutionAttestation: Codable, Equatable, Hashable {
  let recipientAccount: String
  let prismIdentity: String
  let aliasVersion: Int
  let requesterPrismId: String?
  let requestId: String
  let route: String
  let issuedAt: String
  let expiresAt: String
}

struct PreparedIntent: Codable {
  let kind: String
  let senderPrismId: String
  let recipientPrismId: String?
  let recipientAccount: String?
  let amountAtomic: String?
  let token: String?
  let paymentRef: String?
  let requestId: String?
  let memo: String?
  let claimId: String?
}

/// A direct payment prepared by the backend. The Mera account signs BOTH the Prism `envelope`
/// (metadata binding) and the USDC transfer authorization. The router cross-binds them.
struct PreparedPayment: Codable {
  let paymentId: String
  let asset: TokenConfig?
  let typedData: TypedDataPair
  let expiresAt: String
  let state: String
}
struct TypedDataPair: Codable {
  let envelope: JSONValue
  let tokenAuthorization: JSONValue

}

/// A claim funding prepared by the backend. The sender signs the USDC receive authorization.
struct PreparedClaim: Codable {
  let claimId: String
  let asset: TokenConfig?
  let typedData: JSONValue
  let expiresAt: String
  let state: String
}

/// Result of a submit/fund/claim/refund call.
struct OperationResult: Codable {
  let paymentId: String?
  let claimId: String?
  var operationId: String? = nil
  let state: String
  let txHash: String?
  var id: String { paymentId ?? claimId ?? "" }
  /// The canonical operation id for opening PaymentDetailsView (op id for claims, paymentId for direct).
  var canonicalOperationId: String { operationId ?? id }
}

/// Reconciled on-chain status from GET /v1/payments/:id or /v1/claims/:id.
struct OperationStatus: Codable {
  let operationId: String
  let state: String
  let txHash: String?
  let transactionHash: String?
  let blockNumber: String?
}

extension JSONValue {
  /// Re-encode a typed-data payload as JSON bytes for the Mera signing bridge.
  func jsonData() throws -> Data { try JSONEncoder().encode(self) }
}

// MARK: developer/judge proof surface (DEBUG-only UI)

struct PaymentProof: Codable {
  struct Network: Codable { let chainId: String; let rpcHost: String; let provider: String }
  let network: Network
  let token: String
  let tokenSymbol: String
  let meraAccount: String
  let recipient: String
  let amountAtomic: String
  let senderMonBalance: String?
  let senderTokenBalance: String?
  let recipientTokenBefore: String?
  let recipientTokenAfter: String?
  let paymentId: String
  let txHash: String?
  let blockNumber: String?
  let state: String
  let submittedAt: String?
  let confirmedAt: String?
  let indexedAt: String?
  let indexed: Bool
  let requestId: String?
}

struct MetricsSnapshot: Codable {
  struct Latency: Codable { let count: Int; let p50: Double?; let p95: Double? }
  struct Op: Codable { let success: Int; let failure: Int; let failureRate: Double }
  struct ChainInfo: Codable { let provider: String; let rpcHost: String }
  struct EnvioInfo: Codable { let available: Bool }
  let chain: ChainInfo
  let envio: EnvioInfo?
  let latencies: [String: Latency]
  let operations: [String: Op]
}

/// Minimal arbitrary-JSON value so the EIP-712 typed data can round-trip untouched through iOS.
enum JSONValue: Codable {
  case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
    else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON") }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let s): try c.encode(s)
    case .number(let n): try c.encode(n)
    case .bool(let b): try c.encode(b)
    case .object(let o): try c.encode(o)
    case .array(let a): try c.encode(a)
    case .null: try c.encodeNil()
    }
  }
}

struct ContactPerson: Identifiable, Hashable {
  let id: String
  let name: String
  let phone: String?
  let initials: String
  var handle: String? = nil
  var prismState: PrismContactState = .unknown
}
enum PrismContactState: Hashable {
  case unknown, resolving
  case onPrism(ResolutionResponse)
  case notOnPrism, unavailable
}

struct SendTarget: Identifiable {
  let id = UUID()
  let contact: ContactPerson
  let resolution: ResolutionResponse
  var requestId: String? = nil
  /// Prefill (decimal dollars) from an amount-bound link/QR. Editable; the payer still approves it —
  /// it never mutates the signed payment, which is built from the amount at authorization time.
  var initialAmount: String? = nil
  var initialMemo: String? = nil
  /// How this recipient was reached, recorded on the canonical payment (contact/qr/paymentLink/…).
  var entryMethod: PrismEntryMethod? = nil
}

struct PaymentRequestRecord: Codable, Identifiable, Equatable {
  var id: String { requestId }
  let requestId: String
  let requesterPrismId: String
  let payerPrismId: String
  let amountAtomic: String
  let token: String
  let tokenSymbol: String?
  let memo: String
  let createdAt: String
  let expiresAt: String
  let status: String
  var signature: String? = nil
  var transactionHash: String? = nil
}
struct RequestDraftResponse: Codable {
  let request: PaymentRequestRecord
  let signable: String
}

struct ClaimRecord: Codable, Identifiable, Equatable {
  var id: String { claimId }
  let claimId: String
  let recipientReference: String?
  let senderPrismId: String
  let amountAtomic: String
  let token: String
  let tokenSymbol: String?
  let memo: String?
  let expiry: Int
  let status: String
  var createdAt: String? = nil
  var fundingTransactionHash: String? = nil
  var claimTransactionHash: String? = nil
  var refundTransactionHash: String? = nil
  var refundAvailable: Bool? = nil
  /// Sender's PUBLIC display (handle/name), for the recipient's "from Octane". Never a phone/address.
  var senderDisplay: String? = nil
  /// Expiry as a Date for consumer copy.
  var expiresAt: Date { Date(timeIntervalSince1970: TimeInterval(expiry)) }
  var isExpired: Bool { expiresAt < Date() }
}
// Device-P256 → PrismP256Account settlement (adoption of the on-chain P-256 path).
struct P256AccountResponse: Codable { let account: String; let deployed: Bool }
struct P256PrepareResponse: Codable {
  let opId: String; let account: String; let token: String
  let amountAtomic: String; let nonce: String; let validBefore: Int; let intentHex: String
}
struct P256OpStatus: Codable { let opId: String; let state: String; let txHash: String? }

struct ClaimEligibility: Codable {
  let claimId: String
  let recipientAccount: String
  let aliasVersion: Int
  let nonce: String
  let deadline: String
  let authorization: String
}

struct ActivityRecord: Codable, Identifiable, Equatable {
  let id: String
  let kind: String
  let counterpartyPrismId: String?
  let counterpartyHandle: String?
  let amountAtomic: String?
  let token: String?
  let tokenSymbol: String?
  let memo: String?
  let status: String
  let createdAt: String
  let transactionHash: String?
  let requestId: String?
  let direction: String?
  let claimId: String?
}

struct ContactTrustRecord: Codable, Equatable {
  let localContactId: String
  let prismId: String
  let accountAddress: String
  let aliasVersion: Int
  let establishedAt: Date
}

enum IdentityChangeAction { case send, request }

struct IdentityChangeCandidate: Identifiable {
  let id = UUID()
  let contact: ContactPerson
  let resolution: ResolutionResponse
  var action: IdentityChangeAction = .send
}

struct ClaimDetailPresentation: Identifiable {
  let id = UUID()
  let claim: ClaimRecord
}

struct RequestDetailPresentation: Identifiable {
  let id = UUID()
  let request: PaymentRequestRecord
}

struct ReceiptPresentation: Identifiable {
  let id = UUID()
  let title: String
  let amount: String
  let subtitle: String
  let transactionHash: String?
  let status: String
  /// Canonical operation id, so the compact success can open the full PaymentDetailsView.
  var operationId: String? = nil
  /// Claim-funded success extras: a human expiry line and a safe share invitation ("Remind …").
  var expiresLine: String? = nil
  var shareMessage: String? = nil
}

extension String {
  var hexData: Data? {
    let clean = replacingOccurrences(of: "0x", with: "")
    guard clean.count.isMultiple(of: 2) else { return nil }
    var data = Data()
    var i = clean.startIndex
    while i < clean.endIndex {
      let j = clean.index(i, offsetBy: 2)
      guard let b = UInt8(clean[i..<j], radix: 16) else { return nil }
      data.append(b)
      i = j
    }
    return data
  }
}
extension Data { var hexString: String { "0x" + map { String(format: "%02x", $0) }.joined() } }

enum Money {
  static func dollars(fromAtomic value: String, decimals: Int = 6) -> String {
    let n = Decimal(string: value) ?? 0
    var divisor = Decimal(1)
    for _ in 0..<decimals { divisor *= 10 }
    let amount = n / divisor
    // Deterministic dollar formatting for USDC amounts.
    return NSDecimalNumber(decimal: amount).doubleValue.formatted(
      .currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }
  static func assetAmount(fromAtomic value: String, decimals: Int = 6) -> String {
    // Consumer UI shows plain dollars — the settlement token is never surfaced to the user.
    return dollars(fromAtomic: value, decimals: decimals)
  }
  static func atomic(fromDollars text: String, decimals: Int = 6) -> String? {
    let cleaned = text.replacingOccurrences(of: "$", with: "").replacingOccurrences(
      of: ",", with: "")
    // Zero (or negative) is not a payable amount.
    guard let d = Decimal(string: cleaned), d > 0 else { return nil }
    var value = d
    var scale = Decimal(1)
    for _ in 0..<decimals { scale *= 10 }
    value *= scale
    return NSDecimalNumber(decimal: value).stringValue.components(separatedBy: ".").first
  }
}

extension Date {
  static func prismParse(_ value: String) -> Date? { ISO8601DateFormatter().date(from: value) }
}
