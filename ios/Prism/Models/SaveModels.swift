import Foundation

// Prism Save — client models + the independent plan verifier.
//
// The backend hands the phone a SaveExecutionPlan inside a quote. The client NEVER trusts it blindly: it
// re-verifies the plan against the app's OWN known substrate addresses (`SaveSubstrate`) and the amount
// the user actually entered. A plan only clears when every call targets an allowlisted contract, moves
// only USDC→AUSD→earnAUSD, sends shares to the user's own account, has real minimums + a future deadline,
// and uses no unlimited approval, arbitrary recipient, arbitrary call, or native MON transfer.
//
// All monetary values are integer base-unit strings. Never a Double.

/// The substrate the client independently trusts — compiled in, not taken from the server. Matches
/// backend config.save. earnAUSD/AUSD are Monad mainnet (143); swapRouter is empty until a route is proven.
enum SaveSubstrate {
  static let chainId = 143
  static let usdc = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"
  static let ausd = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"
  static let earnAusdVault = "0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA"
  static let swapRouter = ""   // no proven USDC→AUSD route yet
}

struct SaveQuoteBody: Encodable { let amountAtomic: String }

struct SaveRate: Codable, Equatable {
  let available: Bool
  let apyBps: Int?
  let reason: String?
}

struct SavePosition: Codable, Equatable {
  let shares: String
  let valueAtomic: String
  let currency: String
}

struct SaveState: Codable, Equatable {
  let enabled: Bool
  let live: Bool
  let substrateVerified: Bool
  let notLiveReason: String?
  let position: SavePosition
  let rate: SaveRate
}

struct SaveCall: Codable, Equatable {
  let kind: String
  let target: String
  var spender: String? = nil
  var amount: String? = nil
  var receiver: String? = nil
  var value: String? = nil
}

struct SaveLeg: Codable, Equatable { let token: String; var amount: String? = nil; var minAmount: String? = nil }
struct SaveOutput: Codable, Equatable { let vault: String; let receiver: String; let minShares: String? }

struct SaveExecutionPlan: Codable, Equatable {
  let chainId: Int
  let account: String
  let input: SaveLeg
  let intermediate: SaveLeg
  let output: SaveOutput
  let deadline: Int
  let calls: [SaveCall]
  let preview: Bool?
  let executable: Bool?
}

struct SaveQuote: Codable, Equatable {
  let quoteId: String
  let provider: String
  let live: Bool
  let substrateVerified: Bool
  let notLiveReason: String?
  let expiresAt: String
  let inputAsset: String
  let inputAmount: String
  let intermediateAsset: String
  let estimatedAUSD: String
  let vault: String
  let networkFeeSponsored: Bool
  let rate: SaveRate
  let transactionPlan: SaveExecutionPlan
  let planExecutable: Bool
}

enum SavePlan {
  /// Independent client verification. Returns the violations found; empty ⇒ safe to execute.
  static func verify(_ plan: SaveExecutionPlan, expectedInputAmount: String, account: String) -> [String] {
    var v: [String] = []
    let usdc = SaveSubstrate.usdc.lowercased(), ausd = SaveSubstrate.ausd.lowercased()
    let vault = SaveSubstrate.earnAusdVault.lowercased(), router = SaveSubstrate.swapRouter.lowercased()
    let acct = account.lowercased()
    let allow = Set([usdc, ausd, vault, router].filter { $0.count == 42 })
    let now = Int(Date().timeIntervalSince1970)

    if plan.chainId != SaveSubstrate.chainId { v.append("wrong_chain") }
    if plan.account.lowercased() != acct { v.append("wrong_account") }
    if plan.input.token.lowercased() != usdc { v.append("input_not_usdc") }
    if plan.input.amount != expectedInputAmount { v.append("input_amount_mismatch") }
    if plan.intermediate.token.lowercased() != ausd { v.append("intermediate_not_ausd") }
    if !isPositive(plan.intermediate.minAmount) { v.append("missing_min_ausd") }
    if plan.output.vault.lowercased() != vault { v.append("output_not_earnausd") }
    if plan.output.receiver.lowercased() != acct { v.append("output_receiver_not_user") }
    if !isPositive(plan.output.minShares) { v.append("missing_min_shares") }
    if plan.deadline <= now { v.append("missing_or_past_deadline") }
    if plan.calls.isEmpty { v.append("no_calls") }
    for (i, c) in plan.calls.enumerated() {
      if !allow.contains(c.target.lowercased()) { v.append("call_\(i)_target_not_allowlisted") }
      if let value = c.value, value != "0" { v.append("call_\(i)_native_value") }
      if c.kind == "usdc-approve" || c.kind == "ausd-approve" {
        let token = c.kind == "usdc-approve" ? usdc : ausd
        if c.target.lowercased() != token { v.append("call_\(i)_approve_wrong_token") }
        if c.spender?.lowercased() != router && c.spender?.lowercased() != vault { v.append("call_\(i)_approve_unknown_spender") }
        if c.amount == maxUint256 { v.append("call_\(i)_unlimited_approval") }
      }
      if c.kind == "vault-deposit", (c.receiver ?? plan.output.receiver).lowercased() != acct { v.append("call_\(i)_deposit_receiver_not_user") }
    }
    return v
  }

  private static let maxUint256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935"
  private static func isPositive(_ atomic: String?) -> Bool {
    guard let a = atomic, !a.isEmpty, a.allSatisfy(\.isNumber) else { return false }
    return a.contains(where: { $0 != "0" })
  }
}
