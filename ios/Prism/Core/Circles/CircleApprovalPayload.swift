import Foundation

/// What the backend proposes when a Circle needs an approval.
///
/// Every field below is *untrusted input*. The bottom half (`target`, `value`, `data`, …) is what
/// would actually execute on Monad; the middle (`humanRecipient`, `amount`, …) is what the UI
/// would show a person. `CircleApprovalValidator` exists to prove those two halves describe the
/// same payment before Face ID is ever presented.
struct CircleApprovalPayload: Equatable {
  // Which Circle, and on what chain.
  var circleId: String
  var safeAddress: EVMAddress
  var chainId: SafeUInt256
  var safeNonce: SafeUInt256

  // The transaction as the chain will see it.
  var target: EVMAddress
  var value: SafeUInt256
  var data: Data
  var operation: SafeOperation
  var safeTxGas: SafeUInt256
  var baseGas: SafeUInt256
  var gasPrice: SafeUInt256
  var gasToken: EVMAddress
  var refundReceiver: EVMAddress

  // The transaction as a person will read it.
  var humanRecipient: String
  var recipientAccount: EVMAddress
  var asset: String
  var amount: SafeUInt256

  // The digest the backend claims the above hashes to.
  var safeTxHash: Data

  var safeTransaction: SafeTransaction {
    SafeTransaction(
      to: target, value: value, data: data, operation: operation,
      safeTxGas: safeTxGas, baseGas: baseGas, gasPrice: gasPrice,
      gasToken: gasToken, refundReceiver: refundReceiver, nonce: safeNonce)
  }
}

/// The settings a Circle is pinned to on this device. These come from the device's own Circle
/// record, never from the approval being reviewed — otherwise the check would be circular.
struct CircleApprovalExpectation {
  var circleId: String
  var safeAddress: EVMAddress
  var chainId: SafeUInt256
  /// The Circle's payment asset. Prism Circles is USDC-only; Prism Save's AUSD never appears here.
  var usdcAddress: EVMAddress
  /// The nonce the client believes is next, when it knows. `nil` only when the device has not yet
  /// reconciled the Circle's nonce — never as a way to skip the check.
  var expectedNonce: SafeUInt256?
  /// The recipient and amount the person actually reviewed on screen.
  var reviewedRecipientAccount: EVMAddress
  var reviewedAmount: SafeUInt256
}

enum CircleApprovalRejection: Error, Equatable, CustomStringConvertible {
  case wrongCircle(expected: String, got: String)
  case wrongSafe(expected: String, got: String)
  case wrongChain(expected: String, got: String)
  case wrongNonce(expected: String, got: String)
  case targetIsNotCircleUsdc(expected: String, got: String)
  case operationIsNotCall
  case nonZeroNativeValue(String)
  case refundParametersNotNeutral
  case calldataIsNotUsdcTransfer
  case recipientMismatch(reviewed: String, encoded: String)
  case amountMismatch(reviewed: String, encoded: String)
  case safeTxHashMismatch(claimed: String, computed: String)

  var description: String {
    switch self {
    case .wrongCircle(let e, let g): return "approval is for Circle \(g), this device reviewed \(e)"
    case .wrongSafe(let e, let g): return "approval targets Safe \(g), this Circle's Safe is \(e)"
    case .wrongChain(let e, let g): return "approval is for chain \(g), this Circle lives on \(e)"
    case .wrongNonce(let e, let g): return "approval uses Safe nonce \(g), expected \(e)"
    case .targetIsNotCircleUsdc(let e, let g): return "approval calls \(g), not this Circle's USDC \(e)"
    case .operationIsNotCall: return "approval requests a delegatecall, which a Circle never signs"
    case .nonZeroNativeValue(let v): return "approval moves \(v) native MON, which a USDC payment never does"
    case .refundParametersNotNeutral: return "approval carries a non-neutral gas refund, which would pay an unreviewed party"
    case .calldataIsNotUsdcTransfer: return "approval calldata is not a plain USDC transfer"
    case .recipientMismatch(let r, let e): return "screen showed \(r), calldata pays \(e)"
    case .amountMismatch(let r, let e): return "screen showed \(r), calldata moves \(e)"
    case .safeTxHashMismatch(let c, let p): return "backend asked for \(c), this device computed \(p)"
    }
  }
}

/// Refuses to let the phone sign anything it cannot independently account for.
///
/// The threat is narrow and concrete: a compromised or malicious Prism backend renders
/// "Pay Tobi $20" while handing the Secure Enclave a digest for "pay the attacker $9,000". Every
/// check below closes one version of that gap, and the last one — recomputing the digest from the
/// displayed fields — is what makes the others load-bearing rather than cosmetic.
enum CircleApprovalValidator {
  /// ERC-20 `transfer(address,uint256)`.
  static let erc20TransferSelector = Data([0xa9, 0x05, 0x9c, 0xbb])

