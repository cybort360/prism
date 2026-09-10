import XCTest

@testable import Prism

/// The consumer send flow must never surface chain infrastructure (MON, gas, relayer, RPC, 0x,
/// UserOperation/EntryPoint) — payments are sponsored, so those are never actionable to the payer.
/// Genuinely actionable errors (balance, PIN) must pass through unchanged.
final class PaymentErrorSanitizationTests: XCTestCase {
  private func message(_ raw: String) -> String {
    PaymentCoordinator.friendlyMessage(for: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: raw]))
  }
  private let generic = "The payment couldn't be completed just now. Check Activity before sending it again."

  func testInfrastructureTermsAreNeverShown() {
    let leaky = [
      "insufficient MON for gas",
      "MON balance too low",          // leading term (previously slipped through)
      "insufficient gas",             // bare "gas" (previously slipped through)
      "gas limit reached",
      "out of gas",
      "relayer rejected the transaction",
      "execution reverted 0xabc123",
      "UserOperation failed at the EntryPoint",
      "monad testnet RPC timeout",
      "invalid nonce",
      "ERC-3009 authorization used",
    ]
    for raw in leaky {
      XCTAssertEqual(message(raw), generic, "must hide infrastructure detail: \(raw)")
    }
  }

  func testActionableMessagesPassThrough() {
    XCTAssertEqual(message("Insufficient USDC balance"), "Insufficient USDC balance")
    // "money" contains the letters m-o-n but must NOT be caught by the MON guard.
    XCTAssertEqual(message("Not enough money in your account"), "Not enough money in your account")
    XCTAssertEqual(message("This request has expired"), "This request has expired")
  }

  func testKnownPaymentErrorsKeepTheirFriendlyText() {
    XCTAssertEqual(PaymentCoordinator.friendlyMessage(for: PaymentError.badPIN), "That PIN doesn't match. Try again.")
    XCTAssertEqual(PaymentCoordinator.friendlyMessage(for: PaymentError.failed), "The payment couldn't be completed.")
  }
}
