import Foundation

/// A Circle change that moves no money, prepared for an admin to approve.
///
/// This is the sibling of `CircleApprovalPayload`, and it exists as a separate type because the
/// thing that has to be proven is different. A payment binds a *recipient and an amount*; a change
/// binds a **target and calldata**. A Safe transaction can call any address with any bytes, so an
/// admin who could be talked into signing an arbitrary target would have no safety property at all —
/// the Circle's own money could be moved by a "settings change".
///
/// Two addresses are legitimate and no others: the Circle's own Safe (its admins, its approval
/// rule, turning limits on) and the verified Allowance Module (delegates and limits). Everything
/// else is refused before Face ID is presented.
struct CircleGovernancePayload: Equatable {
  var circleId: String
  var proposalId: String
  var safeAddress: EVMAddress
  var chainId: SafeUInt256
  var safeNonce: SafeUInt256

  /// What kind of change this is, from the backend. Used to decide which of the two legitimate
  /// targets applies — and checked against the target, so a mislabelled kind cannot widen it.
  var kind: String

  var target: EVMAddress
  var value: SafeUInt256
  var data: Data
  var operation: SafeOperation
  var safeTxGas: SafeUInt256
  var baseGas: SafeUInt256
  var gasPrice: SafeUInt256
  var gasToken: EVMAddress
  var refundReceiver: EVMAddress

  /// The sentence the admin actually read on screen.
  var humanSummary: String

  var safeTxHash: Data

  var safeTransaction: SafeTransaction {
    SafeTransaction(
      to: target, value: value, data: data, operation: operation,
      safeTxGas: safeTxGas, baseGas: baseGas, gasPrice: gasPrice,
      gasToken: gasToken, refundReceiver: refundReceiver, nonce: safeNonce)
  }
}

/// What this device believes about the Circle, assembled from its own record rather than from the
/// change being reviewed.
struct CircleGovernanceExpectation {
  var circleId: String
  var safeAddress: EVMAddress
  var chainId: SafeUInt256
  /// The verified Allowance Module for this deployment, when there is one. `nil` means limits are
  /// unavailable here — and then a change that claims to target the module is refused outright,
  /// because there is no module for it to be legitimately targeting.
  var allowanceModule: EVMAddress?
}

enum CircleGovernanceRejection: Error, Equatable, CustomStringConvertible {
  case wrongCircle(expected: String, got: String)
  case wrongSafe(expected: String, got: String)
  case wrongChain(expected: String, got: String)
  case operationIsNotCall
  case nonZeroNativeValue(String)
  case refundParametersNotNeutral
  case targetIsNotTheCircle(expected: String, got: String)
  case targetIsNotTheSpendingContract(expected: String, got: String)
  case noVerifiedSpendingContract
  case unknownChangeKind(String)
  case emptyCalldata
  case safeTxHashMismatch(claimed: String, computed: String)

  var description: String {
    switch self {
    case .wrongCircle(let e, let g): return "this change is for Circle \(g), this device is showing \(e)"
    case .wrongSafe(let e, let g): return "this change targets Safe \(g), this Circle's is \(e)"
    case .wrongChain(let e, let g): return "this change is for chain \(g), this Circle lives on \(e)"
    case .operationIsNotCall: return "this change requests a delegatecall, which a Circle never signs"
    case .nonZeroNativeValue(let v): return "this change moves \(v) native MON, which a settings change never does"
    case .refundParametersNotNeutral: return "this change carries a non-neutral gas refund, which would pay an unreviewed party out of the Circle"
    case .targetIsNotTheCircle(let e, let g): return "this change calls \(g), not this Circle \(e)"
    case .targetIsNotTheSpendingContract(let e, let g): return "this change calls \(g), not the verified spending contract \(e)"
    case .noVerifiedSpendingContract: return "this change targets a spending contract, and this deployment has no verified one"
    case .unknownChangeKind(let kind): return "this device does not recognize a change of kind \(kind)"
    case .emptyCalldata: return "this change carries no instruction at all"
    case .safeTxHashMismatch(let c, let p): return "backend asked for \(c), this device computed \(p)"
    }
  }
}

/// Refuses to let an admin sign a Circle change the device cannot account for.
///
/// The gap this closes is the settings-screen version of the payment threat: a backend renders
/// "Require 2 approvals" while handing the Secure Enclave a digest that moves the Circle's balance
/// to an attacker. Recomputing the digest from the displayed fields is what makes every check above
/// it load-bearing rather than decorative.
enum CircleGovernanceValidator {
  /// Changes that must target the Circle's own Safe.
  static let selfTargetedKinds: Set<String> = [
    "OWNER_ADD", "OWNER_REMOVE", "THRESHOLD_CHANGE", "MODULE_ENABLE"
  ]
  /// Changes that must target the verified Allowance Module.
  static let moduleTargetedKinds: Set<String> = [
    "SPEND_DELEGATE_ADD", "SPEND_DELEGATE_REMOVE", "SPEND_LIMIT_SET", "SPEND_LIMIT_DELETE"
  ]

