import Foundation

/// Builds the Safe v1.4.1 EIP-712 payload an admin signs, **from the fields the device validated**.
///
/// This is the last link in the chain that makes `CircleApprovalValidator` load-bearing. The
/// validator proves that the transaction the backend proposed is the payment the person read on
/// screen. This type then constructs the signing payload out of *those same fields* rather than out
/// of anything the backend sent separately — so there is no seam between "what was checked" and
/// "what was signed".
///
/// It is deliberately EIP-712 rather than a raw-hash signature: the Mera account signs typed data,
/// the domain pins `chainId` and `verifyingContract` (the Circle's own Safe), and the resulting
/// signature carries `v ∈ {27, 28}` — exactly the `ECDSA` variant Safe and Prism's backend verify.
/// A Safe owner is an ordinary EOA here; no EIP-1271, no new credential.
enum SafeTypedData {
  /// The EIP-712 `SafeTx` payload for one Circle transaction.
  ///
  /// - Parameter payload: an approval payload that has ALREADY passed `CircleApprovalValidator`.
  ///   Passing an unvalidated payload would sign whatever the backend asked for, which is the whole
  ///   thing this design exists to prevent.
  static func safeTransaction(for payload: CircleApprovalPayload) -> [String: Any] {
    Self.payload(chainId: payload.chainId, safeAddress: payload.safeAddress, tx: payload.safeTransaction)
  }

  /// The same payload for a Circle *change* — adding an admin, changing the approval rule, setting a
  /// spending limit. Safe signs all of them with one structure, so there is one builder; what
  /// differs is what the device had to prove first, which is `CircleGovernanceValidator`'s job.
  ///
  /// - Parameter payload: a governance payload that has ALREADY passed `CircleGovernanceValidator`.
  static func safeTransaction(for payload: CircleGovernancePayload) -> [String: Any] {
    Self.payload(chainId: payload.chainId, safeAddress: payload.safeAddress, tx: payload.safeTransaction)
  }

  static func jsonData(for payload: CircleGovernancePayload) throws -> Data {
    try JSONSerialization.data(withJSONObject: safeTransaction(for: payload), options: [.sortedKeys])
  }

  /// The one place Safe's EIP-712 `SafeTx` payload is spelled out.
  private static func payload(chainId: SafeUInt256, safeAddress: EVMAddress, tx: SafeTransaction) -> [String: Any] {
    // Safe's domain carries no name and no version — only the chain and the Safe itself. That is
    // what makes one signature unreplayable onto another Circle or another chain.
    let domain: [String: Any] = [
      "chainId": chainId.decimalString,
      "verifyingContract": safeAddress.lowercasedHex,
    ]

    let types: [String: Any] = [
      "EIP712Domain": [
        ["name": "chainId", "type": "uint256"],
        ["name": "verifyingContract", "type": "address"],
      ],
      "SafeTx": [
        ["name": "to", "type": "address"],
        ["name": "value", "type": "uint256"],
        ["name": "data", "type": "bytes"],
        ["name": "operation", "type": "uint8"],
        ["name": "safeTxGas", "type": "uint256"],
        ["name": "baseGas", "type": "uint256"],
        ["name": "gasPrice", "type": "uint256"],
        ["name": "gasToken", "type": "address"],
        ["name": "refundReceiver", "type": "address"],
        ["name": "nonce", "type": "uint256"],
      ],
    ]

    // Every uint is carried as a decimal STRING. `SafeUInt256` holds 256 bits, which no Swift
    // integer type can — narrowing one here to satisfy a JSON encoder would be the one place this
    // whole path could silently round an amount.
    let message: [String: Any] = [
      "to": tx.to.lowercasedHex,
      "value": tx.value.decimalString,
      "data": tx.data.prismHexString,
      "operation": Int(tx.operation.rawValue),
      "safeTxGas": tx.safeTxGas.decimalString,
      "baseGas": tx.baseGas.decimalString,
      "gasPrice": tx.gasPrice.decimalString,
      "gasToken": tx.gasToken.lowercasedHex,
      "refundReceiver": tx.refundReceiver.lowercasedHex,
      "nonce": tx.nonce.decimalString,
    ]

    return ["domain": domain, "primaryType": "SafeTx", "types": types, "message": message]
  }

  static func jsonData(for payload: CircleApprovalPayload) throws -> Data {
    try JSONSerialization.data(withJSONObject: safeTransaction(for: payload), options: [.sortedKeys])
  }
}

