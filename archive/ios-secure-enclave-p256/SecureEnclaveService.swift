import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Owns Prism's spending credential. On real iPhones the private key is Secure-Enclave
/// backed. Simulator builds use a Keychain-stored software P-256 key so the complete UI
/// can be exercised without weakening device builds.
final class SecureEnclaveService: @unchecked Sendable {
  static let shared = SecureEnclaveService()
  private let storageKey = "p256.signing-key.data"
  private init() {}

  func ensureKey() throws -> DevicePublicKey {
    #if targetEnvironment(simulator)
      let key = try loadOrCreateSimulatorKey()
      return try coordinates(key.publicKey.x963Representation)
    #else
      let key = try loadOrCreateSecureKey()
      return try coordinates(key.publicKey.x963Representation)
    #endif
  }

  func sign(hex32: String, authenticationContext: LAContext? = nil) throws -> String {
    guard let data = hex32.hexData, data.count == 32 else { throw SecureKeyError.digest }
    #if targetEnvironment(simulator)
      return try loadOrCreateSimulatorKey().signature(for: data).rawRepresentation.hexString
    #else
      guard let repr = try KeychainStore.shared.data(for: storageKey) else {
        throw SecureKeyError.missing
      }
      let key = try SecureEnclave.P256.Signing.PrivateKey(
        dataRepresentation: repr, authenticationContext: authenticationContext)
      return try key.signature(for: data).rawRepresentation.hexString
    #endif
  }

  func sign(data: Data) throws -> String {
    #if targetEnvironment(simulator)
      return try loadOrCreateSimulatorKey().signature(for: data).rawRepresentation.hexString
    #else
      return try loadOrCreateSecureKey().signature(for: data).rawRepresentation.hexString
    #endif
  }

  func makeReplacementKey() throws -> (publicKey: DevicePublicKey, privateRepresentation: Data) {
    #if targetEnvironment(simulator)
      let key = P256.Signing.PrivateKey(compactRepresentable: true)
      return (try coordinates(key.publicKey.x963Representation), key.rawRepresentation)
    #else
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], nil)!
      let key = try SecureEnclave.P256.Signing.PrivateKey(
        compactRepresentable: true, accessControl: access)
      return (try coordinates(key.publicKey.x963Representation), key.dataRepresentation)
    #endif
  }

  /// Persist a replacement only after the onchain key-rotation operation has reconciled.
  func installReplacement(_ representation: Data) throws {
    try KeychainStore.shared.set(representation, for: storageKey)
  }

  private func coordinates(_ raw: Data) throws -> DevicePublicKey {
    guard raw.count == 65, raw.first == 0x04 else { throw SecureKeyError.publicKey }
    return DevicePublicKey(qx: Data(raw[1...32]).hexString, qy: Data(raw[33...64]).hexString)
  }

  #if targetEnvironment(simulator)
    private func loadOrCreateSimulatorKey() throws -> P256.Signing.PrivateKey {
      if let repr = try KeychainStore.shared.data(for: storageKey) {
        return try P256.Signing.PrivateKey(rawRepresentation: repr)
      }
      let key = P256.Signing.PrivateKey(compactRepresentable: true)
      try KeychainStore.shared.set(key.rawRepresentation, for: storageKey)
      return key
    }
  #else
    private func loadOrCreateSecureKey() throws -> SecureEnclave.P256.Signing.PrivateKey {
      if let repr = try KeychainStore.shared.data(for: storageKey) {
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: repr)
      }
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], nil)!
      let key = try SecureEnclave.P256.Signing.PrivateKey(
        compactRepresentable: true, accessControl: access)
      try KeychainStore.shared.set(key.dataRepresentation, for: storageKey)
      return key
    }
  #endif
}

enum SecureKeyError: LocalizedError {
  case publicKey, digest, missing
  var errorDescription: String? {
    switch self {
    case .publicKey: "Invalid P-256 public key."
    case .digest: "Expected a 32-byte UserOperation hash."
    case .missing: "Prism signing key is missing."
    }
  }
}
