import XCTest

@testable import Prism

/// Covers AuroraRouteDisplay — the quote card and route timeline behind SendToAnywhereView.
///
/// The rules under test are the honest-money ones: the user is shown the guaranteed floor rather
/// than the forecast, approval is blocked with a nameable reason rather than silently disabled, a
/// confirmed Monad leg never reads as delivery, and a refunded route never also reads as delivered.
final class AuroraRouteDisplayTests: XCTestCase {

  private let deadline = "2036-09-08T12:03:00.000Z"
  private var beforeExpiry: Date { ISO8601DateFormatter.aurora.date(from: "2036-09-08T12:01:00.000Z")! }
  private var afterExpiry: Date { ISO8601DateFormatter.aurora.date(from: "2036-09-08T12:04:00.000Z")! }

  // MARK: the quote

  func testShowsWhatLeavesTheAccountInDollars() {
    let d = AuroraRouteDisplay(.fixture(), now: beforeExpiry)
    XCTAssertEqual(d.youSend, "$50.00")
  }

  /// The critical one: the user approves a floor, not a forecast. `amountOut` must never be the
  /// number presented as what they receive.
  func testShowsTheGuaranteedMinimumNotTheForecast() {
    let route = AuroraRoute.fixture(amountOut: "20100000000000000", minAmountOut: "19899000000000000")
    let d = AuroraRouteDisplay(route, now: beforeExpiry)

    XCTAssertEqual(d.theyReceive, "0.0199 ETH")
    XCTAssertEqual(d.theyReceiveLine, "At least 0.0199 ETH on Arbitrum")
    XCTAssertFalse(d.theyReceiveLine?.contains("0.0201") ?? true, "the forecast must not be shown as the promise")
  }

  func testTokenAmountsFormatByTheirOwnDecimals() {
    // A stablecoin at 6dp and a tiny 18dp balance must both stay readable.
    XCTAssertEqual(AuroraRouteDisplay.tokenAmount("49850000", decimals: 6), "49.85")
    XCTAssertEqual(AuroraRouteDisplay.tokenAmount("1000000000000000000", decimals: 18), "1")
    XCTAssertEqual(AuroraRouteDisplay.tokenAmount("0", decimals: 18), "0")
    // Sub-0.0001 keeps enough significant digits to remain meaningful rather than rounding to zero.
    XCTAssertNotEqual(AuroraRouteDisplay.tokenAmount("10000000000000", decimals: 18), "0")
  }

  func testArrivalEstimateReadsInHumanUnits() {
    XCTAssertEqual(AuroraRouteDisplay(.fixture(timeEstimateSeconds: 45), now: beforeExpiry).estimatedArrival, "~45 seconds")
    XCTAssertEqual(AuroraRouteDisplay(.fixture(timeEstimateSeconds: 300), now: beforeExpiry).estimatedArrival, "~5 minutes")
    XCTAssertNil(AuroraRouteDisplay(.fixture(timeEstimateSeconds: nil), now: beforeExpiry).estimatedArrival)
  }

  func testUnverifiableAddressCarriesACaution() {
    XCTAssertNil(AuroraRouteDisplay(.fixture(addressVerified: true), now: beforeExpiry).addressCaution)

    let unverified = AuroraRouteDisplay(
      .fixture(destinationChain: "btc", destinationChainLabel: "Bitcoin", addressVerified: false),
      now: beforeExpiry)
    XCTAssertNotNil(unverified.addressCaution)
    XCTAssertTrue(unverified.addressCaution?.contains("can't be recovered") ?? false)
  }

  // MARK: approval gating

  func testAFreshFundableQuoteCanBeApproved() {
    let d = AuroraRouteDisplay(.fixture(), now: beforeExpiry)
    XCTAssertTrue(d.canApprove)
    XCTAssertNil(d.blockedReason)
    XCTAssertFalse(d.isExpired)
  }

  func testAnExpiredQuoteIsBlockedWithAReason() {
    let d = AuroraRouteDisplay(.fixture(), now: afterExpiry)
    XCTAssertTrue(d.isExpired)
    XCTAssertFalse(d.canApprove)
    XCTAssertEqual(d.blockedReason, "This quote expired. Get a new one to see the current rate.")
    XCTAssertEqual(d.secondsUntilExpiry, 0)
  }

