import XCTest

@testable import Prism

/// Covers PaymentDisplay (the pure presentation logic behind PaymentDetailsView) across every state
/// the one canonical screen must render. Consumer language, dollar amounts, honest completion.
final class PaymentDetailsModelTests: XCTestCase {

  func testCompletedDirect() {
    let d = PaymentDisplay(payment: .fixture(), events: PrismPayment.fixtureEvents)
    XCTAssertEqual(d.title, "Tobi Bakare")
    XCTAssertEqual(d.handle, "@tobi")
    XCTAssertEqual(d.amountLine, "$20.00")
    XCTAssertEqual(d.statusLabel, "Sent")
    XCTAssertEqual(d.statusTone, .positive)
    XCTAssertEqual(d.timeline.last?.title, "Delivered")
    XCTAssertEqual(d.timeline.last?.state, .done)
    XCTAssertTrue(d.timeline.allSatisfy { $0.state == .done })
  }

  func testPendingDirect() {
    let events: [PrismLifecycleEvent] = [
      .fx(.created, .app, "Payment created", "2026-09-05T02:30:00.000Z"),
      .fx(.authorized, .userAuthorization, "Authorized", "2026-09-05T02:30:20.000Z"),
      .fx(.submitted, .relayer, "Submitted", "2026-09-05T02:30:30.000Z"),
      .fx(.confirming, .monad, "Confirming", "2026-09-05T02:30:40.000Z")
    ]
    let d = PaymentDisplay(payment: .fixture(lifecycleState: .confirming, completedAt: nil), events: events)
    XCTAssertEqual(d.statusLabel, "Confirming")
    XCTAssertEqual(d.statusTone, .pending)
    XCTAssertFalse(d.payment.isSettled)
    XCTAssertNotEqual(d.timeline.last?.state, .done)           // "Delivered" not reached
    XCTAssertTrue(d.timeline.contains { $0.state == .current }) // one animated current step
  }

  func testFailed() {
    let d = PaymentDisplay(payment: .fixture(lifecycleState: .failedTerminal, completedAt: nil))
    XCTAssertEqual(d.statusLabel, "Failed")
    XCTAssertEqual(d.statusTone, .danger)
  }

  func testPaidRequestCarriesRelatedRequest() {
    let d = PaymentDisplay(payment: .fixture(kind: .requestPayment, entryMethod: .request, requestId: "0xreq123456789"))
    XCTAssertEqual(d.payment.kind, .requestPayment)
    XCTAssertEqual(d.entryMethodLabel, "a request")
    XCTAssertTrue(d.receiptRows.contains { $0.label == "Related request" })
  }

  func testActiveClaimIsProtected() {
    let d = PaymentDisplay(payment: .fixture(kind: .claimFunding, entryMethod: .claim, lifecycleState: .completed, recipient: .fx("David"), claimId: "0xclaimabc123"))
    XCTAssertEqual(d.statusLabel, "Protected for David")
    XCTAssertTrue(d.receiptRows.contains { $0.label == "Claim reference" })
  }

  func testCompletedClaimReceived() {
    let d = PaymentDisplay(payment: .fixture(kind: .claimSettlement, direction: .received, entryMethod: .claim, sender: .fx("Octane"), recipient: .fx("You"), claimId: "0xc"))
    XCTAssertEqual(d.title, "Octane")
    XCTAssertEqual(d.amountLine, "$20.00 received")
    XCTAssertEqual(d.statusLabel, "Received")
  }

  func testRefund() {
    let d = PaymentDisplay(payment: .fixture(kind: .refund, direction: .received, entryMethod: .claim, memo: nil, sender: .fx("Prism"), recipient: .fx("You")))
    XCTAssertEqual(d.title, "Refund")
    XCTAssertNil(d.handle)
    XCTAssertEqual(d.amountLine, "+$20.00 returned")
    XCTAssertEqual(d.statusLabel, "Refunded")
  }

  func testEntryMethods() {
    XCTAssertEqual(PaymentDisplay(payment: .fixture(kind: .qrPayment, entryMethod: .qr)).entryMethodLabel, "Prism QR")
    XCTAssertEqual(PaymentDisplay(payment: .fixture(kind: .linkPayment, entryMethod: .paymentLink)).entryMethodLabel, "payment link")
    XCTAssertEqual(PaymentDisplay(payment: .fixture(entryMethod: .contact)).entryMethodLabel, "Contacts")
    XCTAssertEqual(PaymentDisplay(payment: .fixture(entryMethod: .phone)).entryMethodLabel, "Phone")
    XCTAssertEqual(PaymentDisplay(payment: .fixture(entryMethod: .handle)).entryMethodLabel, "@handle")
  }

  func testNoTxHashHasNoTransactionRow() {
    let d = PaymentDisplay(payment: .fixture(lifecycleState: .submitted, transactionHash: nil, blockNumber: nil, completedAt: nil))
    XCTAssertFalse(d.technicalRows.contains { $0.label == "Transaction" })
    XCTAssertTrue(d.technicalRows.contains { $0.label == "Network" && $0.value == "Monad" })
  }

  func testIndexingDelayedStaysDelivered() {
    // Completed on-chain but Envio hasn't indexed — the consumer still sees it delivered.
    let d = PaymentDisplay(payment: .fixture(lifecycleState: .completed))
    XCTAssertEqual(d.statusLabel, "Sent")
    XCTAssertTrue(d.payment.isSettled)
  }

  func testRequiresAttention() {
    let d = PaymentDisplay(payment: .fixture(lifecycleState: .requiresAttention, completedAt: nil))
    XCTAssertEqual(d.statusLabel, "Needs your attention")
    XCTAssertEqual(d.statusTone, .danger)
  }

  func testLongNameAndEmptyMemo() {
    let long = "Alexandria Bartholomew Christopherson-Wellington III"
    let d = PaymentDisplay(payment: .fixture(memo: "   ", recipient: .fx(long, handle: "@alex")))
    XCTAssertEqual(d.title, long)
    XCTAssertEqual(d.initials.count, 2)               // no overflow
    XCTAssertNil(d.memo)                              // whitespace memo is dropped
    XCTAssertFalse(d.receiptRows.contains { $0.label == "Note" })  // no blank Note row
  }

  func testNeverBlankReceiptRows() {
    let d = PaymentDisplay(payment: .fixture(memo: nil))
    XCTAssertTrue(d.receiptRows.allSatisfy { !$0.value.isEmpty })
  }
}