  static func validate(
    _ payload: CircleGovernancePayload,
    against expectation: CircleGovernanceExpectation
  ) throws {
    guard payload.circleId == expectation.circleId else {
      throw CircleGovernanceRejection.wrongCircle(expected: expectation.circleId, got: payload.circleId)
    }
    guard payload.safeAddress == expectation.safeAddress else {
      throw CircleGovernanceRejection.wrongSafe(
        expected: expectation.safeAddress.lowercasedHex, got: payload.safeAddress.lowercasedHex)
    }
    guard payload.chainId == expectation.chainId else {
      throw CircleGovernanceRejection.wrongChain(
        expected: expectation.chainId.decimalString, got: payload.chainId.decimalString)
    }
    guard payload.operation == .call else { throw CircleGovernanceRejection.operationIsNotCall }
    guard payload.value == .zero else {
      throw CircleGovernanceRejection.nonZeroNativeValue(payload.value.decimalString)
    }
    guard payload.gasPrice == .zero,
      payload.baseGas == .zero,
      payload.gasToken == CircleApprovalValidator.zeroAddress,
      payload.refundReceiver == CircleApprovalValidator.zeroAddress
    else { throw CircleGovernanceRejection.refundParametersNotNeutral }

    // A change with no calldata is a bare call to an address. For a Safe that is a no-op, but
    // signing one would burn the Circle's next transaction number for nothing.
    guard payload.data.count >= 4 else { throw CircleGovernanceRejection.emptyCalldata }

    if Self.selfTargetedKinds.contains(payload.kind) {
      guard payload.target == expectation.safeAddress else {
        throw CircleGovernanceRejection.targetIsNotTheCircle(
          expected: expectation.safeAddress.lowercasedHex, got: payload.target.lowercasedHex)
      }
    } else if Self.moduleTargetedKinds.contains(payload.kind) {
      guard let module = expectation.allowanceModule else {
        throw CircleGovernanceRejection.noVerifiedSpendingContract
      }
      guard payload.target == module else {
        throw CircleGovernanceRejection.targetIsNotTheSpendingContract(
          expected: module.lowercasedHex, got: payload.target.lowercasedHex)
      }
    } else {
      // An unrecognized kind is refused rather than waved through with a generic target check: a
      // new kind this build has never heard of is exactly the thing that should not be auto-signed.
      throw CircleGovernanceRejection.unknownChangeKind(payload.kind)
    }

    let computed = SafeTransactionHash.hash(
      chainId: payload.chainId, safeAddress: payload.safeAddress, tx: payload.safeTransaction)
    guard computed == payload.safeTxHash else {
      throw CircleGovernanceRejection.safeTxHashMismatch(
        claimed: payload.safeTxHash.prismHexString, computed: computed.prismHexString)
    }
  }
}

enum CircleGovernancePayloadBuilder {
  enum Failure: Error, CustomStringConvertible {
    case missingField(String)
    case malformed(String)

    var description: String {
      switch self {
      case .missingField(let name): return "this change is missing \(name)"
      case .malformed(let name): return "this change's \(name) is not a value this device can read"
      }
    }
  }

  static func make(from proposal: CircleGovernanceProposal, summary: String) throws -> CircleGovernancePayload {
    guard let tx = proposal.safeTransaction else { throw Failure.missingField("its Safe transaction") }
    guard let safeAddressText = proposal.safeAddress else { throw Failure.missingField("a Safe address") }
    guard let digestText = proposal.safeTxHash else { throw Failure.missingField("a transaction hash") }

    guard let safeAddress = EVMAddress(safeAddressText) else { throw Failure.malformed("Safe address") }
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
    guard let digest = Data(prismHex: digestText), digest.count == 32 else { throw Failure.malformed("transaction hash") }

    // The chain a change belongs to is not carried on a governance proposal, so it comes from the
    // Circle record on this device — which is where it should come from anyway.
    return CircleGovernancePayload(
      circleId: proposal.circleId,
      proposalId: proposal.proposalId,
      safeAddress: safeAddress,
      chainId: .zero,
      safeNonce: nonce,
      kind: proposal.kind,
      target: target,
      value: value,
      data: data,
      operation: operation,
      safeTxGas: safeTxGas,
      baseGas: baseGas,
      gasPrice: gasPrice,
      gasToken: gasToken,
      refundReceiver: refundReceiver,
      humanSummary: summary,
      safeTxHash: digest)
  }

  /// Fill in the chain from the device's own Circle record. Kept separate from `make` so it is
  /// obvious that the chain is *not* taken from the proposal being reviewed.
  static func withChain(_ payload: CircleGovernancePayload, circle: CircleDetail) throws -> CircleGovernancePayload {
    guard let chainId = SafeUInt256(decimalString: circle.chainId) else { throw Failure.malformed("chain id") }
    var updated = payload
    updated.chainId = chainId
    return updated
  }

  static func expectation(circle: CircleDetail, allowanceModule: String?) throws -> CircleGovernanceExpectation {
    guard let safeText = circle.safeAddress, let safeAddress = EVMAddress(safeText) else {
      throw Failure.missingField("a verified Safe for this Circle")
    }
    guard let chainId = SafeUInt256(decimalString: circle.chainId) else { throw Failure.malformed("chain id") }
    return CircleGovernanceExpectation(
      circleId: circle.circleId,
      safeAddress: safeAddress,
      chainId: chainId,
      allowanceModule: allowanceModule.flatMap(EVMAddress.init))
  }
}