  static func validate(
    _ payload: CircleApprovalPayload,
    against expectation: CircleApprovalExpectation
  ) throws {
    guard payload.circleId == expectation.circleId else {
      throw CircleApprovalRejection.wrongCircle(expected: expectation.circleId, got: payload.circleId)
    }
    guard payload.safeAddress == expectation.safeAddress else {
      throw CircleApprovalRejection.wrongSafe(
        expected: expectation.safeAddress.lowercasedHex, got: payload.safeAddress.lowercasedHex)
    }
    guard payload.chainId == expectation.chainId else {
      throw CircleApprovalRejection.wrongChain(
        expected: expectation.chainId.decimalString, got: payload.chainId.decimalString)
    }
    if let expectedNonce = expectation.expectedNonce, payload.safeNonce != expectedNonce {
      throw CircleApprovalRejection.wrongNonce(
        expected: expectedNonce.decimalString, got: payload.safeNonce.decimalString)
    }
    guard payload.target == expectation.usdcAddress else {
      throw CircleApprovalRejection.targetIsNotCircleUsdc(
        expected: expectation.usdcAddress.lowercasedHex, got: payload.target.lowercasedHex)
    }
    guard payload.operation == .call else { throw CircleApprovalRejection.operationIsNotCall }
    guard payload.value == .zero else {
      throw CircleApprovalRejection.nonZeroNativeValue(payload.value.decimalString)
    }
    // A non-zero gasPrice makes the Safe reimburse `refundReceiver` out of Circle funds — a second,
    // unreviewed payment hiding inside the first. Circles relays are sponsored, so these stay zero.
    guard payload.gasPrice == .zero,
      payload.baseGas == .zero,
      payload.gasToken == Self.zeroAddress,
      payload.refundReceiver == Self.zeroAddress
    else { throw CircleApprovalRejection.refundParametersNotNeutral }

    let (encodedRecipient, encodedAmount) = try decodeUsdcTransfer(payload.data)
    guard encodedRecipient == expectation.reviewedRecipientAccount else {
      throw CircleApprovalRejection.recipientMismatch(
        reviewed: expectation.reviewedRecipientAccount.lowercasedHex,
        encoded: encodedRecipient.lowercasedHex)
    }
    guard encodedAmount == expectation.reviewedAmount else {
      throw CircleApprovalRejection.amountMismatch(
        reviewed: expectation.reviewedAmount.decimalString, encoded: encodedAmount.decimalString)
    }
    // The payload's own human-readable half must agree with its calldata too, so a receipt
    // rendered from the payload later cannot disagree with what was signed.
    guard payload.recipientAccount == encodedRecipient else {
      throw CircleApprovalRejection.recipientMismatch(
        reviewed: payload.recipientAccount.lowercasedHex, encoded: encodedRecipient.lowercasedHex)
    }
    guard payload.amount == encodedAmount else {
      throw CircleApprovalRejection.amountMismatch(
        reviewed: payload.amount.decimalString, encoded: encodedAmount.decimalString)
    }

    let computed = SafeTransactionHash.hash(
      chainId: payload.chainId, safeAddress: payload.safeAddress, tx: payload.safeTransaction)
    guard computed == payload.safeTxHash else {
      throw CircleApprovalRejection.safeTxHashMismatch(
        claimed: payload.safeTxHash.prismHexString, computed: computed.prismHexString)
    }
  }

  /// Decodes exactly `transfer(address,uint256)` and nothing else. Length is pinned at 68 bytes so
  /// trailing calldata — ignored by the ABI decoder but part of the signed digest — cannot ride along.
  static func decodeUsdcTransfer(_ data: Data) throws -> (EVMAddress, SafeUInt256) {
    guard data.count == 68, data.prefix(4) == erc20TransferSelector else {
      throw CircleApprovalRejection.calldataIsNotUsdcTransfer
    }
    let recipientWord = data.subdata(in: 4..<36)
    // A well-formed address word is 12 zero bytes then 20 address bytes.
    guard recipientWord.prefix(12).allSatisfy({ $0 == 0 }),
      let recipient = EVMAddress(recipientWord.suffix(20).prismHexString)
    else { throw CircleApprovalRejection.calldataIsNotUsdcTransfer }
    guard let amount = SafeUInt256(hexString: data.subdata(in: 36..<68).prismHexString) else {
      throw CircleApprovalRejection.calldataIsNotUsdcTransfer
    }
    return (recipient, amount)
  }

  static let zeroAddress = EVMAddress("0x0000000000000000000000000000000000000000")!
}