  /// A preview quote is real pricing that cannot be funded. It must be visibly un-approvable, and
  /// the reason must come from the backend's own notice rather than a guess made in the app.
  func testAPreviewQuoteIsPricedButNotApprovable() {
    let route = AuroraRoute.fixture(
      depositAddress: nil, fundable: false, settlementAvailable: false, notice: .fixture())
    let d = AuroraRouteDisplay(route, now: beforeExpiry)

    XCTAssertNotNil(d.theyReceiveLine, "the price is still real and still shown")
    XCTAssertFalse(d.canApprove)
    XCTAssertEqual(d.blockedReason, AuroraNotice.fixture().headline)
    XCTAssertNotNil(d.notice)
  }

  func testAnAlreadySentRouteCannotBeApprovedAgain() {
    let d = AuroraRouteDisplay(.fixture(state: .routing), now: beforeExpiry)
    XCTAssertFalse(d.canApprove)
    XCTAssertTrue(d.blockedReason?.contains("already") ?? false)
  }

  func testEveryBlockedStateNamesItsReason() {
    // The button is never simply disabled — if it cannot be pressed, the screen can say why.
    let blocked: [AuroraRoute] = [
      .fixture(state: .funding),
      .fixture(state: .delivered),
      .fixture(state: .refunded),
      .fixture(state: .routeFailed),
      .fixture(fundable: false, settlementAvailable: false, notice: .fixture())
    ]
    for route in blocked {
      let d = AuroraRouteDisplay(route, now: beforeExpiry)
      XCTAssertFalse(d.canApprove, "\(route.state.rawValue) should block approval")
      XCTAssertNotNil(d.blockedReason, "\(route.state.rawValue) must name its reason")
    }
  }

  // MARK: route status

  func testStateLabelsAndTones() {
    XCTAssertEqual(AuroraRouteDisplay(.fixture(state: .quoted), now: beforeExpiry).stateLabel, "Ready to send")
    XCTAssertEqual(AuroraRouteDisplay(.fixture(state: .routing), now: beforeExpiry).stateLabel, "Converting to ETH")
    XCTAssertEqual(AuroraRouteDisplay(.fixture(state: .delivered), now: beforeExpiry).stateTone, .positive)
    XCTAssertEqual(AuroraRouteDisplay(.fixture(state: .refunded), now: beforeExpiry).stateTone, .danger)
    XCTAssertEqual(AuroraRouteDisplay(.fixture(state: .routeFailed), now: beforeExpiry).stateTone, .danger)
  }

  /// Only delivery counts as delivery. Sending, converting, or a confirmed Monad leg must not read
  /// as a positive outcome.
  func testOnlyDeliveryReadsAsPositive() {
    for state: AuroraRouteState in [.funding, .funded, .routing, .refunding, .requiresAttention] {
      XCTAssertNotEqual(AuroraRouteDisplay(.fixture(state: state), now: beforeExpiry).stateTone, .positive,
                        "\(state.rawValue) must not read as delivered")
    }
  }

  func testTerminalStatesExplainThemselves() {
    XCTAssertTrue(AuroraRouteDisplay(.fixture(state: .refunded), now: beforeExpiry).stateDetail?.contains("returned to your Prism balance") ?? false)
    XCTAssertNotNil(AuroraRouteDisplay(.fixture(state: .routeFailed), now: beforeExpiry).stateDetail)
    XCTAssertTrue(AuroraRouteDisplay(.fixture(state: .expired), now: beforeExpiry).stateDetail?.contains("Nothing left your account") ?? false)
    XCTAssertNil(AuroraRouteDisplay(.fixture(state: .delivered), now: beforeExpiry).stateDetail)
  }

  // MARK: timeline

  func testTimelineMarksOnlyObservedSteps() {
    let d = AuroraRouteDisplay(
      .fixture(state: .routing, history: [.fx(.funding, "PENDING_DEPOSIT"), .fx(.routing, "PROCESSING")]),
      now: beforeExpiry)

    XCTAssertEqual(d.timeline.filter(\.reached).map(\.state), [.funding, .routing])
    // Polling skipped `funded`; an unobserved step is not claimed.
    XCTAssertFalse(d.timeline.first { $0.state == .funded }?.reached ?? true)
  }

