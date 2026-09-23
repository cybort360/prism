import Foundation

/// Pure presentation logic for a cross-chain route — the quote card the user reads before approving,
/// and the timeline they watch afterwards. No SwiftUI, no networking, so every rule here is
/// unit-testable, in the same shape as `PaymentDisplay` and `AuroraDepositDisplay`.
struct AuroraRouteDisplay: Equatable {
  let route: AuroraRoute
  /// Injected so expiry is testable rather than dependent on the wall clock.
  let now: Date

  init(_ route: AuroraRoute, now: Date = Date()) {
    self.route = route
    self.now = now
  }

  // MARK: the quote

  /// What leaves the account, in the dollars the user thinks in.
  var youSend: String { Money.dollars(fromAtomic: route.amountInAtomic) }

  /// The guaranteed floor, which is what the user is actually approving. Never the expectation —
  /// `amountOut` is a forecast and must not be presented as a promise.
  var theyReceive: String? {
    guard let minOut = route.minAmountOut else { return nil }
    return "\(Self.tokenAmount(minOut, decimals: route.destination.decimals)) \(route.destination.symbol)"
  }

  /// Deliberately prefixed: the user is promised a minimum, and may receive more.
  var theyReceiveLine: String? {
    guard let amount = theyReceive else { return nil }
    return "At least \(amount) on \(route.destination.chainLabel)"
  }

  var estimatedArrival: String? {
    guard let seconds = route.timeEstimateSeconds else { return nil }
    return seconds < 90 ? "~\(seconds) seconds" : "~\(Int((Double(seconds) / 60).rounded())) minutes"
  }

  var shortDestinationAddress: String {
    let value = route.destination.address
    guard value.count > 16 else { return value }
    return "\(value.prefix(8))…\(value.suffix(6))"
  }

  /// Shown when Prism can check an address's shape but not fully verify it for that chain. The user
  /// is told rather than left to assume it was proven good.
  var addressCaution: String? {
    route.destination.addressVerified
      ? nil
      : "Prism can't fully verify \(route.destination.chainLabel) addresses. Check it carefully. A wrong address can't be recovered."
  }

  // MARK: approval gating

  var isExpired: Bool {
    guard let deadline = ISO8601DateFormatter.aurora.date(from: route.quoteDeadline) else { return false }
    return deadline <= now
  }

  var secondsUntilExpiry: Int? {
    guard let deadline = ISO8601DateFormatter.aurora.date(from: route.quoteDeadline) else { return nil }
    return max(0, Int(deadline.timeIntervalSince(now)))
  }

  /// Whether the user can approve this route right now. Every blocking reason is nameable — the
  /// button is never simply disabled without saying why.
  var canApprove: Bool { blockedReason == nil }

  var blockedReason: String? {
    if !route.fundable {
      return route.notice?.headline ?? "This route can be priced but not sent from this build."
    }
    if isExpired { return "This quote expired. Get a new one to see the current rate." }
    if route.state != .quoted { return "This route is already \(stateLabel.lowercased())." }
    return nil
  }

  // MARK: route status

  var stateLabel: String {
    switch route.state {
    case .quoted, .awaitingDeposit: "Ready to send"
    case .funding: "Sending"
    case .funded: "Received by the network"
    case .routing: "Converting to \(route.destination.symbol)"
    case .delivered: "Delivered"
    case .refunding: "Refunding"
    case .refunded: "Refunded"
    case .routeFailed: "Failed"
    case .requiresAttention: "Needs attention"
    case .expired: "Quote expired"
    }
  }

  var stateTone: PrismStatusTone {
    switch route.state {
    case .delivered: .positive
    case .routeFailed, .refunded: .danger
    case .requiresAttention, .expired: .pending
    default: .neutral
    }
  }

  /// The one-line explanation under a terminal state, so an unhappy ending is never just a label.
  var stateDetail: String? {
    switch route.state {
    case .refunded: "The route couldn't complete, so your money was returned to your Prism balance."
    case .routeFailed: "The route failed. If your money left your account it will be refunded to your Prism balance."
    case .requiresAttention: "Something about this transfer needs a look. It hasn't been lost."
    case .expired: "The quote lapsed before it was sent. Nothing left your account."
    default: nil
    }
  }

  struct Step: Equatable, Identifiable {
    let state: AuroraRouteState
    let title: String
    let reached: Bool
    var id: String { state.rawValue }
  }

  /// `reached` comes only from observed history. Progress is polled, so a step the poll never saw is
  /// shown as unreached rather than assumed from the current state.
  var timeline: [Step] {
    let observed = Set(route.history.map(\.state))
    let progression: [(AuroraRouteState, String)] = [
      (.funding, "Sent from your balance"),
      (.funded, "Received by the network"),
      (.routing, "Converting to \(route.destination.symbol)"),
      (.delivered, "Delivered on \(route.destination.chainLabel)")
    ]

    // A terminal outcome that is not delivery replaces the tail — a refunded route did not deliver.
    let ending: Step? = switch route.state {
    case .refunded: Step(state: .refunded, title: "Refunded to your balance", reached: true)
    case .routeFailed: Step(state: .routeFailed, title: "Route failed", reached: true)
    default: nil
    }
    if let ending {
      return progression.prefix { $0.0 != .delivered }.map { Step(state: $0.0, title: $0.1, reached: observed.contains($0.0)) } + [ending]
    }
    return progression.map { Step(state: $0.0, title: $0.1, reached: observed.contains($0.0)) }
  }

  var notice: AuroraNotice? { route.settlementAvailable ? nil : route.notice }

  // MARK: formatting

  /// Token amounts are not dollars: a destination asset can have 18 decimals and a tiny value, so it
  /// is formatted from its own decimals with enough significant digits to stay meaningful.
  static func tokenAmount(_ atomic: String, decimals: Int) -> String {
    guard let value = Decimal(string: atomic) else { return atomic }
    var divisor = Decimal(1)
    for _ in 0..<decimals { divisor *= 10 }
    let amount = value / divisor
    let double = NSDecimalNumber(decimal: amount).doubleValue

    let fractionDigits: Int
    switch double {
    case 0: fractionDigits = 2
    case ..<0.0001: fractionDigits = 8
    case ..<1: fractionDigits = 6
    case ..<1000: fractionDigits = 4
    default: fractionDigits = 2
    }
    // Round DOWN (toward zero): this value is shown as a guaranteed minimum ("you receive at least
    // X"), so it must never be rounded up into a promise the route can't keep.
    return double.formatted(.number.precision(.fractionLength(0...fractionDigits)).rounded(rule: .down).locale(Locale(identifier: "en_US")))
  }
}

extension ISO8601DateFormatter {
  /// Backend timestamps carry fractional seconds; the default formatter rejects them.
  /// `date(from:)` is thread-safe in practice; `nonisolated(unsafe)` is the codebase's accepted
  /// escape hatch for this (see ScanToPayView), avoiding a per-call formatter allocation.
  nonisolated(unsafe) static let aurora: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
}
