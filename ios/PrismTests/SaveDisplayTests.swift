import XCTest

@testable import Prism

/// SaveDisplay is the single source of display truth for the Save screens. It must show a number only when
/// it is actually known: APY only when fresh, earned only with a cost basis, a dash otherwise — and never
/// leak the substrate into the primary strings.
final class SaveDisplayTests: XCTestCase {
  private func active(value: String = "1508420000", principal: String = "1500000000", earned: String? = "8420000",
                      monthly: String? = "4120000", apy: SaveRate? = SaveRate(available: true, apy: 0.0708, apySource: "upshift", apyWindow: "30d", observedAt: "2026-01-01T00:00:00Z")) -> SaveDisplay {
    SaveDisplay(position: SavePositionResponse(status: "ACTIVE", currentAUSDValue: value, earnedAUSD: earned, principalAUSD: principal, estimatedMonthlyEarningsAUSD: monthly, apy: apy), stateRate: nil)
  }

  func testActivePositionFormatsMoneyAndRate() {
    let d = active()
    XCTAssertTrue(d.hasPosition)
    XCTAssertEqual(d.balanceText, "$1,508.42")
    XCTAssertEqual(d.savedText, "$1,500.00")
    XCTAssertEqual(d.earnedText, "+$8.42")
    XCTAssertEqual(d.earnedIsPositive, true)
    XCTAssertEqual(d.rateText, "7.08% APY")
    XCTAssertEqual(d.rateWindowText, "30-day trailing")
    XCTAssertEqual(d.monthlyEstimateText, "+$4.12")
  }

  func testApyShownOnlyWhenFresh() {
    let stale = active(apy: SaveRate(available: false, reason: "rate_stale"))
    XCTAssertNil(stale.rateText, "an unavailable/stale rate is never shown as a number")
    XCTAssertNil(stale.monthlyEstimateText, "no estimate without a fresh APY")
    XCTAssertFalse(stale.apyFresh)
  }

  func testEarnedNegativeUsesMinusAndNotColorAlone() {
    let d = active(earned: "-5000000")
    XCTAssertEqual(d.earnedText, "−$5.00")   // a real minus sign, not conveyed by color alone
    XCTAssertEqual(d.earnedIsPositive, false)
  }

  func testEarnedUnavailableWithoutCostBasis() {
    let d = active(earned: nil, monthly: nil)
    XCTAssertNil(d.earnedText)                // never guessed
  }

  func testFirstEntryAndUnavailable() {
    let first = SaveDisplay(position: SavePositionResponse(status: "NONE"), stateRate: SaveRate(available: false))
    XCTAssertTrue(first.isFirstEntry)
    XCTAssertFalse(first.hasPosition)
    XCTAssertNil(first.rateText)

    let unavailable = SaveDisplay(position: SavePositionResponse(status: "UNAVAILABLE", notLiveReason: "not connected"), stateRate: nil)
    XCTAssertTrue(unavailable.isUnavailable)
    XCTAssertEqual(unavailable.balanceText, "—")
  }
}
