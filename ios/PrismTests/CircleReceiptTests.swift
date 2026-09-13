import XCTest

@testable import Prism

/// A Circle payment on the ONE canonical receipt surface.
///
/// The property these tests protect is that a shared payment is an ordinary `PrismPayment` with an
/// extra block on it — same detail screen, same timeline, same receipt rows — and that the extra
/// block is never allowed to say more than it knows. Three specific lies are tested against:
///
///  - a within-limit spend rendered as if the Circle had approved it together,
///  - a Circle payment whose "From" names the admin who tapped send rather than the Circle,
///  - a governance line in the activity feed carrying a money amount.
final class CircleReceiptTests: XCTestCase {

  // MARK: - the receipt

  func testAThresholdPaymentNamesTheCircleWhoAskedAndWhoApproved() {
    let payment = PrismPayment.fixture(
      kind: .circlePayment, entryMethod: .circle, memo: "Apartment",
      sender: .fx("Lagos Trip"), recipient: .fx("Airbnb", handle: "@airbnb"),
      circle: .fx())
    let d = PaymentDisplay(payment: payment)

    XCTAssertEqual(d.title, "Airbnb", "the receipt is headlined by who was paid")
    XCTAssertEqual(d.paidFromLine, "Paid from Lagos Trip")

    let rows = Dictionary(uniqueKeysWithValues: d.circleRows.map { ($0.label, $0.value) })
    XCTAssertEqual(rows["Paid from"], "Lagos Trip")
    XCTAssertEqual(rows["Requested by"], "Octane")
    XCTAssertEqual(rows["Approved by"], "Octane\nTobi")
    XCTAssertEqual(rows["Approval rule"], "2 approvals")
    XCTAssertEqual(rows["Asset"], "USDC")
    XCTAssertEqual(rows["Status"], "Sent")

    // The payer is the Circle, not the person who proposed it.
    let receipt = Dictionary(uniqueKeysWithValues: d.receiptRows.map { ($0.label, $0.value) })
    XCTAssertEqual(receipt["From"], "Lagos Trip")
    XCTAssertEqual(receipt["Paid using"], "a Circle")

    // The approval step is in the lifecycle, where a personal payment has "You approved".
    XCTAssertTrue(d.timeline.contains { $0.title == "Approved by the Circle" })
  }

  func testAContributionReadsAsMoneyGoingIntoTheCircle() {
    let payment = PrismPayment.fixture(
      kind: .circleContribution, entryMethod: .circle, memo: "Added to Lagos Trip",
      sender: .fx("Octane"), recipient: .fx("Lagos Trip"),
      circle: .fx(flow: "in", policy: "CONTRIBUTION", requiredApprovals: nil, approvers: []))
    let d = PaymentDisplay(payment: payment)

    XCTAssertEqual(d.title, "Lagos Trip")
    XCTAssertEqual(d.paidFromLine, "Added to Lagos Trip")
    XCTAssertEqual(d.statusLabel, "Added")

    let rows = Dictionary(uniqueKeysWithValues: d.circleRows.map { ($0.label, $0.value) })
    XCTAssertEqual(rows["Added to"], "Lagos Trip")
    XCTAssertEqual(rows["Added by"], "Octane")
    // Nobody approved a contribution — it is the contributor's own money and their own signature.
    XCTAssertNil(rows["Approved by"])
    XCTAssertNil(rows["Approval rule"])
  }

  func testAWithinLimitSpendNamesTheLimitAndNeverClaimsAnApproval() {
    let limit = PrismSpendingLimitReference(
      period: "DAILY", periodLabel: "per day", limitAtomic: "100000000",
      summary: "$100.00 per day", source: "chain")
    let payment = PrismPayment.fixture(
      kind: .circleSpend, entryMethod: .circle, memo: "Groceries",
      sender: .fx("Lagos Trip"), recipient: .fx("Market", handle: "@market"),
      circle: .fx(policy: "SPENDING_LIMIT", requiredApprovals: nil, approvers: [], limit: limit))
    let d = PaymentDisplay(payment: payment)

    let rows = Dictionary(uniqueKeysWithValues: d.circleRows.map { ($0.label, $0.value) })
    XCTAssertEqual(rows["Paid from"], "Lagos Trip")
    XCTAssertEqual(rows["Spending limit"], "$100.00 per day")
    XCTAssertNil(rows["Approved by"], "a limit spend was not approved by anybody")
    XCTAssertNil(rows["Approval rule"])

    // And the lifecycle says what actually authorized it.
    XCTAssertTrue(d.timeline.contains { $0.title == "Within your limit" })
    XCTAssertFalse(d.timeline.contains { $0.title == "Approved by the Circle" })
  }

  func testThePayeeSeesWhichCirclePaidThemAndNothingAboutItsGovernance() {
    let payment = PrismPayment.fixture(
      kind: .circlePayment, direction: .received, entryMethod: .circle,
      sender: .fx("Lagos Trip"), recipient: .fx("You"),
      circle: .fx(requiredApprovals: nil, approvers: [], proposer: nil, restricted: true))
    let d = PaymentDisplay(payment: payment)

    let rows = Dictionary(uniqueKeysWithValues: d.circleRows.map { ($0.label, $0.value) })
    XCTAssertEqual(rows["Paid from"], "Lagos Trip")
    XCTAssertNil(rows["Requested by"])
    XCTAssertNil(rows["Approved by"])
    XCTAssertNil(rows["Approval rule"])
  }

