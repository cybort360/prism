import XCTest

@testable import Prism

/// Covers the claim (send-before-signup) presentation logic: the sender's local recipient memory, the
/// safe share invitation, precise failure copy, and the ClaimRecord expiry/display projections.
final class ClaimDisplayTests: XCTestCase {

  private func claim(status: String, expiry: Int, sender: String? = "@octane") -> ClaimRecord {
    ClaimRecord(
      claimId: "0xabc", recipientReference: "0xref", senderPrismId: "sender",
      amountAtomic: "20000000", token: "0xUSDC", tokenSymbol: "USDC", memo: "Dinner",
      expiry: expiry, status: status, senderDisplay: sender)
  }

  // MARK: recipient store (device-only recipient name; never sent to backend / on-chain)

  func testRecipientStoreRoundTrips() {
    let id = "claim-\(UUID().uuidString)"
    ClaimRecipientStore.remember(claimId: id, name: "David")
    XCTAssertEqual(ClaimRecipientStore.name(for: id), "David")
  }

  func testRecipientStoreIgnoresEmpty() {
    ClaimRecipientStore.remember(claimId: "", name: "David")
    ClaimRecipientStore.remember(claimId: "claim-x", name: "")
    XCTAssertNil(ClaimRecipientStore.name(for: "claim-x"))
  }

  // MARK: safe invitation — only the opaque claimId, no phone / wallet / eligibility material

  func testInviteCarriesOnlyOpaqueClaimId() {
    let msg = ClaimInvite.message(senderName: "Octane", amount: "$20.00", claimId: "0xdeadbeef")
    XCTAssertTrue(msg.contains("Octane sent you $20.00"))
    XCTAssertTrue(msg.contains("0xdeadbeef"))
    // No phone number, wallet address, or eligibility token ever appears in the invitation.
    XCTAssertFalse(msg.contains("+"))
    XCTAssertFalse(msg.lowercased().contains("0x0000"))
    XCTAssertEqual(ClaimInvite.link(claimId: "0xdeadbeef"), "https://prism.money/claim/0xdeadbeef")
  }

  func testInviteFallsBackWhenSenderNameMissing() {
    let msg = ClaimInvite.message(senderName: "", amount: "$5.00", claimId: "0x1")
    XCTAssertTrue(msg.hasPrefix("Someone sent you $5.00"))
  }

  // MARK: failure taxonomy → precise consumer copy + honest recovery

  func testWrongIdentityIsNotRetryable() {
    let f = ClaimFailure.classify("claim not eligible for this alias")
    XCTAssertEqual(f.message, "This payment isn't available to this Prism identity.")
    XCTAssertEqual(f.recovery, .none)
  }

  func testAlreadyReceived() {
    let f = ClaimFailure.classify("claim already received")
    XCTAssertEqual(f.message, "This payment has already been received.")
    XCTAssertEqual(f.recovery, .none)
  }

  func testAlreadyReturned() {
    let f = ClaimFailure.classify("claim already returned")
    XCTAssertEqual(f.message, "This payment expired and was returned to the sender.")
    XCTAssertEqual(f.recovery, .none)
  }

  func testNetworkKeepsMoneyProtectedAndOffersRetry() {
    let f = ClaimFailure.classify("The Internet connection appears to be offline.")
    XCTAssertEqual(f.message, "We couldn't finish claiming yet. Your money remains protected.")
    XCTAssertEqual(f.recovery, .tryAgain)
  }

  func testEligibilityLapseOffersVerifyAgain() {
    let f = ClaimFailure.classify("recipient intent signature does not match")
    // A mismatched intent reads as an identity problem, not a transient one.
    XCTAssertEqual(f.recovery, .none)
    let e = ClaimFailure.classify("eligibility window elapsed, please verify")
    XCTAssertEqual(e.message, "Prism needs to verify this claim again.")
    XCTAssertEqual(e.recovery, .verifyAgain)
  }

  // MARK: ClaimRecord projections

  func testExpiryProjection() {
    let past = claim(status: "funded", expiry: Int(Date().timeIntervalSince1970) - 60)
    let future = claim(status: "funded", expiry: Int(Date().timeIntervalSince1970) + 3600)
    XCTAssertTrue(past.isExpired)
    XCTAssertFalse(future.isExpired)
  }

  func testSenderDisplayCarried() {
    XCTAssertEqual(claim(status: "funded", expiry: 0).senderDisplay, "@octane")
  }
}
