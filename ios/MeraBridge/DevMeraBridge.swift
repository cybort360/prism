import Foundation

/// Development / simulator fallback `MeraAccountService`.
///
/// It provides a stable, deterministic dev account address so the full UI is navigable without a
/// physical passkey, but it deliberately does NOT fabricate signatures: signing routes to the
/// on-device Mera bridge (real passkeys) or the dev-seeded WebView signer described in
/// `ios/MeraBridge/web/BUILD.md`. This mirrors Prism's other honest dev adapters — nothing here
/// pretends a real cryptographic authorization occurred.
@MainActor
final class DevMeraBridge: MeraAccountService {
  private let addressKey = "mera.dev.address"

  func createAccount() async throws -> PrismMeraAccount { devAccount() }
  func restoreAccount() async throws -> PrismMeraAccount { devAccount() }

  func signTypedData(_ typedData: Data) async throws -> Data { throw unavailable }
  func signMessage(_ message: Data) async throws -> Data { throw unavailable }
  func createSession(_ options: MeraSessionOptions) async throws {}
  func revokeSession() async throws {}

  private var unavailable: MeraBridgeError {
    .signingUnavailable("Mera signing runs on a device with a passkey, or via the dev-seeded WebView signer (ios/MeraBridge/web/BUILD.md). The simulator dev bridge does not fabricate signatures.")
  }

  private func devAccount() -> PrismMeraAccount {
    if let existing = UserDefaults.standard.string(forKey: addressKey) {
      return PrismMeraAccount(address: existing)
    }
    var bytes = [UInt8](repeating: 0, count: 20)
    for i in 0..<20 { bytes[i] = UInt8.random(in: 0...255) }
    let address = "0x" + bytes.map { String(format: "%02x", $0) }.joined()
    UserDefaults.standard.set(address, forKey: addressKey)
    return PrismMeraAccount(address: address)
  }
}
