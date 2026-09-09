import CryptoKit
import Foundation

/// A device-backed **P-256 (secp256r1)** signing credential — the on-chain spending authority of a
/// `PrismP256Account`. On real hardware this is a **Secure Enclave** key; where the Secure Enclave is
/// unavailable (Simulator / CI) it falls back to a **clearly-labeled software key** (dev only — never a
/// fake signature; it is a real P-256 signature from a software key). CryptoKit applies SHA-256 before
/// ECDSA, so a signature over the raw intent bytes matches the account's on-chain `sha256(intent)`
/// verification via Monad's RIP-7212 precompile. (Distinct from Mera, which signs secp256k1.)
protocol DeviceP256Credential {
  /// Uncompressed public-key coordinates, each 0x-prefixed 32-byte hex — used to bind a PrismP256Account.
  var publicKeyXY: (qx: String, qy: String) { get }
  /// Sign the raw intent bytes; returns the ECDSA (r, s) as 0x-hex. Monad's precompile accepts any valid
  /// s (verified live), so no low-s normalization is required.
  func sign(_ data: Data) throws -> (r: String, s: String)
  /// True on real Secure Enclave hardware; false for the software dev fallback.
  var isSecureEnclave: Bool { get }
}

private func splitXY(_ rawPublicKey: Data) -> (String, String) {
  // rawRepresentation is the 64-byte uncompressed point: qx (32) || qy (32).
  (Data(rawPublicKey.prefix(32)).hexString, Data(rawPublicKey.suffix(32)).hexString)
}
private func splitRS(_ rawSignature: Data) -> (String, String) {
  // ECDSASignature.rawRepresentation is r (32) || s (32).
  (Data(rawSignature.prefix(32)).hexString, Data(rawSignature.suffix(32)).hexString)
}

/// Secure Enclave (hardware) P-256 credential — real devices.
struct SecureEnclaveP256Credential: DeviceP256Credential {
  let key: SecureEnclave.P256.Signing.PrivateKey
  var isSecureEnclave: Bool { true }
  var publicKeyXY: (qx: String, qy: String) { splitXY(key.publicKey.rawRepresentation) }
  func sign(_ data: Data) throws -> (r: String, s: String) { splitRS(try key.signature(for: data).rawRepresentation) }
}

/// Software P-256 credential — the dev/CI fallback where no Secure Enclave exists. Clearly labeled.
struct SoftwareP256Credential: DeviceP256Credential {
  let key: P256.Signing.PrivateKey
  var isSecureEnclave: Bool { false }
  var publicKeyXY: (qx: String, qy: String) { splitXY(key.publicKey.rawRepresentation) }
  func sign(_ data: Data) throws -> (r: String, s: String) { splitRS(try key.signature(for: data).rawRepresentation) }
}

/// Loads (or creates + persists) the device's P-256 credential — Secure Enclave when available, else a
/// software key. The private material lives only in the Keychain; only the public key + signatures leave.
enum DeviceP256CredentialStore {
  private static let seKey = "prism.p256.secureEnclave"
  private static let swKey = "prism.p256.software"

  static func loadOrCreate() -> DeviceP256Credential {
    if SecureEnclave.isAvailable {
      if let d = try? KeychainStore.shared.data(for: seKey),
         let k = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: d) {
        return SecureEnclaveP256Credential(key: k)
      }
      if let k = try? SecureEnclave.P256.Signing.PrivateKey() {
        try? KeychainStore.shared.set(k.dataRepresentation, for: seKey)
        return SecureEnclaveP256Credential(key: k)
      }
    }
    // Dev / Simulator: no Secure Enclave — a real (software) P-256 key, clearly not hardware-backed.
    if let d = try? KeychainStore.shared.data(for: swKey),
       let k = try? P256.Signing.PrivateKey(rawRepresentation: d) {
      return SoftwareP256Credential(key: k)
    }
    let k = P256.Signing.PrivateKey()
    try? KeychainStore.shared.set(k.rawRepresentation, for: swKey)
    return SoftwareP256Credential(key: k)
  }
}
