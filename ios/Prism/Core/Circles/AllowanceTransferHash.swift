import Foundation

/// One member's authorization to spend within their Circle limit, recomputed on the device.
///
/// Same discipline as `SafeTransactionHash`, and for the same reason. The backend proposes a spend
/// and tells the UI it means "pay the shop $42", but the phone signs a 32-byte digest. If the phone
/// took that digest on trust, the backend could show one thing and have the member authorize
/// another. So the phone rebuilds the digest from the fields it displayed and refuses to sign
/// unless its own answer matches the one it was handed.
///
/// Mirrors `AllowanceModule.generateTransferHash` in Safe's allowances v1.0.0. Note what it binds
/// and what it does not: the Safe, the token, the recipient, the amount and the delegate's
/// per-token nonce are all inside it — the **delegate is not**. The module separately requires the
/// recovered signer to equal the delegate it was given, so this hash alone never identifies who
/// authorized a spend.
enum AllowanceTransferHash {
  /// keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
  /// The module's domain carries only the chain and the module — no name, no version.
  static let domainTypehash = Data(
    prismHex: "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218")!

  /// keccak256("AllowanceTransfer(address safe,address token,address to,uint96 amount,
  /// address paymentToken,uint96 payment,uint16 nonce)")
  static let allowanceTransferTypehash = Data(
    prismHex: "0x97c7ed08d51f4a077f71428543a8a2454799e5f6df78c03ef278be094511eda4")!

  static let zeroAddress = EVMAddress("0x0000000000000000000000000000000000000000")!

  static func domainSeparator(chainId: SafeUInt256, moduleAddress: EVMAddress) -> Data {
    Keccak256.hash(domainTypehash + chainId.word + moduleAddress.abiWord)
  }

  /// `paymentToken`/`payment` are always zero: a relayer fee would be a second, unreviewed spend
  /// out of the member's own limit. Prism sponsors gas from the relayer instead.
  static func structHash(
    safeAddress: EVMAddress, token: EVMAddress, recipient: EVMAddress,
    amount: SafeUInt256, nonce: SafeUInt256
  ) -> Data {
    var encoded = Data()
    encoded += allowanceTransferTypehash
    encoded += safeAddress.abiWord
    encoded += token.abiWord
    encoded += recipient.abiWord
    encoded += amount.word            // uint96, ABI-encoded in a full 32-byte word
    encoded += zeroAddress.abiWord    // paymentToken
    encoded += SafeUInt256.zero.word  // payment
    encoded += nonce.word             // uint16, likewise
    return Keccak256.hash(encoded)
  }

  static func hash(
    chainId: SafeUInt256, moduleAddress: EVMAddress, safeAddress: EVMAddress,
    token: EVMAddress, recipient: EVMAddress, amount: SafeUInt256, nonce: SafeUInt256
  ) -> Data {
    let preimage = Data([0x19, 0x01])
      + domainSeparator(chainId: chainId, moduleAddress: moduleAddress)
      + structHash(safeAddress: safeAddress, token: token, recipient: recipient, amount: amount, nonce: nonce)
    return Keccak256.hash(preimage)
  }
}

/// What the backend proposes when a member spends inside their limit. Untrusted input, all of it.
struct CircleSpendPayload: Equatable {
  var spendId: String
  var circleId: String
  var moduleAddress: EVMAddress
  var safeAddress: EVMAddress
  var chainId: SafeUInt256
  var token: EVMAddress
  var recipientAccount: EVMAddress
  var amount: SafeUInt256
  var allowanceNonce: SafeUInt256
  /// The digest the backend claims the above hashes to.
  var transferHash: Data
}

/// What this device independently believes, assembled from its own Circle record and the network
/// config — never from the payload being reviewed, which would make the check circular.
struct CircleSpendExpectation {
  var circleId: String
  var safeAddress: EVMAddress
  var chainId: SafeUInt256
  var moduleAddress: EVMAddress
  var usdcAddress: EVMAddress
  /// The recipient and amount the person actually read on screen.
  var reviewedRecipientAccount: EVMAddress
  var reviewedAmount: SafeUInt256
  /// The available headroom the screen showed, when the device knows it.
  var availableAtomic: SafeUInt256?
}

enum CircleSpendRejection: Error, Equatable, CustomStringConvertible {
  case wrongCircle(expected: String, got: String)
  case wrongSafe(expected: String, got: String)
  case wrongChain(expected: String, got: String)
  case wrongModule(expected: String, got: String)
  case tokenIsNotCircleUsdc(expected: String, got: String)
  case recipientMismatch(reviewed: String, payload: String)
  case amountMismatch(reviewed: String, payload: String)
  case amountExceedsReviewedHeadroom(amount: String, available: String)
  case transferHashMismatch(claimed: String, computed: String)

