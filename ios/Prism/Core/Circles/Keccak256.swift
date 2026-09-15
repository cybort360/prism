import Foundation

/// Keccak-256 — the hash Ethereum and Safe use, which is *not* the same as SHA3-256.
///
/// They differ only in the padding byte (Keccak pads with `0x01`, FIPS-202 SHA-3 with `0x06`),
/// which is exactly the kind of difference that produces a plausible-looking wrong answer. Prism
/// needs this on-device because the phone must be able to recompute a Safe transaction hash for
/// itself instead of trusting the one the backend sends; CryptoKit ships SHA-2 and SHA-3 but no
/// Keccak-256, so there is nothing here to delegate to.
///
/// Correctness is pinned by `CircleSafeTxHashTests`, which checks the empty-string and `abc`
/// vectors and then every Safe digest against hashes produced by a real Safe on Monad.
enum Keccak256 {
  private static let roundConstants: [UInt64] = [
    0x0000_0000_0000_0001, 0x0000_0000_0000_8082, 0x8000_0000_0000_808a, 0x8000_0000_8000_8000,
    0x0000_0000_0000_808b, 0x0000_0000_8000_0001, 0x8000_0000_8000_8081, 0x8000_0000_0000_8009,
    0x0000_0000_0000_008a, 0x0000_0000_0000_0088, 0x0000_0000_8000_8009, 0x0000_0000_8000_000a,
    0x0000_0000_8000_808b, 0x8000_0000_0000_008b, 0x8000_0000_0000_8089, 0x8000_0000_0000_8003,
    0x8000_0000_0000_8002, 0x8000_0000_0000_0080, 0x0000_0000_0000_800a, 0x8000_0000_8000_000a,
    0x8000_0000_8000_8081, 0x8000_0000_0000_8080, 0x0000_0000_8000_0001, 0x8000_0000_8000_8008,
  ]

  private static let rotationOffsets: [Int] = [
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
  ]

  /// Rate in bytes for a 256-bit digest: 1600 bits of state minus 512 bits of capacity.
  private static let rate = 136

  static func hash(_ message: Data) -> Data {
    var state = [UInt64](repeating: 0, count: 25)

    // Multi-rate padding: 0x01 ... 0x80, collapsing to a single 0x81 when only one byte is free.
    var padded = message
    let padLength = rate - (message.count % rate)
    padded.append(0x01)
    padded.append(contentsOf: [UInt8](repeating: 0, count: padLength - 1))
    padded[padded.count - 1] |= 0x80

    padded.withUnsafeBytes { raw in
      for blockStart in stride(from: 0, to: padded.count, by: rate) {
        for lane in 0..<(rate / 8) {
          var value: UInt64 = 0
          for byte in 0..<8 {
            value |= UInt64(raw[blockStart + lane * 8 + byte]) << (8 * UInt64(byte))
          }
          state[lane] ^= value
        }
        permute(&state)
      }
    }

    var digest = Data(capacity: 32)
    for lane in 0..<4 {
      for byte in 0..<8 {
        digest.append(UInt8(truncatingIfNeeded: state[lane] >> (8 * UInt64(byte))))
      }
    }
    return digest
  }

  private static func permute(_ state: inout [UInt64]) {
    for round in 0..<24 {
      // θ
      var c = [UInt64](repeating: 0, count: 5)
      for x in 0..<5 {
        c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
      }
      for x in 0..<5 {
        let d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
        for y in stride(from: 0, to: 25, by: 5) { state[y + x] ^= d }
      }

      // ρ and π
      var b = [UInt64](repeating: 0, count: 25)
      for x in 0..<5 {
        for y in 0..<5 {
          // Lane (x, y) lives at index 5y + x; π sends it to (y, (2x + 3y) mod 5).
          b[5 * ((2 * x + 3 * y) % 5) + y] = rotl(state[5 * y + x], rotationOffsets[5 * y + x])
        }
      }

      // χ
      for y in stride(from: 0, to: 25, by: 5) {
        for x in 0..<5 {
          state[y + x] = b[y + x] ^ (~b[y + (x + 1) % 5] & b[y + (x + 2) % 5])
        }
      }

      // ι
      state[0] ^= roundConstants[round]
    }
  }

  private static func rotl(_ value: UInt64, _ shift: Int) -> UInt64 {
    shift == 0 ? value : (value << UInt64(shift)) | (value >> UInt64(64 - shift))
  }
}
