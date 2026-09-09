import XCTest
import CryptoKit

@testable import Prism

/// The device P-256 credential (adoption of the on-chain P-256 path). Uses the software credential —
/// the same fallback the app uses in the Simulator, where no Secure Enclave exists. Proves the
/// signature it produces is a real, verifiable P-256 signature over the intent bytes.
final class DeviceP256CredentialTests: XCTestCase {

  func testSignatureVerifiesAgainstTheCredentialsOwnKey() throws {
    let key = P256.Signing.PrivateKey()
    let cred = SoftwareP256Credential(key: key)

    let intent = Data((0..<200).map { _ in UInt8.random(in: 0...255) }) // stand-in for the encoded intent
    let (r, s) = try cred.sign(intent)

    // Reassemble r||s and verify with CryptoKit (which hashes with SHA-256, matching the account).
    let raw = try XCTUnwrap(r.hexData) + (try XCTUnwrap(s.hexData))
    XCTAssertEqual(raw.count, 64, "r||s is 64 bytes")
    let sig = try P256.Signing.ECDSASignature(rawRepresentation: raw)
    XCTAssertTrue(key.publicKey.isValidSignature(sig, for: intent),
      "the device signature verifies against its own P-256 public key")
  }

  func testPublicKeyXYIsTwo32ByteHexCoordinates() {
    let cred = SoftwareP256Credential(key: P256.Signing.PrivateKey())
    let (qx, qy) = cred.publicKeyXY
    XCTAssertTrue(qx.hasPrefix("0x") && qx.count == 66) // 0x + 64 hex nibbles = 32 bytes
    XCTAssertTrue(qy.hasPrefix("0x") && qy.count == 66)
    // The concatenated 0x04 || qx || qy must be a valid uncompressed P-256 point.
    let x963 = Data([0x04]) + (qx.hexData ?? Data()) + (qy.hexData ?? Data())
    XCTAssertNoThrow(try P256.Signing.PublicKey(x963Representation: x963))
    XCTAssertFalse(cred.isSecureEnclave, "software fallback is not Secure Enclave")
  }

  func testTamperedDataFailsVerification() throws {
    let key = P256.Signing.PrivateKey()
    let cred = SoftwareP256Credential(key: key)
    let intent = Data("pay 1 USDC to 0xabc".utf8)
    let (r, s) = try cred.sign(intent)
    let sig = try P256.Signing.ECDSASignature(rawRepresentation: (try XCTUnwrap(r.hexData)) + (try XCTUnwrap(s.hexData)))
    var tampered = intent; tampered[0] ^= 0x01
    XCTAssertFalse(key.publicKey.isValidSignature(sig, for: tampered), "a signature must not verify over mutated data")
  }
}
