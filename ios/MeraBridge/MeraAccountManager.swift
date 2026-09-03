import Foundation

/// App-facing coordinator over a `MeraAccountService`. Owns the active account and the scoped,
/// expiring signing session policy, and exposes hex-encoded signing helpers to `PrismAPI`.
///
/// Session policy (see SECURITY.md):
///  - payment signing may reuse a warm session until it expires (no passkey sheet per tap);
///  - identity/account actions ALWAYS re-authenticate (fresh passkey assertion);
///  - a local PIN / Face ID gate is applied by the caller *before* any signing call.
@MainActor
final class MeraAccountManager: ObservableObject {
  static let shared = MeraAccountManager()

  @Published private(set) var account: PrismMeraAccount?

  private let service: MeraAccountService
  private var sessionScope: MeraSessionScope?
  private var sessionExpiry: Date?

  private init() {
    // Both device and simulator run the official Mera library via the WebView bridge. On device
    // this uses real passkeys; on the simulator it uses the dev-seeded signer (real viem secp256k1,
    // see BUILD.md). DevMeraBridge remains only as a no-bundle fallback.
    service = WKWebViewMeraBridge()
  }

  var accountAddress: String? { account?.address }

  /// Restore the returning user's account, or create one on first run.
  func ensureAccount() async throws -> PrismMeraAccount {
    if let account { return account }
    let acct: PrismMeraAccount
    if let restored = try? await service.restoreAccount() { acct = restored }
    else { acct = try await service.createAccount() }
    account = acct
    return acct
  }

  func createAccount() async throws -> PrismMeraAccount {
    let acct = try await service.createAccount()
    account = acct
    return acct
  }

  /// Ensure a valid signing session for `scope`, re-authenticating when policy requires it.
  func beginSession(_ scope: MeraSessionScope) async throws {
    let reuseable = scope == .payments && isSessionValid()
    if reuseable { return }
    try? await service.revokeSession()
    try await service.createSession(MeraSessionOptions(scope: scope))
    sessionScope = scope
    sessionExpiry = Date().addingTimeInterval(scope == .identity ? 60 : 15 * 60)
  }

  func endSession() async {
    try? await service.revokeSession()
    sessionScope = nil
    sessionExpiry = nil
  }

  private func isSessionValid() -> Bool {
    guard let sessionExpiry, sessionScope == .payments else { return false }
    return sessionExpiry > Date()
  }

  // MARK: signing helpers

  func signMessageHex(_ message: String) async throws -> String {
    try await service.signMessage(Data(message.utf8)).hexString
  }

  func signTypedDataHex(_ typedData: Data) async throws -> String {
    try await service.signTypedData(typedData).hexString
  }

  /// Proof of control of `address`, matching the backend's `bind_account` canonical payload.
  func bindingProofHex(for address: String) async throws -> String {
    try await signMessageHex(Self.canonicalJSONString(["action": "bind_account", "account": address.lowercased()]))
  }

  func signCanonicalHex(_ object: [String: Any]) async throws -> String {
    try await signMessageHex(Self.canonicalJSONString(object))
  }

  static func canonicalJSONString(_ object: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
  }
}
