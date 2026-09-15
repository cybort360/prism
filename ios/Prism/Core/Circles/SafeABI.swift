import Foundation

/// A 256-bit unsigned integer held as its 32-byte big-endian ABI word.
///
/// Prism only ever needs to *carry* and *compare* these values, never do arithmetic on them, so a
/// fixed 32-byte representation is enough and avoids taking a bignum dependency onto the phone.
/// Decimal parsing is included because the backend sends amounts as strings — `UInt64` would
/// silently truncate a value a hostile backend could choose.
struct SafeUInt256: Equatable, Hashable {
  /// Big-endian, always exactly 32 bytes.
  let word: Data

  static let zero = SafeUInt256(UInt64(0))

  init(_ value: UInt64) {
    var bytes = [UInt8](repeating: 0, count: 32)
    for i in 0..<8 { bytes[31 - i] = UInt8(truncatingIfNeeded: value >> (8 * UInt64(i))) }
    word = Data(bytes)
  }

  private init(word: Data) { self.word = word }

  /// Parses an unsigned base-10 integer. Returns nil on anything that is not a plain decimal
  /// string or that does not fit in 256 bits — both of which must abort an approval, not round.
  init?(decimalString: String) {
    let text = decimalString.trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    var bytes = [UInt8](repeating: 0, count: 32)
    for character in text {
      // bytes = bytes * 10 + digit, big-endian, rejecting any carry out of the top byte.
      var carry = UInt32(character.wholeNumberValue ?? 0)
      for i in stride(from: 31, through: 0, by: -1) {
        let product = UInt32(bytes[i]) * 10 + carry
        bytes[i] = UInt8(truncatingIfNeeded: product)
        carry = product >> 8
      }
      if carry != 0 { return nil }
    }
    word = Data(bytes)
  }

  /// Parses a `0x`-prefixed or bare hex quantity of at most 32 bytes.
  init?(hexString: String) {
    guard let raw = Data(prismHex: hexString), raw.count <= 32 else { return nil }
    word = Data(repeating: 0, count: 32 - raw.count) + raw
  }

  var decimalString: String {
    var digits: [UInt8] = [0]
    for byte in word {
      var carry = UInt32(byte)
      for i in stride(from: digits.count - 1, through: 0, by: -1) {
        let value = UInt32(digits[i]) * 256 + carry
        digits[i] = UInt8(value % 10)
        carry = value / 10
      }
      while carry > 0 {
        digits.insert(UInt8(carry % 10), at: 0)
        carry /= 10
      }
    }
    let text = digits.drop(while: { $0 == 0 }).map(String.init).joined()
    return text.isEmpty ? "0" : text
  }
}

/// A 20-byte EVM address, stored normalised so comparisons never hinge on letter case.
struct EVMAddress: Equatable, Hashable {
  let bytes: Data

  init?(_ text: String) {
    guard let raw = Data(prismHex: text), raw.count == 20 else { return nil }
    bytes = raw
  }

  /// Lowercase `0x`-prefixed form. Deliberately not EIP-55 checksummed: Prism never shows a raw
  /// address to a person, and a checksum here would only invite case-sensitive comparisons.
  var lowercasedHex: String { "0x" + bytes.map { String(format: "%02x", $0) }.joined() }

  /// Left-padded to a 32-byte ABI word.
  var abiWord: Data { Data(repeating: 0, count: 12) + bytes }
}

extension Data {
  /// Parses hex with or without a `0x` prefix. Returns nil for odd length or non-hex characters,
  /// so malformed backend input fails closed rather than decoding to something shorter.
  init?(prismHex text: String) {
    var body = Substring(text)
    if body.hasPrefix("0x") || body.hasPrefix("0X") { body = body.dropFirst(2) }
    guard body.count % 2 == 0 else { return nil }
    var out = Data(capacity: body.count / 2)
    var index = body.startIndex
    while index < body.endIndex {
      let next = body.index(index, offsetBy: 2)
      guard let byte = UInt8(body[index..<next], radix: 16) else { return nil }
      out.append(byte)
      index = next
    }
    self = out
  }

  var prismHexString: String { "0x" + map { String(format: "%02x", $0) }.joined() }
}
