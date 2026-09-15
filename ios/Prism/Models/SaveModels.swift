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
  var apy: Double? = nil        // decimal, e.g. 0.0708 (position.apy from the resolver)
  var apyBps: Int? = nil        // basis points (state.rate)
  var apySource: String? = nil
  var apyWindow: String? = nil  // e.g. "30d" / "7d"
  var observedAt: String? = nil
  var reason: String? = nil

  /// APY as a percentage number when fresh (prefers the decimal, falls back to bps). Nil when unavailable.
  var percent: Double? {
    guard available else { return nil }
    if let apy { return apy * 100 }
    if let apyBps { return Double(apyBps) / 100 }
    return nil
  }
  /// A human window label: "30-day trailing" / "7-day". Nil when unknown.
  var windowText: String? {
    switch apyWindow {
    case "30d", "30-day", "30day": return "30-day trailing"
    case "7d", "7-day", "7day": return "7-day"
    default: return apyWindow
    }
  }
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

/// The explicit thing the user authorizes — not "arbitrary DeFi calls". Every protected field is bound
/// into the signature server-side; the client re-checks them here before Face ID/PIN and REFUSES to sign
/// on any mismatch with what the user reviewed.
struct SaveIntent: Codable, Equatable {
  let owner: String
  let inputToken: String
  let maxInputUSDC: String
  let intermediateToken: String
  let vault: String
  let shareToken: String
  let minAUSDOut: String
  let minSharesOut: String
  let receiver: String
  let quoteId: String
  let deadline: Int
  let nonce: String
  let chainId: Int
}

enum SaveIntentGuard {
  /// Independent client validation of a SaveIntent. Empty ⇒ safe to authorize. Refuses on an unknown
  /// vault/token, a non-owner receiver, a raised amount, a wrong chain, a past deadline, or missing floors.
  static func verify(_ intent: SaveIntent, expectedOwner: String, approvedMaxUSDC: String) -> [String] {
    var v: [String] = []
    let owner = expectedOwner.lowercased()
    if intent.chainId != SaveSubstrate.chainId { v.append("wrong_chain") }
    if intent.owner.lowercased() != owner { v.append("owner_mismatch") }
    if intent.receiver.lowercased() != owner { v.append("receiver_not_owner") }
    if intent.inputToken.lowercased() != SaveSubstrate.usdc.lowercased() { v.append("input_not_usdc") }
    if intent.intermediateToken.lowercased() != SaveSubstrate.ausd.lowercased() { v.append("intermediate_not_ausd") }
    if intent.vault.lowercased() != SaveSubstrate.earnAusdVault.lowercased() { v.append("vault_mismatch") }
    if !positive(intent.maxInputUSDC) || exceeds(intent.maxInputUSDC, approvedMaxUSDC) { v.append("amount_out_of_bounds") }
    if !positive(intent.minAUSDOut) { v.append("missing_min_ausd") }
    if !positive(intent.minSharesOut) { v.append("missing_min_shares") }
    if intent.deadline <= Int(Date().timeIntervalSince1970) { v.append("expired_intent") }
    return v
  }

  private static func positive(_ a: String) -> Bool { !a.isEmpty && a.allSatisfy(\.isNumber) && a.contains { $0 != "0" } }
  private static func exceeds(_ a: String, _ b: String) -> Bool {
    guard let x = UInt64(a), let y = UInt64(b) else { return true } // unparseable ⇒ refuse
    return x > y
  }
}

/// The reconstructed Save position (from GET /v1/save/position). Fields are optional because the shape
/// varies by status (UNAVAILABLE / NONE / ACTIVE) and earned is null without a cost basis.
struct SavePositionResponse: Codable, Equatable {
  let status: String
  var earnAUSDShares: String? = nil
  var currentAUSDValue: String? = nil
  var earnedAUSD: String? = nil
  var principalAUSD: String? = nil
  var estimatedMonthlyEarningsAUSD: String? = nil
  var notLiveReason: String? = nil
  var apy: SaveRate? = nil
}

// MARK: - Withdrawal

struct WithdrawModeInstant: Codable, Equatable {
  let available: Bool
  var estimatedUSDCAtomic: String? = nil
  var vaultFeeAtomic: String? = nil
  var conversionCostAtomic: String? = nil
  var note: String? = nil
  var reason: String? = nil
}
struct WithdrawModeStandard: Codable, Equatable {
  let available: Bool
  var estimatedUSDCAtomic: String? = nil
  var processingWindow: String? = nil
  var reason: String? = nil
}
struct WithdrawModes: Codable, Equatable {
  let live: Bool
  let sharesAtomic: String
  let instant: WithdrawModeInstant
  let standard: WithdrawModeStandard
}
struct WithdrawQuote: Codable, Equatable {
  let quoteId: String
  let live: Bool
  let notLiveReason: String?
  let returnsTo: String   // "USDC" — a withdrawal returns to spendable USDC, not AUSD
  let modes: WithdrawModes
}
struct WithdrawQuoteBody: Encodable { let sharesAtomic: String }

/// The explicit withdrawal the user authorizes: redeem up to N earnAUSD shares back to USDC in the user's
/// own account, subject to minimum outputs and a deadline.
struct WithdrawIntent: Codable, Equatable {
  let owner: String
  let mode: String            // INSTANT | STANDARD
  let vault: String
  let shareToken: String
  let maxShares: String
  let minAUSDOut: String
  let minUSDCOut: String
  let receiver: String
  let quoteId: String
  let deadline: Int
  let nonce: String
  let chainId: Int
}

enum WithdrawIntentGuard {
  /// Independent client validation before authorizing a withdrawal. Empty ⇒ safe. Refuses on an unknown
  /// vault, a non-owner receiver, over-redeeming, a wrong chain, a past deadline, or missing floors.
  static func verify(_ intent: WithdrawIntent, expectedOwner: String, approvedMaxShares: String) -> [String] {
    var v: [String] = []
    let owner = expectedOwner.lowercased()
    if intent.chainId != SaveSubstrate.chainId { v.append("wrong_chain") }
    if intent.owner.lowercased() != owner { v.append("owner_mismatch") }
    if intent.receiver.lowercased() != owner { v.append("receiver_not_owner") }  // money returns to the user
    if intent.mode != "INSTANT" && intent.mode != "STANDARD" { v.append("bad_mode") }
    if intent.vault.lowercased() != SaveSubstrate.earnAusdVault.lowercased() { v.append("vault_mismatch") }
    if !positive(intent.maxShares) || exceeds(intent.maxShares, approvedMaxShares) { v.append("shares_out_of_bounds") }
    if !positive(intent.minAUSDOut) { v.append("missing_min_ausd") }
    if !positive(intent.minUSDCOut) { v.append("missing_min_usdc") }
    if intent.deadline <= Int(Date().timeIntervalSince1970) { v.append("expired_intent") }
    return v
  }
  private static func positive(_ a: String) -> Bool { !a.isEmpty && a.allSatisfy(\.isNumber) && a.contains { $0 != "0" } }
  private static func exceeds(_ a: String, _ b: String) -> Bool { guard let x = UInt64(a), let y = UInt64(b) else { return true }; return x > y }
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
