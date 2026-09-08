import Foundation

/// Private, on-device map of claimId → recipient display name. The backend never learns who a claim
/// is "for" (privacy — no phone/name on-chain); the sender's own device remembers the friendly name
/// so the sender's claim surfaces can say "David" instead of an opaque reference.
enum ClaimRecipientStore {
  private static let key = "prism.claimRecipients"
  private static var map: [String: String] {
    get { (UserDefaults.standard.dictionary(forKey: key) as? [String: String]) ?? [:] }
    set { UserDefaults.standard.set(newValue, forKey: key) }
  }
  static func remember(claimId: String, name: String) {
    guard !claimId.isEmpty, !name.isEmpty else { return }
    var m = map; m[claimId] = name; map = m
  }
  static func name(for claimId: String) -> String? { map[claimId] }
}

/// A safe, shareable claim invitation. Carries only the opaque (random) claimId — never the sender's
/// wallet/address, the claimant's phone, or any eligibility material.
enum ClaimInvite {
  /// Deep link the recipient opens to find their protected payment. claimId is random, not phone-derived.
  static func link(claimId: String) -> String { "https://prism.money/claim/\(claimId)" }

  /// User-facing invitation text. `senderName` is the sender's own public name (safe — it's them).
  static func message(senderName: String, amount: String, claimId: String) -> String {
    let who = senderName.isEmpty ? "Someone" : senderName
    return "\(who) sent you \(amount) on Prism.\nOpen Prism to claim it.\n\(link(claimId: claimId))"
  }
}

/// Maps a backend/network error into precise consumer copy for the claim flow. The money is never at
/// risk on a failed claim (funds stay protected in the vault) — the copy must say so, and only offer
/// a retry when retrying can actually help.
struct ClaimFailure {
  enum Recovery { case none, tryAgain, verifyAgain }
  let message: String
  let recovery: Recovery

  static func classify(_ raw: String) -> ClaimFailure {
    let m = raw.lowercased()
    // Network / offline — the claim never reached Prism; the money is untouched.
    if m.contains("offline") || m.contains("internet") || m.contains("network")
      || m.contains("timed out") || m.contains("connection") || m.contains("still confirming") {
      return .init(message: "We couldn't finish claiming yet. Your money remains protected.", recovery: .tryAgain)
    }
    // The claim isn't meant for this Prism identity.
    if m.contains("not eligible") || m.contains("does not match") || m.contains("belongs to another") {
      return .init(message: "This payment isn't available to this Prism identity.", recovery: .none)
    }
    // Someone already received it, or it already went back to the sender.
    if m.contains("already received") || m.contains("already claimed") {
      return .init(message: "This payment has already been received.", recovery: .none)
    }
    if m.contains("already returned") || m.contains("refunded") {
      return .init(message: "This payment expired and was returned to the sender.", recovery: .none)
    }
    if m.contains("expired") || m.contains("not funded") {
      return .init(message: "This payment has expired and is no longer available to claim.", recovery: .none)
    }
    // Short-lived eligibility lapsed mid-flow — re-verifying re-issues it.
    if m.contains("eligib") || m.contains("intent") || m.contains("verify") {
      return .init(message: "Prism needs to verify this claim again.", recovery: .verifyAgain)
    }
    return .init(message: "We couldn't finish claiming yet. Your money remains protected.", recovery: .tryAgain)
  }
}
