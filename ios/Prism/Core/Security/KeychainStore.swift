import Foundation
import Security

final class KeychainStore: @unchecked Sendable {
  static let shared = KeychainStore()
  private init() {}
  func set(_ data: Data, for key: String) throws {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.prism.mobile",
      kSecAttrAccount as String: key,
    ]
    SecItemDelete(base as CFDictionary)
    var query = base
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.write(status) }
  }
  func data(for key: String) throws -> Data? {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.prism.mobile",
      kSecAttrAccount as String: key, kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw KeychainError.read(status) }
    return data
  }
  func setString(_ value: String, for key: String) throws { try set(Data(value.utf8), for: key) }
  func string(for key: String) throws -> String? {
    guard let d = try data(for: key) else { return nil }
    return String(data: d, encoding: .utf8)
  }
  func delete(_ key: String) {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.prism.mobile",
      kSecAttrAccount as String: key,
    ]
    SecItemDelete(q as CFDictionary)
  }
}
/// Carries the OSStatus. Collapsing every failure into a bare case cost three CI runs to diagnose
/// what `errSecMissingEntitlement` would have said immediately.
enum KeychainError: LocalizedError {
  case write(OSStatus)
  case read(OSStatus)

  var errorDescription: String? {
    switch self {
    case .write(let status): "Couldn't save to the keychain (\(Self.describe(status)))."
    case .read(let status): "Couldn't read from the keychain (\(Self.describe(status)))."
    }
  }

  private static func describe(_ status: OSStatus) -> String {
    if let message = SecCopyErrorMessageString(status, nil) as String? { return "\(message) [\(status)]" }
    return "OSStatus \(status)"
  }
}
