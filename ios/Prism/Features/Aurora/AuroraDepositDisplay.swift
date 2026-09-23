import Foundation

/// Pure presentation logic for a cross-chain deposit. No SwiftUI, no networking — the same shape as
/// `PaymentDisplay`, so every status/label/timeline rule is unit-testable without a view.
struct AuroraDepositDisplay: Equatable {
  let deposit: AuroraDeposit

  init(_ deposit: AuroraDeposit) { self.deposit = deposit }

  var address: String { deposit.depositAddress }
  var chainLabel: String { deposit.depositChainLabel }

  /// Short middle-elided address for a constrained row. The full value is always available to copy.
  var shortAddress: String {
    let value = deposit.depositAddress
    guard value.count > 16 else { return value }
    return "\(value.prefix(8))…\(value.suffix(6))"
  }

  var statusLabel: String {
    // A stale reading is never presented as current. This has to come first: the state below is the
    // last thing we knew, not what is true now.
    if deposit.statusKnown == false { return "Status unavailable" }
    switch deposit.state {
    case .awaitingDeposit, .quoted: return "Waiting for a deposit"
    case .funding: return "Deposit detected"
    case .funded: return "Deposit confirmed"
    case .routing: return "Converting to \(deposit.destinationSymbol)"
    case .delivered: return "Delivered"
    case .refunding: return "Refunding"
    case .refunded: return "Refunded"
    case .routeFailed: return "Route failed"
    case .requiresAttention: return "Needs attention"
    case .expired: return "Expired"
    }
  }

  var statusTone: PrismStatusTone {
    if deposit.statusKnown == false { return .neutral }
    switch deposit.state {
    case .delivered: return .positive
    case .routeFailed, .refunded: return .danger
    case .requiresAttention, .expired: return .pending
    default: return .neutral
    }
  }

  /// One line explaining what this address does, in the user's terms.
  var explanation: String {
    let shared = deposit.sharedAcrossEvmChains
      ? "Works for any EVM chain. \(deposit.depositChainLabel) included."
      : "Only send \(deposit.depositChainLabel) assets to this address."
    return "Send any supported token here and it arrives as \(deposit.destinationSymbol) in your Prism account. \(shared)"
  }

  /// A memo some chains require alongside the transfer. Omitting it loses the deposit, so it is
  /// surfaced as a hard requirement rather than a detail.
  var memoRequirement: String? {
    guard let memo = deposit.memo, !memo.isEmpty else { return nil }
    return memo
  }

  /// The preview-mode banner, when the routed leg cannot settle against this build's chain.
  var notice: AuroraNotice? { deposit.settlementAvailable ? nil : deposit.notice }

  /// Ordered lifecycle steps for the timeline. `reached` is observed history, never inferred from
  /// the current state alone, so a route that skipped a step (polling misses intermediate states)
  /// does not claim to have observed it.
  struct Step: Equatable, Identifiable {
    let state: AuroraRouteState
    let title: String
    let reached: Bool
    var id: String { state.rawValue }
  }

  var timeline: [Step] {
    let observed = Set(deposit.history.map(\.state))
    let progression: [(AuroraRouteState, String)] = [
      (.funding, "Deposit detected"),
      (.funded, "Deposit confirmed"),
      (.routing, "Converting to \(deposit.destinationSymbol)"),
      (.delivered, "Delivered to your account")
    ]

    // A terminal outcome that is not delivery replaces the tail of the happy path rather than
    // sitting alongside it — a refunded route did not also deliver.
    if let ending = terminalStep {
      let kept = progression.prefix { $0.0 != .delivered }
      return kept.map { Step(state: $0.0, title: $0.1, reached: observed.contains($0.0)) } + [ending]
    }
    return progression.map { Step(state: $0.0, title: $0.1, reached: observed.contains($0.0)) }
  }

  private var terminalStep: Step? {
    switch deposit.state {
    case .refunded: Step(state: .refunded, title: "Refunded to the sender", reached: true)
    case .routeFailed: Step(state: .routeFailed, title: "Route failed", reached: true)
    case .expired: Step(state: .expired, title: "Expired before any deposit", reached: true)
    default: nil
    }
  }
}

/// Presentation for the inbound-arrivals list.
struct AuroraArrivalsDisplay: Equatable {
  let response: AuroraArrivalsResponse

  init(_ response: AuroraArrivalsResponse) { self.response = response }

  var arrivals: [AuroraArrival] { response.arrivals }

  /// What to show when there is nothing to list. An unavailable index is NOT an empty state — it is
  /// an unknown one, and saying "nothing yet" there would be a claim we cannot support.
  var emptyMessage: String? {
    guard response.arrivals.isEmpty else { return nil }
    return response.indexed
      ? "Nothing has arrived yet."
      : "Recent arrivals can't be listed right now. Your balance is unaffected. It's read from the chain."
  }

  func amountLabel(_ arrival: AuroraArrival) -> String {
    Money.dollars(fromAtomic: arrival.amountAtomic)
  }
}
