import XCTest

@testable import Prism

/// Covers AuroraDepositDisplay — the pure presentation logic behind the receive-from-anywhere
/// screen. The rules that matter here are honesty rules: a stale reading is never shown as current,
/// a refunded route never also reads as delivered, and an unavailable index never reads as "empty".
final class AuroraDepositDisplayTests: XCTestCase {

  // MARK: status

  func testAwaitingDeposit() {
    let d = AuroraDepositDisplay(.fixture())
    XCTAssertEqual(d.statusLabel, "Waiting for a deposit")
    XCTAssertEqual(d.statusTone, .neutral)
  }

  func testDeliveredIsTheOnlyPositiveTone() {
    XCTAssertEqual(AuroraDepositDisplay(.fixture(state: .delivered)).statusLabel, "Delivered")
    XCTAssertEqual(AuroraDepositDisplay(.fixture(state: .delivered)).statusTone, .positive)

    for state: AuroraRouteState in [.funding, .funded, .routing, .refunding] {
      XCTAssertNotEqual(AuroraDepositDisplay(.fixture(state: state)).statusTone, .positive,
                        "\(state.rawValue) must not read as a completed delivery")
    }
  }

  func testRoutingNamesTheDestinationAsset() {
    XCTAssertEqual(AuroraDepositDisplay(.fixture(state: .routing)).statusLabel, "Converting to USDC")
  }

  func testFailureAndRefundReadAsDanger() {
    XCTAssertEqual(AuroraDepositDisplay(.fixture(state: .routeFailed)).statusTone, .danger)
    XCTAssertEqual(AuroraDepositDisplay(.fixture(state: .refunded)).statusTone, .danger)
  }

  func testIncompleteDepositNeedsAttentionRatherThanFailing() {
    let d = AuroraDepositDisplay(.fixture(state: .requiresAttention, lastStatus: "INCOMPLETE_DEPOSIT"))
    XCTAssertEqual(d.statusLabel, "Needs attention")
    XCTAssertEqual(d.statusTone, .pending)
  }

  /// The important one: when the status service was unreachable, the state we hold is the last one
  /// we knew. Presenting it as current would be a claim we cannot support.
  func testStaleReadingIsNotPresentedAsCurrent() {
    let d = AuroraDepositDisplay(.fixture(state: .routing, statusKnown: false))
    XCTAssertEqual(d.statusLabel, "Status unavailable")
    XCTAssertEqual(d.statusTone, .neutral)
  }

  func testKnownStatusIsPresentedNormally() {
    let d = AuroraDepositDisplay(.fixture(state: .routing, statusKnown: true))
    XCTAssertEqual(d.statusLabel, "Converting to USDC")
  }

  // MARK: timeline

  func testTimelineMarksOnlyObservedSteps() {
    let d = AuroraDepositDisplay(.fixture(
      state: .routing,
      history: [.fx(.funding, "PENDING_DEPOSIT"), .fx(.routing, "PROCESSING")]))

    let reached = d.timeline.filter(\.reached).map(\.state)
    XCTAssertEqual(reached, [.funding, .routing])
    // `funded` was never observed — polling skipped it — so it must not be claimed.
    XCTAssertFalse(d.timeline.first { $0.state == .funded }?.reached ?? true)
  }

  func testDeliveredTimelineEndsAtDelivery() {
    let d = AuroraDepositDisplay(.fixture(
      state: .delivered,
      history: [.fx(.funding, "PENDING_DEPOSIT"), .fx(.funded, "KNOWN_DEPOSIT_TX"),
                .fx(.routing, "PROCESSING"), .fx(.delivered, "SUCCESS")]))
    XCTAssertEqual(d.timeline.last?.state, .delivered)
    XCTAssertTrue(d.timeline.allSatisfy(\.reached))
  }

  /// A refunded route did not deliver. The delivery step must be replaced, not merely left unreached
  /// alongside a refund.
  func testRefundedTimelineReplacesDeliveryRatherThanSittingBesideIt() {
    let d = AuroraDepositDisplay(.fixture(
      state: .refunded,
      history: [.fx(.funding, "PENDING_DEPOSIT"), .fx(.funded, "KNOWN_DEPOSIT_TX"), .fx(.refunded, "REFUNDED")]))

    XCTAssertEqual(d.timeline.last?.state, .refunded)
    XCTAssertEqual(d.timeline.last?.title, "Refunded to the sender")
    XCTAssertFalse(d.timeline.contains { $0.state == .delivered })
  }

  func testFailedTimelineEndsInFailure() {
    let d = AuroraDepositDisplay(.fixture(state: .routeFailed, history: [.fx(.routeFailed, "FAILED")]))
    XCTAssertEqual(d.timeline.last?.state, .routeFailed)
    XCTAssertFalse(d.timeline.contains { $0.state == .delivered })
  }

  // MARK: copy

