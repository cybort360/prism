import XCTest

@testable import Prism

/// Covers the Payment Proof presentation logic: honest status/label mapping, lenient decoding of the
/// canonical proof, and the safety of the shareable proof summary (no secrets ever leave the device).
final class PaymentProofTests: XCTestCase {

  // MARK: status badge

  func testStatusBadges() {
    XCTAssertEqual(ProofBadge.status("verified", demo: false).text, "VERIFIED")
    XCTAssertEqual(ProofBadge.status("verified", demo: false).tone, .positive)
    XCTAssertEqual(ProofBadge.status("partially_verified", demo: false).text, "PARTIALLY VERIFIED")
    XCTAssertEqual(ProofBadge.status("pending", demo: false).text, "PENDING")
    XCTAssertEqual(ProofBadge.status("unknown", demo: false).text, "UNKNOWN")
    // Demo always wins — a fixture never shows a live verification badge.
    XCTAssertEqual(ProofBadge.status("verified", demo: true).text, "DEMO DATA")
  }

  // MARK: exposure (inverted — "No" is the good answer)

  func testExposureBadges() {
    XCTAssertEqual(ProofBadge.exposure("no").tone, .positive)
    XCTAssertEqual(ProofBadge.exposure("yes").tone, .danger)
    XCTAssertEqual(ProofBadge.exposure("unknown").tone, .muted)
    XCTAssertEqual(ProofBadge.exposure(nil).text, "Unknown")
  }

  // MARK: per-check badges

  func testCheckBadges() {
    XCTAssertEqual(ProofBadge.check("pass").tone, .positive)
    XCTAssertEqual(ProofBadge.check("fail").tone, .danger)
    XCTAssertEqual(ProofBadge.check("pending").tone, .pending)
    XCTAssertEqual(ProofBadge.check("unavailable").text, "Unavailable")
    XCTAssertEqual(ProofBadge.check("not_configured").text, "Not configured")
    XCTAssertEqual(ProofBadge.check("no", passText: "Yes", failText: "No").tone, .positive)
  }

  // MARK: lenient decoding (unknown evidence type must not break decoding)

  func testDecodesProofWithUnknownEvidenceType() throws {
    let json = """
    {
      "paymentId": "0xabc",
      "kind": "payment",
      "proofStatus": "verified",
      "evidenceLevel": "E3",
      "privacy": { "calldataCheck": "pass", "sensitiveOnchain": "no" },
      "settlement": { "network": "Monad", "txHash": "0x72f", "chainId": "10143" },
      "evidence": [
        { "id": "e1", "type": "transactionReceipt", "status": "pass" },
        { "id": "e2", "type": "somethingBrandNew", "status": "pending" }
      ]
    }
    """.data(using: .utf8)!
    let proof = try JSONDecoder().decode(PrismPaymentProof.self, from: json)
    XCTAssertEqual(proof.proofStatus, "verified")
    XCTAssertEqual(proof.evidence.count, 2)
    XCTAssertEqual(proof.evidence[0].type, .transactionReceipt)
    XCTAssertEqual(proof.evidence[1].type, .unknown) // forward-compatible
    XCTAssertEqual(proof.settlement.chainId, "10143")
  }

  // MARK: shareable proof safety (section 14)

  func testShareProofContainsFactsButNoSecrets() {
    let p = PrismPaymentProof.fixture()
    let text = PaymentProofShare.text(p).lowercased()
    // Useful facts are present.
    XCTAssertTrue(text.contains("paymentid"))
    XCTAssertTrue(text.contains("txhash"))
    XCTAssertTrue(text.contains("proofstatus"))
    XCTAssertTrue(text.contains("evidencelevel"))
    // Secrets and sensitive identifiers never appear.
    for forbidden in ["phone", "otp", "pin", "passkey", "privatekey", "private key", "secret", "+234", "mnemonic"] {
      XCTAssertFalse(text.contains(forbidden), "share proof leaked '\(forbidden)'")
    }
  }

  // MARK: demo fixture

  func testDemoFixtureIsMarkedAndCappedAtE1() {
    let p = PrismPaymentProof.fixture(demo: true)
    XCTAssertTrue(p.demo)
    XCTAssertEqual(p.evidenceLevel, "E1")
    XCTAssertEqual(ProofBadge.status(p.proofStatus, demo: p.demo).text, "DEMO DATA")
  }
}
