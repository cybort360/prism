import XCTest

@testable import Prism

/// The client signing guard for a SaveIntent: it must accept exactly the intent the user reviewed and
/// refuse to sign on any protected-field mismatch (unknown vault/token, non-owner receiver, raised
/// amount, wrong chain, expired, missing floors).
final class SaveIntentGuardTests: XCTestCase {
  private let owner = "0xAbc0000000000000000000000000000000000001"

  private func intent(
    owner o: String? = nil, receiver: String? = nil, inputToken: String? = nil, intermediateToken: String? = nil,
    vault: String? = nil, maxInputUSDC: String = "500000000", minAUSDOut: String = "495000000",
    minSharesOut: String = "490000000", deadlineOffset: Int = 300, chainId: Int? = nil
  ) -> SaveIntent {
    let acct = o ?? owner
    return SaveIntent(
      owner: acct, inputToken: inputToken ?? SaveSubstrate.usdc, maxInputUSDC: maxInputUSDC,
      intermediateToken: intermediateToken ?? SaveSubstrate.ausd, vault: vault ?? SaveSubstrate.earnAusdVault,
      shareToken: SaveSubstrate.earnAusdVault, minAUSDOut: minAUSDOut, minSharesOut: minSharesOut,
      receiver: receiver ?? acct, quoteId: "0x" + String(repeating: "11", count: 32),
      deadline: Int(Date().timeIntervalSince1970) + deadlineOffset, nonce: "0x" + String(repeating: "de", count: 32),
      chainId: chainId ?? SaveSubstrate.chainId)
  }

  func testAcceptsTheReviewedIntent() {
    XCTAssertEqual(SaveIntentGuard.verify(intent(), expectedOwner: owner, approvedMaxUSDC: "500000000"), [])
  }

  func testRefusesEveryProtectedFieldMismatch() {
    let dead = "0xdead000000000000000000000000000000000000"
    let check: (SaveIntent) -> Void = { XCTAssertFalse(SaveIntentGuard.verify($0, expectedOwner: self.owner, approvedMaxUSDC: "500000000").isEmpty) }
    check(intent(receiver: dead))                 // shares would go to someone else
    check(intent(inputToken: SaveSubstrate.ausd)) // wrong input token
    check(intent(intermediateToken: SaveSubstrate.usdc))
    check(intent(vault: dead))                    // unknown vault
    check(intent(maxInputUSDC: "600000000"))      // raised above what the user approved
    check(intent(minSharesOut: "0"))              // no share floor
    check(intent(minAUSDOut: "0"))
    check(intent(deadlineOffset: -10))            // expired
    check(intent(chainId: 1))                     // wrong chain
    check(intent(owner: dead))                    // owner mismatch
  }
}
