import XCTest

@testable import Prism

final class PrismCanonicalModelTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
  }

  // The canonical projection from GET /v1/payments/:id/canonical decodes into one model.
  func testCanonicalPaymentDecodes() throws {
    let json = """
    {"payment":{"paymentId":"0xabc","operationId":"0xabc","kind":"direct","direction":"sent",
      "entryMethod":"contact","sender":{"prismIdentityId":"p1","displayName":"You","handle":null,"accountAddress":null},
      "recipient":{"prismIdentityId":"p2","displayName":"@ada","handle":"@ada","accountAddress":"0x1"},
      "amountAtomic":"25000000","asset":"USDC","memo":"hi","requestId":null,"claimId":null,
      "resolutionId":"r1","resolutionVersion":1,"lifecycleState":"completed","createdAt":"2026-09-01T00:00:00.000Z",
      "authorizedAt":null,"submittedAt":null,"confirmedAt":"2026-09-01T00:01:00.000Z","indexedAt":null,
      "reconciledAt":"2026-09-01T00:01:00.000Z","completedAt":"2026-09-01T00:01:00.000Z",
      "transactionHash":"0xdeadbeef","blockNumber":"123","gasSponsored":true,"failureCode":null,"failureMessage":null},
     "events":[
      {"id":"e1","paymentId":"0xabc","state":"created","source":"app","occurredAt":"2026-09-01T00:00:00.000Z","displayTitle":"Created","displayDetail":null,"evidenceReference":null},
      {"id":"e2","paymentId":"0xabc","state":"confirmed","source":"monad","occurredAt":"2026-09-01T00:00:30.000Z","displayTitle":"Confirmed","displayDetail":null,"evidenceReference":"0xdeadbeef"},
      {"id":"e3","paymentId":"0xabc","state":"completed","source":"backend","occurredAt":"2026-09-01T00:01:00.000Z","displayTitle":"Completed","displayDetail":null,"evidenceReference":null}
     ],
     "receipt":{"receiptId":"rcpt_0xabc","paymentId":"0xabc","operationId":"0xabc","amountAtomic":"25000000","asset":"USDC",
      "memo":"hi","sender":{"prismIdentityId":"p1","displayName":"You","handle":null,"accountAddress":null},
      "recipient":{"prismIdentityId":"p2","displayName":"@ada","handle":"@ada","accountAddress":"0x1"},
      "entryMethod":"contact","resolutionId":"r1","resolutionVersion":1,"finalStatus":"completed",
      "transactionHash":"0xdeadbeef","blockNumber":"123","gasSponsored":true,"createdAt":"2026-09-01T00:00:00.000Z",
      "settledAt":"2026-09-01T00:01:00.000Z","requestId":null,"claimId":null}}
    """
    let c = try decode(PrismCanonicalPayment.self, json)
    XCTAssertEqual(c.payment.kind, .direct)
    XCTAssertEqual(c.payment.entryMethod, .contact)
    XCTAssertEqual(c.payment.dollars, "$25.00")
    XCTAssertTrue(c.payment.isSettled)
    XCTAssertTrue(c.receipt.isSettled)
    // Events stay ordered as delivered.
    XCTAssertEqual(c.events.map(\.state), [.created, .confirmed, .completed])
  }

  // A receipt must NOT claim settled merely because it was submitted.
  func testSubmittedIsNotSettled() throws {
    let json = """
    {"paymentId":"0x1","operationId":"0x1","kind":"direct","direction":"sent","entryMethod":"contact",
     "sender":{"prismIdentityId":null,"displayName":"You","handle":null,"accountAddress":null},
     "recipient":{"prismIdentityId":null,"displayName":"@x","handle":"@x","accountAddress":null},
     "amountAtomic":"1000000","asset":"USDC","memo":null,"requestId":null,"claimId":null,"resolutionId":null,
     "resolutionVersion":null,"lifecycleState":"submitted","createdAt":"2026-09-01T00:00:00.000Z","authorizedAt":null,
     "submittedAt":"2026-09-01T00:00:01.000Z","confirmedAt":null,"indexedAt":null,"reconciledAt":null,"completedAt":null,
     "transactionHash":"0xhash","blockNumber":null,"gasSponsored":true,"failureCode":null,"failureMessage":null}
    """
    let p = try decode(PrismPayment.self, json)
    XCTAssertEqual(p.lifecycleState, .submitted)
    XCTAssertFalse(p.isSettled, "submitted must not read as settled")
    XCTAssertNil(p.completedAt)
    XCTAssertFalse(PrismReceipt(payment: p).isSettled)
  }

  // Unrecognized enum values decode leniently instead of failing the whole payload.
  func testUnknownStaysUnknown() throws {
    let json = """
    {"id":"e","paymentId":"0x1","state":"someFutureState","source":"someFutureSource",
     "occurredAt":"2026-09-01T00:00:00.000Z","displayTitle":"x","displayDetail":null,"evidenceReference":null}
    """
    let e = try decode(PrismLifecycleEvent.self, json)
    XCTAssertEqual(e.state, .requiresAttention)  // unknown → requiresAttention, not confirmed/completed
    XCTAssertEqual(e.source, .unknown)
  }

  // Legacy Activity rows project into the canonical model (migration bridge).
  func testActivityBridge() {
    let a = ActivityRecord(id: "0xop", kind: "claim-funding", counterpartyPrismId: nil, counterpartyHandle: nil,
                           amountAtomic: "2000000", token: nil, tokenSymbol: "USDC", memo: "gift", status: "COMPLETED",
                           createdAt: "2026-09-01T00:00:00.000Z", transactionHash: "0xh", requestId: nil,
                           direction: "outgoing", claimId: "0xclaim")
    let p = PrismPayment(activity: a)
    XCTAssertEqual(p.kind, .claimFunding)
    XCTAssertEqual(p.entryMethod, .claim)
    XCTAssertEqual(p.claimId, "0xclaim")
    XCTAssertEqual(p.direction, .sent)
    XCTAssertTrue(p.isSettled)
  }
}