  func testAPersonalPaymentGrowsNoCircleSection() {
    let d = PaymentDisplay(payment: .fixture())
    XCTAssertNil(d.circle)
    XCTAssertNil(d.paidFromLine)
    XCTAssertTrue(d.circleRows.isEmpty)
  }

  func testAnUnsettledCirclePaymentNeverReadsAsPaid() {
    let payment = PrismPayment.fixture(
      kind: .circlePayment, entryMethod: .circle, lifecycleState: .created,
      sender: .fx("Lagos Trip"), recipient: .fx("Airbnb"), transactionHash: nil,
      blockNumber: nil, completedAt: nil,
      circle: .fx(state: "APPROVAL_PENDING"))
    let d = PaymentDisplay(payment: payment)
    XCTAssertFalse(d.payment.isSettled)
    XCTAssertEqual(d.statusTone, .pending)
    XCTAssertNotEqual(d.timeline.last?.state, .done)
  }

  // MARK: - the activity feed

  private func wire(
    id: String = "row", cls: String = "financial", type: String = "PAYMENT",
    title: String = "Airbnb", subtitle: String? = nil, direction: String? = "out",
    amount: String? = "480000000", signed: String? = "-$480.00", status: String? = "COMPLETED",
    settled: Bool? = true, paymentId: String? = "prp_1", proposalId: String? = "prp_1"
  ) -> CircleActivityWireItem {
    CircleActivityWireItem(
      id: id, eventClass: cls, type: type, occurredAt: "2026-09-12T10:00:00.000Z", title: title,
      subtitle: subtitle, detail: nil, direction: direction, amountAtomic: amount,
      amountDisplay: nil, signedAmountDisplay: signed, asset: "USDC", status: status,
      settled: settled, paymentId: paymentId, proposalId: proposalId)
  }

  func testAMoneyLineOpensTheOrdinaryReceipt() {
    let item = CircleActivityItem(wire: wire())
    XCTAssertEqual(item.kind, .payment)
    XCTAssertTrue(item.movesMoney)
    XCTAssertEqual(item.paymentId, "prp_1", "a money row opens the canonical receipt")
    XCTAssertNil(item.proposalId, "a settled payment is a receipt, not an approval")
    XCTAssertTrue(item.signedAmount.hasPrefix("−"))
    XCTAssertEqual(item.status, "Paid")
  }

  func testAnOpenPaymentIsTappableThroughToItsApproval() {
    let item = CircleActivityItem(wire: wire(status: "APPROVAL_PENDING", settled: false))
    XCTAssertEqual(item.proposalId, "prp_1")
    XCTAssertEqual(item.status, "Waiting for approval")
    XCTAssertEqual(item.tone, .waiting)
  }

  func testAGovernanceLineCarriesNoMoneyAtAll() {
    let item = CircleActivityItem(wire: wire(
      cls: "governance", type: "SPENDING_LIMIT_CHANGED",
      title: "Sarah's spending limit changed", subtitle: "$50.00 per day → $100.00 per day",
      direction: nil, amount: nil, signed: nil, status: nil, settled: true,
      paymentId: nil, proposalId: "prp_gov"))

    XCTAssertEqual(item.kind, .governance)
    XCTAssertFalse(item.movesMoney)
    // Not "+$0.00" — a governance event moved nothing, and an amount of nothing is still an amount.
    XCTAssertEqual(item.signedAmount, "")
    XCTAssertNil(item.paymentId, "there is no receipt for a change that moved no money")
    XCTAssertEqual(item.subtitle, "$50.00 per day → $100.00 per day")
    XCTAssertEqual(item.status, "Spending changed")
  }

  func testMemberEventsReadAsPlainLanguage() {
    let joined = CircleActivityItem(wire: wire(
      cls: "governance", type: "MEMBER_JOINED", title: "Tobi joined", direction: nil,
      amount: nil, signed: nil, status: nil, paymentId: nil, proposalId: nil))
    XCTAssertEqual(joined.title, "Tobi joined")
    XCTAssertEqual(joined.status, "Joined")

    let closed = CircleActivityItem(wire: wire(
      cls: "governance", type: "CIRCLE_CLOSED", title: "The Circle was closed", direction: nil,
      amount: nil, signed: nil, status: nil, paymentId: nil, proposalId: nil))
    XCTAssertEqual(closed.status, "Closed")
  }

  // MARK: - closing

  func testTheCloseStateNamesTheOneDecisionPrismWillNotMake() {
    let state = CircleCloseState(
      circleId: "cir_1", status: "CLOSING", canClose: false,
      requirements: ["OPEN_PROPOSALS", "SPENDING_ACCESS", "REMAINING_FUNDS", "CHAIN_RECONCILED"],
      checks: [.init(code: "REMAINING_FUNDS", ok: false, balanceAtomic: "500000000", source: "chain")],
      blockers: [.init(
        code: "REMAINING_FUNDS", title: "$500.00 is still in this Circle",
        detail: "Decide together where this money goes and send it out of the Circle first.",
        balanceAtomic: "500000000", balanceDisplay: "$500.00", requiresExplicitDecision: true)],
      historyRetained: true)

    XCTAssertFalse(state.canClose)
    XCTAssertEqual(state.fundsBlocker?.balanceDisplay, "$500.00")
    XCTAssertEqual(state.fundsBlocker?.requiresExplicitDecision, true)
    XCTAssertEqual(state.historyRetained, true, "closing never deletes a Circle's past")
  }
}
