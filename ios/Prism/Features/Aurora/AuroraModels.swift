import Foundation

/// Models for cross-chain routing through Aurora Intents.
///
/// Prism itself stays single-asset: everything a user holds is USDC on Monad. Aurora is what lets
/// value cross in and out of that — any chain in, any chain out — without Prism ever custodying it
/// or asking the user to think about a bridge.

// MARK: - Route state

/// The routed leg's lifecycle, mirroring the backend's Aurora state machine. It is deliberately
/// distinct from `PrismLifecycleState`: the Monad payment and the cross-chain route are two
/// independent machines, and collapsing them would let one imply the other's progress.
/// Decoding is lenient — a state added server-side reads as `.requiresAttention` rather than
/// failing the whole payload.
enum AuroraRouteState: String, Codable, Equatable {
  case awaitingDeposit = "awaiting_deposit"
  case quoted
  case funding
  case funded
  case routing
  case delivered
  case refunding
  case refunded
  case routeFailed = "route_failed"
  case requiresAttention = "requires_attention"
  case expired

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = AuroraRouteState(rawValue: raw) ?? .requiresAttention
  }

  var isTerminal: Bool {
    switch self {
    case .delivered, .refunded, .routeFailed, .expired: true
    default: false
    }
  }

  /// True only when the route actually delivered. Nothing else counts as done.
  var isDelivered: Bool { self == .delivered }
}

// MARK: - Catalogue

struct AuroraAsset: Codable, Identifiable, Equatable {
  let assetId: String
  let symbol: String
  let decimals: Int
  let chain: String
  let chainLabel: String
  let contractAddress: String?
  let priceUsd: Double?
  let priceUpdatedAt: String?

  var id: String { assetId }
}

struct AuroraChain: Codable, Identifiable, Equatable {
  let chain: String
  let label: String
  let evm: Bool
  let known: Bool
  let assets: [AuroraAsset]

  var id: String { chain }
}

/// Why a route cannot settle against the chain this build talks to. Rendered verbatim — the backend
/// owns the wording so it can never drift from the configuration that produced it.
struct AuroraNotice: Codable, Equatable {
  let mode: String
  let headline: String
  let detail: String
}

struct AuroraChainsResponse: Codable, Equatable {
  let mode: String
  let settlementAvailable: Bool
  let notice: AuroraNotice?
  let destinationChain: String
  let chains: [AuroraChain]
}

// MARK: - Deposits (receive from anywhere)

struct AuroraDepositHistoryEntry: Codable, Equatable, Identifiable {
  let state: AuroraRouteState
  let status: String
  let at: String

  var id: String { "\(state.rawValue)-\(at)" }
}

struct AuroraDeposit: Codable, Identifiable, Equatable {
  let depositAddress: String
  let memo: String?
  let depositChain: String
  let depositChainLabel: String
  let sharedAcrossEvmChains: Bool
  let destinationChain: String
  let destinationSymbol: String
  let recipientAccount: String
  let state: AuroraRouteState
  let lastStatus: String?
  let lastCheckedAt: String?
  let createdAt: String
  let history: [AuroraDepositHistoryEntry]
  let settlementAvailable: Bool
  let notice: AuroraNotice?
  /// Present on create: whether Aurora already had this address. Absent when listing.
  let alreadyExists: Bool?
  /// Present on refresh: false when Aurora's status service could not be reached, so the state
  /// shown is the last one we knew rather than a current reading.
  let statusKnown: Bool?

  var id: String { depositAddress }
}

struct AuroraDepositsResponse: Codable, Equatable {
  let mode: String
  let settlementAvailable: Bool
  let notice: AuroraNotice?
  let deposits: [AuroraDeposit]
}

// MARK: - Arrivals

/// USDC that has landed at the user's account on Monad, from the Envio index.
struct AuroraArrival: Codable, Identifiable, Equatable {
  let from: String
  let amountAtomic: String
  let symbol: String
  let txHash: String
  let blockNumber: Int?
  let timestamp: Int?
  let source: String

  var id: String { txHash }
}

struct AuroraArrivalsResponse: Codable, Equatable {
  /// False when the activity index is unavailable. That means "we cannot say what arrived", never
  /// "nothing arrived" — the balance still comes from an on-chain read either way.
  let indexed: Bool
  let account: String
  let reason: String?
  let arrivals: [AuroraArrival]
}

#if DEBUG
// Test/preview fixtures — compiled only in DEBUG, never in production. Not real deposit addresses.
extension AuroraDeposit {
  static func fixture(
    depositAddress: String = "0x9f2b41c7d8e30a5b6c1f4907e2d83b5a6c7d8e90",
    memo: String? = nil,
    depositChain: String = "base",
    depositChainLabel: String = "Base",
    sharedAcrossEvmChains: Bool = true,
    state: AuroraRouteState = .awaitingDeposit,
    lastStatus: String? = nil,
    history: [AuroraDepositHistoryEntry] = [],
    settlementAvailable: Bool = false,
    notice: AuroraNotice? = .fixture(),
    alreadyExists: Bool? = nil,
    statusKnown: Bool? = nil
  ) -> AuroraDeposit {
    AuroraDeposit(
      depositAddress: depositAddress, memo: memo, depositChain: depositChain,
      depositChainLabel: depositChainLabel, sharedAcrossEvmChains: sharedAcrossEvmChains,
      destinationChain: "monad", destinationSymbol: "USDC",
      recipientAccount: "0x1111111111111111111111111111111111111111",
      state: state, lastStatus: lastStatus, lastCheckedAt: "2026-09-08T12:00:00.000Z",
      createdAt: "2026-09-08T11:00:00.000Z", history: history,
      settlementAvailable: settlementAvailable, notice: notice,
      alreadyExists: alreadyExists, statusKnown: statusKnown)
  }
}

extension AuroraDepositHistoryEntry {
  static func fx(_ state: AuroraRouteState, _ status: String, _ at: String = "2026-09-08T12:00:00.000Z") -> AuroraDepositHistoryEntry {
    AuroraDepositHistoryEntry(state: state, status: status, at: at)
  }
}

extension AuroraNotice {
  static func fixture() -> AuroraNotice {
    AuroraNotice(
      mode: "preview",
      headline: "Preview — routes are quoted, not settled",
      detail: "Aurora routes to Monad mainnet. Prism is running against chain 10143, so a deposit reaches your account on mainnet and will not appear in the balance shown here.")
  }
}

extension AuroraArrival {
  static func fx(amountAtomic: String = "50000000", txHash: String = "0xaa") -> AuroraArrival {
    AuroraArrival(from: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", amountAtomic: amountAtomic,
                  symbol: "USDC", txHash: txHash, blockNumber: 42, timestamp: 1788793448, source: "monad")
  }
}
#endif
