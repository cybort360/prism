import XCTest

@testable import Prism

/// The client guard for a WithdrawIntent: accept exactly the withdrawal the user reviewed, and refuse to
/// authorize on any protected-field mismatch (unknown vault, non-owner receiver, over-redeem, wrong
/// chain, expired, missing floors, bad mode).
final class WithdrawIntentGuardTests: XCTestCase {
  private let owner = "0xAbc0000000000000000000000000000000000001"

  private func intent(
    owner o: String? = nil, receiver: String? = nil, mode: String = "INSTANT", vault: String? = nil,
    maxShares: String = "100000000", minAUSDOut: String = "99000000", minUSDCOut: String = "98000000",
    deadlineOffset: Int = 300, chainId: Int? = nil
  ) -> WithdrawIntent {
    let acct = o ?? owner
    return WithdrawIntent(
      owner: acct, mode: mode, vault: vault ?? SaveSubstrate.earnAusdVault, shareToken: SaveSubstrate.earnAusdVault,
      maxShares: maxShares, minAUSDOut: minAUSDOut, minUSDCOut: minUSDCOut, receiver: receiver ?? acct,
      quoteId: "0x" + String(repeating: "11", count: 32), deadline: Int(Date().timeIntervalSince1970) + deadlineOffset,
      nonce: "0x" + String(repeating: "de", count: 32), chainId: chainId ?? SaveSubstrate.chainId)
  }

  func testAcceptsTheReviewedWithdrawal() {
    XCTAssertEqual(WithdrawIntentGuard.verify(intent(), expectedOwner: owner, approvedMaxShares: "100000000"), [])
    XCTAssertEqual(WithdrawIntentGuard.verify(intent(mode: "STANDARD"), expectedOwner: owner, approvedMaxShares: "100000000"), [])
  }

  func testRefusesEveryMismatch() {
    let dead = "0xdead000000000000000000000000000000000000"
    let bad: (WithdrawIntent) -> Void = { XCTAssertFalse(WithdrawIntentGuard.verify($0, expectedOwner: self.owner, approvedMaxShares: "100000000").isEmpty) }
    bad(intent(receiver: dead))      // money would leave the user
    bad(intent(mode: "DRAIN"))       // unknown mode
    bad(intent(vault: dead))         // unknown vault
    bad(intent(maxShares: "200000000")) // over-redeem beyond approved
    bad(intent(minAUSDOut: "0"))
    bad(intent(minUSDCOut: "0"))
    bad(intent(deadlineOffset: -10)) // expired
    bad(intent(chainId: 1))          // wrong chain
    bad(intent(owner: dead))         // owner mismatch
  }
}