  var description: String {
    switch self {
    case .wrongCircle(let e, let g): return "this spend is for Circle \(g), this device reviewed \(e)"
    case .wrongSafe(let e, let g): return "this spend draws on Safe \(g), this Circle's Safe is \(e)"
    case .wrongChain(let e, let g): return "this spend is for chain \(g), this Circle lives on \(e)"
    case .wrongModule(let e, let g): return "this spend names module \(g), not this deployment's \(e)"
    case .tokenIsNotCircleUsdc(let e, let g): return "this spend moves \(g), not this Circle's USDC \(e)"
    case .recipientMismatch(let r, let p): return "screen showed \(r), the spend pays \(p)"
    case .amountMismatch(let r, let p): return "screen showed \(r), the spend moves \(p)"
    case .amountExceedsReviewedHeadroom(let a, let v): return "this spend is \(a), above the \(v) the screen showed as available"
    case .transferHashMismatch(let c, let p): return "backend asked for \(c), this device computed \(p)"
    }
  }
}

/// Refuses to let the phone authorize a spend it cannot independently account for.
///
/// The threat is the same one `CircleApprovalValidator` closes for threshold payments, scaled down
/// to a single member: a compromised backend rendering "Pay the shop $42" while handing the Secure
/// Enclave a digest for "pay the attacker $100". The last check — recomputing the digest from the
/// displayed fields — is what makes the others load-bearing rather than cosmetic.
enum CircleSpendValidator {
  static func validate(_ payload: CircleSpendPayload, against expectation: CircleSpendExpectation) throws {
    guard payload.circleId == expectation.circleId else {
      throw CircleSpendRejection.wrongCircle(expected: expectation.circleId, got: payload.circleId)
    }
    guard payload.safeAddress == expectation.safeAddress else {
      throw CircleSpendRejection.wrongSafe(
        expected: expectation.safeAddress.lowercasedHex, got: payload.safeAddress.lowercasedHex)
    }
    guard payload.chainId == expectation.chainId else {
      throw CircleSpendRejection.wrongChain(
        expected: expectation.chainId.decimalString, got: payload.chainId.decimalString)
    }
    guard payload.moduleAddress == expectation.moduleAddress else {
      throw CircleSpendRejection.wrongModule(
        expected: expectation.moduleAddress.lowercasedHex, got: payload.moduleAddress.lowercasedHex)
    }
    guard payload.token == expectation.usdcAddress else {
      throw CircleSpendRejection.tokenIsNotCircleUsdc(
        expected: expectation.usdcAddress.lowercasedHex, got: payload.token.lowercasedHex)
    }
    guard payload.recipientAccount == expectation.reviewedRecipientAccount else {
      throw CircleSpendRejection.recipientMismatch(
        reviewed: expectation.reviewedRecipientAccount.lowercasedHex,
        payload: payload.recipientAccount.lowercasedHex)
    }
    guard payload.amount == expectation.reviewedAmount else {
      throw CircleSpendRejection.amountMismatch(
        reviewed: expectation.reviewedAmount.decimalString, payload: payload.amount.decimalString)
    }
    // The module enforces the limit itself; this only stops the phone signing something larger than
    // the headroom the person was shown, which would be a surprise even when it succeeds.
    if let available = expectation.availableAtomic, payload.amount.isGreaterThan(available) {
      throw CircleSpendRejection.amountExceedsReviewedHeadroom(
        amount: payload.amount.decimalString, available: available.decimalString)
    }

    let computed = AllowanceTransferHash.hash(
      chainId: payload.chainId, moduleAddress: payload.moduleAddress, safeAddress: payload.safeAddress,
      token: payload.token, recipient: payload.recipientAccount, amount: payload.amount,
      nonce: payload.allowanceNonce)
    guard computed == payload.transferHash else {
      throw CircleSpendRejection.transferHashMismatch(
        claimed: payload.transferHash.prismHexString, computed: computed.prismHexString)
    }
  }
}

extension SafeUInt256 {
  /// Big-endian byte comparison. Enough for "is this spend larger than the headroom shown?", and it
  /// avoids pulling a bignum dependency onto the phone for one comparison.
  func isGreaterThan(_ other: SafeUInt256) -> Bool {
    for (a, b) in zip(word, other.word) where a != b { return a > b }
    return false
  }
}

