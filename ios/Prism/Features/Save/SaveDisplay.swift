import Foundation

/// The single source of display truth for every Save screen. Pure and testable: it maps the reconstructed
/// position + rate into the exact strings the consumer sees, hides the substrate, and — critically — only
/// ever shows numbers that are actually known (APY only when fresh; earned only with a cost basis; a dash,
/// never a guess, otherwise).
struct SaveDisplay: Equatable {
  let position: SavePositionResponse?
  let stateRate: SaveRate?
  /// In-flight withdrawals — kept visible until USDC lands.
  var pending: [SavePendingWithdrawal] = []
  /// A clearly-labeled example used only to review the native experience; never real, live savings.
  var isExample: Bool = false

  var hasPending: Bool { !pending.isEmpty }
  /// A withdrawal's amount as "$200.00", or nil.
  func pendingAmountText(_ w: SavePendingWithdrawal) -> String? { w.amountAtomic.map { Money.dollars(fromAtomic: $0) } }

  // MARK: which surface

  var status: String { position?.status ?? "NONE" }
  var hasPosition: Bool { status == "ACTIVE" }
  var isFirstEntry: Bool { status == "NONE" }
  var isUnavailable: Bool { status == "UNAVAILABLE" }
  var notLiveReason: String? { position?.notLiveReason }

  // MARK: the rate (position rate first, else the deployment rate)

  var rate: SaveRate { position?.apy ?? stateRate ?? SaveRate(available: false) }
  var apyFresh: Bool { rate.available && rate.percent != nil }
  /// "7.08% APY" — only when fresh; never a stale or fabricated number.
  var rateText: String? { apyFresh ? String(format: "%.2f%% APY", rate.percent!) : nil }
  var rateWindowText: String? { apyFresh ? rate.windowText : nil }

  // MARK: money (all dashes when the chain value isn't known)

  var balanceText: String { dollars(position?.currentAUSDValue) }             // total savings value
  var savedText: String { dollars(position?.principalAUSD) }                  // principal (cost basis)
  var earnedText: String? { signedDollars(position?.earnedAUSD) }            // actual, all-time; nil if unknown
  var earnedIsPositive: Bool? {
    guard let e = position?.earnedAUSD, let v = Int64(e) else { return nil }
    return v >= 0
  }
  var allTimeEarnedText: String? { earnedText }
  /// Estimated monthly earnings — explicitly an estimate, only when the APY is fresh.
  var monthlyEstimateText: String? {
    guard apyFresh, let m = position?.estimatedMonthlyEarningsAUSD else { return nil }
    return signedDollars(m)
  }

  // MARK: formatting

  private func dollars(_ atomic: String?) -> String {
    guard let atomic, !atomic.isEmpty, atomic.allSatisfy({ $0.isNumber || $0 == "-" }) else { return "—" }
    return Money.dollars(fromAtomic: atomic)
  }
  private func signedDollars(_ atomic: String?) -> String? {
    guard let atomic, let v = Int64(atomic) else { return nil }
    let sign = v >= 0 ? "+" : "−"
    return sign + Money.dollars(fromAtomic: String(abs(v)))
  }

  #if DEBUG
  /// A populated example for reviewing the experience (never presented as real live savings).
  static let example = SaveDisplay(
    position: SavePositionResponse(
      status: "ACTIVE", earnAUSDShares: "1493000000", currentAUSDValue: "1508420000",
      earnedAUSD: "8420000", principalAUSD: "1500000000", estimatedMonthlyEarningsAUSD: "4120000",
      notLiveReason: nil,
      apy: SaveRate(available: true, apy: 0.0708, apySource: "upshift", apyWindow: "30d", observedAt: ISO8601DateFormatter().string(from: Date()))),
    stateRate: nil,
    pending: [SavePendingWithdrawal(operationId: "demo", amountAtomic: "200000000", status: "Processing", phase: "processing", requestedAt: "2026-09-10T00:00:00Z", expectedWindow: "Up to 72 hours")],
    isExample: true)
  #endif
}