/// Turns the backend's wire model into the typed payload the validator understands.
///
/// Every conversion below fails closed. A malformed address, an amount that does not fit in 256
/// bits, a `data` field that is not hex — any of these abort the approval rather than decoding to
/// something shorter or rounder. A hostile backend cannot get past this by sending nonsense; it has
/// to send something well-formed, at which point the validator's real checks apply.
enum CircleApprovalPayloadBuilder {
  enum Failure: Error, CustomStringConvertible {
    case missingField(String)
    case malformed(String)

    var description: String {
      switch self {
      case .missingField(let name): return "this approval is missing \(name)"
      case .malformed(let name): return "this approval's \(name) is not a value this device can read"
      }
    }
  }

  static func make(from payment: CirclePayment) throws -> CircleApprovalPayload {
    guard let tx = payment.safeTransaction else { throw Failure.missingField("its Safe transaction") }
    guard let safeAddressText = payment.safeAddress else { throw Failure.missingField("a Safe address") }
    guard let chainIdText = payment.chainId else { throw Failure.missingField("a chain") }
    guard let digestText = payment.safeTxHash else { throw Failure.missingField("a transaction hash") }
    guard let recipientText = payment.recipientAccount else { throw Failure.missingField("a recipient") }
    guard let amountText = payment.amount else { throw Failure.missingField("an amount") }

    guard let safeAddress = EVMAddress(safeAddressText) else { throw Failure.malformed("Safe address") }
    guard let chainId = SafeUInt256(decimalString: chainIdText) else { throw Failure.malformed("chain id") }
    guard let nonce = SafeUInt256(decimalString: tx.nonce) else { throw Failure.malformed("Safe nonce") }
    guard let target = EVMAddress(tx.to) else { throw Failure.malformed("target") }
    guard let value = SafeUInt256(decimalString: tx.value) else { throw Failure.malformed("value") }
    guard let data = Data(prismHex: tx.data) else { throw Failure.malformed("calldata") }
    guard let operation = SafeOperation(rawValue: UInt8(clamping: tx.operation)) else { throw Failure.malformed("operation") }
    guard let safeTxGas = SafeUInt256(decimalString: tx.safeTxGas) else { throw Failure.malformed("safeTxGas") }
    guard let baseGas = SafeUInt256(decimalString: tx.baseGas) else { throw Failure.malformed("baseGas") }
    guard let gasPrice = SafeUInt256(decimalString: tx.gasPrice) else { throw Failure.malformed("gasPrice") }
    guard let gasToken = EVMAddress(tx.gasToken) else { throw Failure.malformed("gasToken") }
    guard let refundReceiver = EVMAddress(tx.refundReceiver) else { throw Failure.malformed("refundReceiver") }
    guard let recipient = EVMAddress(recipientText) else { throw Failure.malformed("recipient") }
    guard let amount = SafeUInt256(decimalString: amountText) else { throw Failure.malformed("amount") }
    guard let digest = Data(prismHex: digestText), digest.count == 32 else { throw Failure.malformed("transaction hash") }

    return CircleApprovalPayload(
      circleId: payment.circleId,
      safeAddress: safeAddress,
      chainId: chainId,
      safeNonce: nonce,
      target: target,
      value: value,
      data: data,
      operation: operation,
      safeTxGas: safeTxGas,
      baseGas: baseGas,
      gasPrice: gasPrice,
      gasToken: gasToken,
      refundReceiver: refundReceiver,
      humanRecipient: payment.recipientLabel,
      recipientAccount: recipient,
      asset: payment.asset ?? "USDC",
      amount: amount,
      safeTxHash: digest)
  }

  /// What this device independently believes about the Circle, assembled from the Circle record and
  /// the network config — never from the approval being reviewed, which would make the check
  /// circular. `reviewedRecipient` and `reviewedAmount` are what the screen actually showed.
  static func expectation(
    circle: CircleDetail,
    usdcAddress: String,
    reviewedRecipient: EVMAddress,
    reviewedAmount: SafeUInt256
  ) throws -> CircleApprovalExpectation {
    guard let safeText = circle.safeAddress, let safeAddress = EVMAddress(safeText) else {
      throw Failure.missingField("a verified Safe for this Circle")
    }
    guard let chainId = SafeUInt256(decimalString: circle.chainId) else { throw Failure.malformed("chain id") }
    guard let usdc = EVMAddress(usdcAddress) else { throw Failure.malformed("USDC address") }
    return CircleApprovalExpectation(
      circleId: circle.circleId,
      safeAddress: safeAddress,
      chainId: chainId,
      usdcAddress: usdc,
      // The nonce the device believes is next, when the Circle's authority could be read. Nil only
      // because the chain was unreadable — never as a way to skip the check.
      expectedNonce: circle.authority?.nonce.map { SafeUInt256(UInt64(max(0, $0))) },
      reviewedRecipientAccount: reviewedRecipient,
      reviewedAmount: reviewedAmount)
  }
}
