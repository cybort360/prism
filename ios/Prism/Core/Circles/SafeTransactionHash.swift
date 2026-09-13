import Foundation

/// The Safe operation type. Prism Circles only ever signs `.call`; `.delegateCall` hands the
/// Circle's entire balance to arbitrary code and is rejected before the phone will sign.
enum SafeOperation: UInt8, Equatable {
  case call = 0
  case delegateCall = 1
}

/// Every field that goes into a Safe transaction digest. All eleven matter: leaving one out, or
/// trusting the backend's copy of one, is exactly the substitution this type exists to prevent.
struct SafeTransaction: Equatable {
  var to: EVMAddress
  var value: SafeUInt256
  var data: Data
  var operation: SafeOperation
  var safeTxGas: SafeUInt256
  var baseGas: SafeUInt256
  var gasPrice: SafeUInt256
  var gasToken: EVMAddress
  var refundReceiver: EVMAddress
  var nonce: SafeUInt256
}

/// Recomputes a Safe v1.4.1 transaction hash on the device.
///
/// This is the whole point of the Circles signing path: the backend proposes a transaction and
/// tells the UI it means "Pay Tobi $20", but the phone signs a 32-byte digest. If the phone takes
/// that digest from the backend, the backend can show one thing and have the user authorise
/// another. So the phone rebuilds the digest from the fields it displayed and refuses to sign
/// unless its own answer matches the one it was handed.
///
/// Mirrors `Safe.getTransactionHash` / `encodeTransactionData` in safe-contracts v1.4.1.
enum SafeTransactionHash {
  /// keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
  static let domainTypehash = Data(
    prismHex: "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218")!

  /// keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,
  /// uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)")
  static let safeTxTypehash = Data(
    prismHex: "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8")!

  static func domainSeparator(chainId: SafeUInt256, safeAddress: EVMAddress) -> Data {
    Keccak256.hash(domainTypehash + chainId.word + safeAddress.abiWord)
  }

  static func structHash(_ tx: SafeTransaction) -> Data {
    var encoded = Data()
    encoded += safeTxTypehash
    encoded += tx.to.abiWord
    encoded += tx.value.word
    encoded += Keccak256.hash(tx.data) // `bytes` is encoded as the hash of its contents
    encoded += SafeUInt256(UInt64(tx.operation.rawValue)).word
    encoded += tx.safeTxGas.word
    encoded += tx.baseGas.word
    encoded += tx.gasPrice.word
    encoded += tx.gasToken.abiWord
    encoded += tx.refundReceiver.abiWord
    encoded += tx.nonce.word
    return Keccak256.hash(encoded)
  }

  /// The EIP-712 pre-image: `0x19 0x01 || domainSeparator || structHash`. This is the byte string
  /// Safe hands to an EIP-1271 contract owner, and its keccak256 is the transaction hash.
  static func preimage(chainId: SafeUInt256, safeAddress: EVMAddress, tx: SafeTransaction) -> Data {
    Data([0x19, 0x01]) + domainSeparator(chainId: chainId, safeAddress: safeAddress) + structHash(tx)
  }

  static func hash(chainId: SafeUInt256, safeAddress: EVMAddress, tx: SafeTransaction) -> Data {
    Keccak256.hash(preimage(chainId: chainId, safeAddress: safeAddress, tx: tx))
  }
}
