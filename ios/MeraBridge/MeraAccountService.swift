import Foundation

/// A Prism account derived from a Mera passkey. The address is a standard EVM account (secp256k1)
/// that Mera reproduces deterministically from the same passkey across devices. It is both the
/// AUSD-holding account and the signing authority. Prism never sees the passkey or its derived
/// secret — only signatures and this public address cross the bridge.
struct PrismMeraAccount: Equatable {
  let address: String
}

enum MeraSessionScope: String {
  /// Low-risk, high-frequency signing (payment authorizations). May reuse a warm session.
  case payments
  /// High-risk identity/account actions. Always re-authenticates with the passkey.
  case identity
}

struct MeraSessionOptions {
  var scope: MeraSessionScope = .payments
  /// Sessions are always scoped and always expire; a warm key is zeroed when the session ends.
  var ttlSeconds: TimeInterval = 15 * 60
}

enum MeraBridgeError: LocalizedError {
  case notReady
  case noAccount
  case sessionExpired
  case signingUnavailable(String)
  case bridge(String)

  var errorDescription: String? {
    switch self {
    case .notReady: return "The Mera account bridge is not ready yet."
    case .noAccount: return "No Mera account is available on this device."
    case .sessionExpired: return "Your signing session expired. Confirm with Face ID or PIN again."
    case .signingUnavailable(let why): return why
    case .bridge(let message): return message
    }
  }
}

/// The narrow, official-shaped surface Prism uses around the Mera library. Implementations wrap the
/// official `@category-labs/mera` package; Prism never re-implements Mera's derivation or signing.
/// MainActor-isolated: the WebView-hosted bridge and its UI-thread callers all live on the main actor.
@MainActor
protocol MeraAccountService: AnyObject {
  /// Create a brand-new passkey and derive its account (a passkey creation prompt).
  func createAccount() async throws -> PrismMeraAccount
  /// Re-derive the account from an existing passkey (a passkey assertion prompt).
  func restoreAccount() async throws -> PrismMeraAccount
  /// Sign an EIP-712 typed-data payload (JSON bytes) — used for AUSD ERC-3009 authorizations.
  func signTypedData(_ typedData: Data) async throws -> Data
  /// Sign a personal message (EIP-191) — used for identity binding/mutation proofs.
  func signMessage(_ message: Data) async throws -> Data
  /// Open a scoped, expiring signing session so routine signing needs no passkey sheet each time.
  func createSession(_ options: MeraSessionOptions) async throws
  /// End the current session and zero its warm key.
  func revokeSession() async throws
}
