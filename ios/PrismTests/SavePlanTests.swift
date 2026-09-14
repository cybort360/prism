import XCTest

@testable import Prism

/// The client independently verifies the backend's SaveExecutionPlan against the app's OWN known
/// substrate + the amount the user entered. It must accept a well-formed plan and reject every tampering
/// — otherwise the backend could smuggle arbitrary calldata and call it "Save".
final class SavePlanTests: XCTestCase {
  private let account = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
  private var usdc: String { SaveSubstrate.usdc }
  private var ausd: String { SaveSubstrate.ausd }
  private var vault: String { SaveSubstrate.earnAusdVault }

  // A well-formed plan that needs no swap router (direct AUSD→earnAUSD), so it can clear verification
  // even though no swap router is allowlisted yet. Real USDC→AUSD routing waits on a proven route.
  private func plan(
    chainId: Int? = nil, account acc: String? = nil,
    inputToken: String? = nil, inputAmount: String = "1000000",
    interToken: String? = nil, minAusd: String = "990000",
    vaultAddr: String? = nil, receiver: String? = nil, minShares: String = "980000",
    deadlineOffset: Int = 300, calls: [SaveCall]? = nil
  ) -> SaveExecutionPlan {
    let acct = acc ?? account
    return SaveExecutionPlan(
      chainId: chainId ?? SaveSubstrate.chainId, account: acct,
      input: SaveLeg(token: inputToken ?? usdc, amount: inputAmount),
      intermediate: SaveLeg(token: interToken ?? ausd, minAmount: minAusd),
      output: SaveOutput(vault: vaultAddr ?? vault, receiver: receiver ?? acct, minShares: minShares),
      deadline: Int(Date().timeIntervalSince1970) + deadlineOffset,
      calls: calls ?? [
        SaveCall(kind: "ausd-approve", target: ausd, spender: vault, amount: minAusd, value: "0"),
        SaveCall(kind: "vault-deposit", target: vault, receiver: acct, value: "0")
      ],
      preview: false, executable: true)
  }

  func testAcceptsAWellFormedPlan() {
    let v = SavePlan.verify(plan(), expectedInputAmount: "1000000", account: account)
    XCTAssertEqual(v, [], "a good plan must verify clean")
  }

  func testRejectsEveryTampering() {
    let dead = "0xdead000000000000000000000000000000000000"
    XCTAssertFalse(SavePlan.verify(plan(chainId: 1), expectedInputAmount: "1000000", account: account).isEmpty)
    XCTAssertFalse(SavePlan.verify(plan(account: dead), expectedInputAmount: "1000000", account: account).isEmpty)
    XCTAssertFalse(SavePlan.verify(plan(inputToken: ausd), expectedInputAmount: "1000000", account: account).isEmpty)
    XCTAssertFalse(SavePlan.verify(plan(inputAmount: "2000000"), expectedInputAmount: "1000000", account: account).isEmpty)
    XCTAssertFalse(SavePlan.verify(plan(interToken: usdc), expectedInputAmount: "1000000", account: account).isEmpty)
    XCTAssertFalse(SavePlan.verify(plan(vaultAddr: dead), expectedInputAmount: "1000000", account: account).isEmpty)
    XCTAssertFalse(SavePlan.verify(plan(receiver: dead), expectedInputAmount: "1000000", account: account).isEmpty)
    XCTAssertFalse(SavePlan.verify(plan(minShares: "0"), expectedInputAmount: "1000000", account: account).isEmpty)
    XCTAssertFalse(SavePlan.verify(plan(deadlineOffset: -10), expectedInputAmount: "1000000", account: account).isEmpty)
    // unlimited approval
    let unlimited = plan(calls: [
      SaveCall(kind: "ausd-approve", target: ausd, spender: vault,
               amount: "115792089237316195423570985008687907853269984665640564039457584007913129639935", value: "0"),
      SaveCall(kind: "vault-deposit", target: vault, receiver: account, value: "0")
    ])
    XCTAssertFalse(SavePlan.verify(unlimited, expectedInputAmount: "1000000", account: account).isEmpty)
    // native MON value
    let native = plan(calls: [SaveCall(kind: "vault-deposit", target: vault, receiver: account, value: "1")])
    XCTAssertFalse(SavePlan.verify(native, expectedInputAmount: "1000000", account: account).isEmpty)
    // arbitrary external call
    let foreign = plan(calls: [SaveCall(kind: "swap", target: "0xc0ffee0000000000000000000000000000000000", value: "0")])
    XCTAssertFalse(SavePlan.verify(foreign, expectedInputAmount: "1000000", account: account).isEmpty)
  }
}