/// Builds the EIP-712 payload a member signs to authorize one spend, **from the validated fields**.
///
/// The module's transfer hash is an ordinary EIP-712 digest, so the Mera account can produce it with
/// `signTypedData` — no raw-hash signing primitive is needed, and the resulting `v ∈ {27, 28}` is
/// exactly what `AllowanceModule.recoverSignature` expects on its plain-ECDSA branch.
///
/// Built out of the same fields `CircleSpendValidator` checked, so there is no seam between "what
/// was verified" and "what was signed".
enum AllowanceTypedData {
  static func allowanceTransfer(for payload: CircleSpendPayload) -> [String: Any] {
    // The module's domain pins the chain and the module itself — nothing else. That is what stops
    // one authorization being replayed onto another chain or another module deployment.
    let domain: [String: Any] = [
      "chainId": payload.chainId.decimalString,
      "verifyingContract": payload.moduleAddress.lowercasedHex,
    ]

    let types: [String: Any] = [
      "EIP712Domain": [
        ["name": "chainId", "type": "uint256"],
        ["name": "verifyingContract", "type": "address"],
      ],
      "AllowanceTransfer": [
        ["name": "safe", "type": "address"],
        ["name": "token", "type": "address"],
        ["name": "to", "type": "address"],
        ["name": "amount", "type": "uint96"],
        ["name": "paymentToken", "type": "address"],
        ["name": "payment", "type": "uint96"],
        ["name": "nonce", "type": "uint16"],
      ],
    ]

    // `paymentToken`/`payment` are zero on purpose: a relayer fee here would be a second,
    // unreviewed spend out of this member's own limit.
    let message: [String: Any] = [
      "safe": payload.safeAddress.lowercasedHex,
      "token": payload.token.lowercasedHex,
      "to": payload.recipientAccount.lowercasedHex,
      "amount": payload.amount.decimalString,
      "paymentToken": AllowanceTransferHash.zeroAddress.lowercasedHex,
      "payment": "0",
      "nonce": payload.allowanceNonce.decimalString,
    ]

    return ["domain": domain, "primaryType": "AllowanceTransfer", "types": types, "message": message]
  }

  static func jsonData(for payload: CircleSpendPayload) throws -> Data {
    try JSONSerialization.data(withJSONObject: allowanceTransfer(for: payload), options: [.sortedKeys])
  }
}

/// Turns the backend's wire model into the typed payload the validator understands. Fails closed:
/// a malformed address or an amount that will not fit in 256 bits aborts rather than decoding to
/// something shorter.
enum CircleSpendPayloadBuilder {
  enum Failure: Error, CustomStringConvertible {
    case missingField(String)
    case malformed(String)

    var description: String {
      switch self {
      case .missingField(let name): return "this spend is missing \(name)"
      case .malformed(let name): return "this spend's \(name) is not a value this device can read"
      }
    }
  }

  static func make(from prepared: PreparedCircleSpend, circle: CircleDetail, moduleAddress: String, usdcAddress: String) throws -> CircleSpendPayload {
    let spend = prepared.spend
    guard let recipientText = spend.recipientAccount else { throw Failure.missingField("a recipient") }
    guard let safeText = circle.safeAddress else { throw Failure.missingField("a verified Safe for this Circle") }

    guard let safeAddress = EVMAddress(safeText) else { throw Failure.malformed("Safe address") }
    guard let module = EVMAddress(moduleAddress) else { throw Failure.malformed("module address") }
    guard let token = EVMAddress(usdcAddress) else { throw Failure.malformed("USDC address") }
    guard let recipient = EVMAddress(recipientText) else { throw Failure.malformed("recipient") }
    guard let chainId = SafeUInt256(decimalString: circle.chainId) else { throw Failure.malformed("chain id") }
    guard let amount = SafeUInt256(decimalString: spend.amount) else { throw Failure.malformed("amount") }
    guard let nonce = spend.allowanceNonce.map({ SafeUInt256(UInt64(max(0, $0))) }) else { throw Failure.missingField("an allowance nonce") }
    guard let digest = Data(prismHex: prepared.transferHash), digest.count == 32 else { throw Failure.malformed("transfer hash") }

    return CircleSpendPayload(
      spendId: spend.spendId, circleId: spend.circleId, moduleAddress: module, safeAddress: safeAddress,
      chainId: chainId, token: token, recipientAccount: recipient, amount: amount,
      allowanceNonce: nonce, transferHash: digest)
  }
}