  func testEvmAddressExplainsItIsSharedAcrossChains() {
    let d = AuroraDepositDisplay(.fixture(sharedAcrossEvmChains: true))
    XCTAssertTrue(d.explanation.contains("any EVM chain"))
  }

  func testNonEvmAddressWarnsItIsChainSpecific() {
    let d = AuroraDepositDisplay(.fixture(depositChain: "sol", depositChainLabel: "Solana", sharedAcrossEvmChains: false))
    XCTAssertTrue(d.explanation.contains("Only send Solana assets"))
  }

  func testMemoIsSurfacedOnlyWhenPresent() {
    XCTAssertNil(AuroraDepositDisplay(.fixture()).memoRequirement)
    XCTAssertNil(AuroraDepositDisplay(.fixture(memo: "")).memoRequirement)
    XCTAssertEqual(AuroraDepositDisplay(.fixture(memo: "1234567")).memoRequirement, "1234567")
  }

  func testShortAddressKeepsBothEnds() {
    let d = AuroraDepositDisplay(.fixture(depositAddress: "0x9f2b41c7d8e30a5b6c1f4907e2d83b5a6c7d8e90"))
    XCTAssertEqual(d.shortAddress, "0x9f2b41…7d8e90")
  }

  // MARK: preview notice

  func testPreviewNoticeShownWhenSettlementIsUnavailable() {
    let d = AuroraDepositDisplay(.fixture(settlementAvailable: false))
    XCTAssertNotNil(d.notice)
    XCTAssertTrue(d.notice?.detail.contains("mainnet") ?? false)
  }

  func testNoNoticeWhenSettlementIsLive() {
    let d = AuroraDepositDisplay(.fixture(settlementAvailable: true))
    XCTAssertNil(d.notice)
  }

  // MARK: arrivals

  func testArrivalsListFormatsDollars() {
    let response = AuroraArrivalsResponse(indexed: true, account: "0x11", reason: nil, arrivals: [.fx()])
    let d = AuroraArrivalsDisplay(response)
    XCTAssertEqual(d.amountLabel(response.arrivals[0]), "$50.00")
    XCTAssertNil(d.emptyMessage)
  }

  /// An index that cannot answer is not the same as nothing having arrived, and must not be phrased
  /// as if it were.
  func testUnavailableIndexIsNotReportedAsEmpty() {
    let indexed = AuroraArrivalsDisplay(
      AuroraArrivalsResponse(indexed: true, account: "0x11", reason: nil, arrivals: []))
    XCTAssertEqual(indexed.emptyMessage, "Nothing has arrived yet.")

    let unknown = AuroraArrivalsDisplay(
      AuroraArrivalsResponse(indexed: false, account: "0x11", reason: "not configured", arrivals: []))
    XCTAssertNotEqual(unknown.emptyMessage, "Nothing has arrived yet.")
    XCTAssertTrue(unknown.emptyMessage?.contains("can't be listed") ?? false)
    XCTAssertTrue(unknown.emptyMessage?.contains("read from the chain") ?? false)
  }

  // MARK: decoding

  func testUnknownRouteStateDecodesLenientlyRatherThanFailing() throws {
    let json = """
    {"state":"some_future_state","status":"WHATEVER","at":"2026-09-08T12:00:00.000Z"}
    """.data(using: .utf8)!
    let entry = try JSONDecoder().decode(AuroraDepositHistoryEntry.self, from: json)
    XCTAssertEqual(entry.state, .requiresAttention)
  }

  func testDepositDecodesFromTheBackendShape() throws {
    let json = """
    {
      "depositAddress": "0xabc0000000000000000000000000000000000001",
      "memo": null,
      "depositChain": "base",
      "depositChainLabel": "Base",
      "sharedAcrossEvmChains": true,
      "destinationChain": "monad",
      "destinationSymbol": "USDC",
      "recipientAccount": "0x1111111111111111111111111111111111111111",
      "state": "funding",
      "lastStatus": "PENDING_DEPOSIT",
      "lastCheckedAt": "2026-09-08T12:00:00.000Z",
      "createdAt": "2026-09-08T11:00:00.000Z",
      "history": [{"state":"funding","status":"PENDING_DEPOSIT","at":"2026-09-08T12:00:00.000Z"}],
      "settlementAvailable": false,
      "notice": {"mode":"preview","headline":"Preview","detail":"Routes to mainnet."},
      "alreadyExists": true,
      "statusKnown": true
    }
    """.data(using: .utf8)!
    let deposit = try JSONDecoder().decode(AuroraDeposit.self, from: json)
    XCTAssertEqual(deposit.state, .funding)
    XCTAssertEqual(deposit.alreadyExists, true)
    XCTAssertEqual(deposit.history.count, 1)
    XCTAssertEqual(AuroraDepositDisplay(deposit).statusLabel, "Deposit detected")
  }
}