  func testRefundedTimelineReplacesDeliveryRatherThanSittingBesideIt() {
    let d = AuroraRouteDisplay(
      .fixture(state: .refunded, history: [.fx(.funding, "PENDING_DEPOSIT"), .fx(.refunded, "REFUNDED")]),
      now: beforeExpiry)

    XCTAssertEqual(d.timeline.last?.state, .refunded)
    XCTAssertEqual(d.timeline.last?.title, "Refunded to your balance")
    XCTAssertFalse(d.timeline.contains { $0.state == .delivered })
  }

  func testDeliveredTimelineNamesTheDestinationChain() {
    let d = AuroraRouteDisplay(
      .fixture(state: .delivered, history: [.fx(.funding, "x"), .fx(.funded, "x"), .fx(.routing, "x"), .fx(.delivered, "SUCCESS")]),
      now: beforeExpiry)
    XCTAssertEqual(d.timeline.last?.title, "Delivered on Arbitrum")
    XCTAssertTrue(d.timeline.allSatisfy(\.reached))
  }

  // MARK: decoding

  func testRouteDecodesFromTheBackendShape() throws {
    let json = """
    {
      "routeId": "r_1",
      "state": "quoted",
      "lastStatus": null,
      "amountInAtomic": "50000000",
      "origin": {"chain":"monad","assetId":"nep245:monad-usdc","symbol":"USDC","decimals":6},
      "destination": {"chain":"arb","chainLabel":"Arbitrum","address":"0x742d35Cc6634C0532925a3b844Bc454e4438f44e","assetId":"nep141:arb.omft.near","symbol":"ETH","decimals":18,"addressVerified":true},
      "depositAddress": "0xabc0000000000000000000000000000000000001",
      "amountOut": "20100000000000000",
      "minAmountOut": "19899000000000000",
      "timeEstimateSeconds": 45,
      "quoteDeadline": "2036-09-08T12:03:00.000Z",
      "quoteSignature": "sig",
      "correlationId": "corr",
      "paymentId": null,
      "createdAt": "2036-09-08T12:00:00.000Z",
      "history": [],
      "fundable": true,
      "settlementAvailable": true,
      "notice": null
    }
    """.data(using: .utf8)!
    let route = try JSONDecoder().decode(AuroraRoute.self, from: json)
    XCTAssertEqual(route.state, .quoted)
    XCTAssertEqual(route.destination.symbol, "ETH")
    XCTAssertTrue(route.fundable)
    XCTAssertEqual(AuroraRouteDisplay(route, now: beforeExpiry).youSend, "$50.00")
  }

  func testUnknownRouteStateDecodesLenientlyRatherThanFailing() throws {
    let json = #"{"state":"some_future_state","status":"X","at":"2036-09-08T12:00:00.000Z"}"#.data(using: .utf8)!
    let entry = try JSONDecoder().decode(AuroraDepositHistoryEntry.self, from: json)
    XCTAssertEqual(entry.state, .requiresAttention)
  }
}

/// Guards the payment-detail screen's handling of the new kind. A cross-chain send must not claim
/// delivery on Monad — Monad is only where it left from.
final class CrossChainPaymentDetailsTests: XCTestCase {

  func testCrossChainSendDoesNotClaimDelivery() {
    let d = PaymentDisplay(payment: .fixture(kind: .crossChainSend, entryMethod: .anyChain))
    let titles = d.timeline.map(\.title)
    XCTAssertTrue(titles.contains("Sent from Monad"))
    XCTAssertFalse(titles.contains("Delivered"), "delivery happens on another chain and is not this screen's claim")
  }

  func testNetworkRowIsNoLongerHardcodedToMonad() {
    let crossChain = PaymentDisplay(payment: .fixture(kind: .crossChainSend))
    XCTAssertEqual(crossChain.networkLabel, "Monad → another network")

    let direct = PaymentDisplay(payment: .fixture())
    XCTAssertEqual(direct.networkLabel, "Monad")
    XCTAssertTrue(direct.technicalRows.contains { $0.label == "Network" && $0.value == "Monad" })
  }

  func testAnUnknownKindOrEntryMethodDecodesLenientlyRatherThanFailing() throws {
    let kind = try JSONDecoder().decode(PrismPaymentKind.self, from: #""some_future_kind""#.data(using: .utf8)!)
    XCTAssertEqual(kind, .direct)
    let entry = try JSONDecoder().decode(PrismEntryMethod.self, from: #""some_future_entry""#.data(using: .utf8)!)
    XCTAssertEqual(entry, .contact)
  }
}
