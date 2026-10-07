import CryptoKit
import Foundation
import Security

/// Local six-digit approval PIN. It is deliberately not a signing key.
/// The verifier is stored only in device-bound Keychain and is stretched with
/// PBKDF2-HMAC-SHA256 so a Keychain extraction does not reduce immediately to a
/// raw six-digit SHA-256 table. Online guessing is additionally rate-limited.
final class PINService: @unchecked Sendable {
  static let shared = PINService()
  private let defaults = UserDefaults.standard
  private let iterations = 30_000
  private init() {}

  func set(_ pin: String) throws {
    guard pin.count == 6, pin.allSatisfy(\.isNumber) else { throw PINError.invalid }
    var salt = Data(count: 32)
    let status = salt.withUnsafeMutableBytes { bytes in
      SecRandomCopyBytes(kSecRandomDefault, 32, bytes.baseAddress!)
    }
    guard status == errSecSuccess else { throw PINError.storage }

    let digest = pbkdf2(pin: pin, salt: salt, iterations: iterations)
    try KeychainStore.shared.set(salt, for: "pin.salt")
    try KeychainStore.shared.set(digest, for: "pin.digest")
    try KeychainStore.shared.setString(String(iterations), for: "pin.iterations")
    defaults.set(2, forKey: "pin.kdfVersion")
    setCounter(0, "pin.failures")
    setLockedUntil(nil)
  }

  func verify(_ pin: String) throws -> Bool {
    if let until = lockedUntil(), until > Date() {
      throw PINError.locked(until)
    }
    guard pin.count == 6, pin.allSatisfy(\.isNumber) else { return try failedAttempt() }
    guard let salt = try KeychainStore.shared.data(for: "pin.salt"),
      let expected = try KeychainStore.shared.data(for: "pin.digest")
    else { throw PINError.notSet }

    let version = defaults.integer(forKey: "pin.kdfVersion")
    let actual: Data
    if version >= 2 {
      let configured = Int((try? KeychainStore.shared.string(for: "pin.iterations")) ?? "") ?? iterations
      actual = pbkdf2(pin: pin, salt: salt, iterations: min(max(configured, 10_000), 250_000))
    } else {
      // One-time compatibility with early development builds. A successful check
      // immediately migrates the PIN to the stretched format.
      actual = Data(SHA256.hash(data: salt + Data(pin.utf8)))
    }

    if constantTimeEqual(actual, expected) {
      setCounter(0, "pin.failures")
      setLockedUntil(nil)
      if version < 2 { try? set(pin) }
      return true
    }
    return try failedAttempt()
  }

  private func failedAttempt() throws -> Bool {
    let failures = counter("pin.failures") + 1
    setCounter(failures, "pin.failures")
    if failures >= 5 {
      // Keep increasing the cool-down for repeated lockouts without making an
      // accidental typo permanently destructive.
      let previousLockouts = counter("pin.lockouts") + 1
      setCounter(previousLockouts, "pin.lockouts")
      let seconds = min(30 * 60, 5 * 60 * previousLockouts)
      let until = Date().addingTimeInterval(TimeInterval(seconds))
      setLockedUntil(until)
      setCounter(0, "pin.failures")
      throw PINError.locked(until)
    }
    return false
  }

  // Lockout state (failures / lockouts / lockedUntil) lives in the device-bound Keychain, not
  // UserDefaults: a device backup or a `defaults` wipe must not be able to reset the online-guessing
  // throttle (audit P1.1). `pin.kdfVersion` deliberately stays in UserDefaults — it is not a lockout
  // counter, and clearing it only forces a fail-closed KDF mismatch, never a bypass. On upgrade from a
  // build that stored these in UserDefaults, the counters read as absent once (a one-time throttle
  // reset); every lockout taken afterwards is backup-durable.
  private func counter(_ key: String) -> Int { Int((try? KeychainStore.shared.string(for: key)) ?? "") ?? 0 }
  private func setCounter(_ value: Int, _ key: String) { try? KeychainStore.shared.setString(String(value), for: key) }
  private func lockedUntil() -> Date? {
    guard let raw = try? KeychainStore.shared.string(for: "pin.lockedUntil"), let t = TimeInterval(raw) else { return nil }
    return Date(timeIntervalSince1970: t)
  }
  private func setLockedUntil(_ date: Date?) {
    if let date { try? KeychainStore.shared.setString(String(date.timeIntervalSince1970), for: "pin.lockedUntil") }
    else { KeychainStore.shared.delete("pin.lockedUntil") }
  }

  private func pbkdf2(pin: String, salt: Data, iterations: Int) -> Data {
    let key = SymmetricKey(data: Data(pin.utf8))
    var firstInput = Data(salt)
    firstInput.append(contentsOf: [0, 0, 0, 1]) // PBKDF2 block index 1, big-endian.

    var u = Data(HMAC<SHA256>.authenticationCode(for: firstInput, using: key))
    var output = [UInt8](u)
    if iterations > 1 {
      for _ in 1..<iterations {
        u = Data(HMAC<SHA256>.authenticationCode(for: u, using: key))
        let block = [UInt8](u)
        for index in output.indices { output[index] ^= block[index] }
      }
    }
    return Data(output)
  }

  private func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    var diff: UInt8 = 0
    for (a, b) in zip(lhs, rhs) { diff |= a ^ b }
    return diff == 0
  }
}

enum PINError: LocalizedError {
  case invalid, notSet, storage
  case locked(Date)

  var errorDescription: String? {
    switch self {
    case .invalid: "Use exactly six digits."
    case .notSet: "Payment PIN is not set."
    case .storage: "Prism could not protect your payment PIN on this device."
    case .locked(let date):
      "Too many attempts. Try again after \(date.formatted(date: .omitted, time: .shortened))."
    }
  }
}
