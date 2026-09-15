import XCTest

@testable import Prism

/// Phase 2 of the Prism Circles proof: the iPhone must be able to recompute a Safe transaction
/// hash for itself, and must refuse to sign when the backend's story does not add up.
///
/// The vectors are not self-generated. Each one came from a real Safe v1.4.1 on Monad testnet
/// answering `getTransactionHash()`, and was independently reproduced by the official Safe
/// protocol-kit. If Swift agrees with both, three implementations agree.
final class CircleSafeTxHashTests: XCTestCase {

  // MARK: - Keccak-256

  /// Keccak-256 is not SHA3-256; a one-byte padding difference separates them. These are the
  /// published vectors, so a wrong-but-consistent implementation cannot pass.
  func testKeccak256KnownVectors() {
    let cases: [(String, String)] = [
      ("", "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"),
      ("abc", "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"),
      (
        "The quick brown fox jumps over the lazy dog",
        "0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15"
      ),
    ]
    for (input, expected) in cases {
      XCTAssertEqual(Keccak256.hash(Data(input.utf8)).prismHexString, expected, "keccak256(\(input))")
    }
  }

  /// The sponge absorbs 136 bytes at a time; 135/136/137 straddle that boundary, where padding
  /// bugs live.
  func testKeccak256RateBoundaries() {
    let expected: [Int: String] = [
      135: "0x34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446",
      136: "0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e",
      137: "0xd869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39",
      272: "0xcf7fcd4f705ee749930d19ca84561a9bf62516bd90a471545fa2f49fdc7e63c8",
    ]
    for (length, hash) in expected.sorted(by: { $0.key < $1.key }) {
      let input = String(repeating: "a", count: length)
      XCTAssertEqual(Keccak256.hash(Data(input.utf8)).prismHexString, hash, "length \(length)")
    }
  }

  // MARK: - Safe transaction hash

  /// The gate the whole Circles signing path rests on: Swift's digest must equal the one the Safe
  /// contract itself produced, for every vector.
  func testSwiftSafeTxHashMatchesOnChainSafe() throws {
    XCTAssertEqual(CircleSafeTxVectors.safeVersion, "1.4.1")
    XCTAssertFalse(CircleSafeTxVectors.all.isEmpty, "fixture is empty")

    for vector in CircleSafeTxVectors.all {
      let (chainId, safe, tx) = try unpack(vector)
      XCTAssertEqual(
        SafeTransactionHash.hash(chainId: chainId, safeAddress: safe, tx: tx).prismHexString,
        vector.safeTxHash,
        "safeTxHash for \(vector.name)")
    }
  }

  func testSwiftPreimageAndDomainSeparatorMatchOnChainSafe() throws {
    for vector in CircleSafeTxVectors.all {
      let (chainId, safe, tx) = try unpack(vector)
      XCTAssertEqual(
        SafeTransactionHash.domainSeparator(chainId: chainId, safeAddress: safe).prismHexString,
        vector.domainSeparator,
        "domainSeparator for \(vector.name)")
      XCTAssertEqual(
        SafeTransactionHash.preimage(chainId: chainId, safeAddress: safe, tx: tx).prismHexString,
        vector.preimage,
        "preimage for \(vector.name)")
    }
  }

  /// Distinct transactions must produce distinct digests — otherwise the checks above could be
  /// passing on a constant.
  func testDistinctTransactionsProduceDistinctHashes() throws {
    var seen = Set<String>()
    for vector in CircleSafeTxVectors.all {
      XCTAssertTrue(seen.insert(vector.safeTxHash).inserted, "duplicate digest at \(vector.name)")
    }
    XCTAssertEqual(seen.count, CircleSafeTxVectors.all.count)
  }

  /// Changing the chain, the Safe, or the nonce must change the digest. These are the three
  /// replay axes Circles depends on.
  func testDigestIsBoundToChainSafeAndNonce() throws {
    let vector = try XCTUnwrap(CircleSafeTxVectors.all.first)
    let (chainId, safe, tx) = try unpack(vector)
    let baseline = SafeTransactionHash.hash(chainId: chainId, safeAddress: safe, tx: tx)

    let otherChain = SafeTransactionHash.hash(
      chainId: SafeUInt256(UInt64(1)), safeAddress: safe, tx: tx)
    XCTAssertNotEqual(baseline, otherChain, "chainId does not bind the digest")

    let otherSafe = try XCTUnwrap(EVMAddress("0x00000000000000000000000000000000deadbeef"))
    XCTAssertNotEqual(
      baseline, SafeTransactionHash.hash(chainId: chainId, safeAddress: otherSafe, tx: tx),
      "Safe address does not bind the digest")

    var bumped = tx
    bumped.nonce = SafeUInt256(UInt64(99))
    XCTAssertNotEqual(
      baseline, SafeTransactionHash.hash(chainId: chainId, safeAddress: safe, tx: bumped),
      "nonce does not bind the digest")
  }

  // MARK: - Approval validation

  func testValidApprovalIsAccepted() throws {
    let (payload, expectation) = try approvalFixture()
    XCTAssertNoThrow(try CircleApprovalValidator.validate(payload, against: expectation))
  }

  /// The headline attack: the screen says "Pay Tobi $20", the calldata pays someone else.
  func testRedirectedRecipientIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    let attacker = try XCTUnwrap(EVMAddress("0x00000000000000000000000000000000000000ff"))
    payload.data = usdcTransferCalldata(to: attacker, amount: expectation.reviewedAmount)
    payload.recipientAccount = attacker
    payload.safeTxHash = recompute(payload)

    // Even with a perfectly consistent payload and a correct digest, the device refuses: the
    // recipient is not the one the person reviewed.
    assertRejects(payload, expectation) {
      if case .recipientMismatch = $0 { return true } else { return false }
    }
  }

  func testResizedAmountIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    let inflated = try XCTUnwrap(SafeUInt256(decimalString: "9000000000"))
    payload.data = usdcTransferCalldata(to: payload.recipientAccount, amount: inflated)
    payload.amount = inflated
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) {
      if case .amountMismatch = $0 { return true } else { return false }
    }
  }

  /// The core Phase 2 requirement: display and digest must not be allowed to diverge.
  func testDigestThatDoesNotMatchTheDisplayedFieldsIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    // Everything on screen stays "Pay Tobi $20"; only the digest the phone is asked to sign moves.
    payload.safeTxHash = Data(repeating: 0xAB, count: 32)
    assertRejects(payload, expectation) {
      if case .safeTxHashMismatch = $0 { return true } else { return false }
    }
  }

  func testWrongTokenTargetIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    payload.target = try XCTUnwrap(EVMAddress("0x00000000000000000000000000000000000000aa"))
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) {
      if case .targetIsNotCircleUsdc = $0 { return true } else { return false }
    }
  }

  func testWrongChainIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    payload.chainId = SafeUInt256(UInt64(1))
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) {
      if case .wrongChain = $0 { return true } else { return false }
    }
  }

  func testWrongSafeIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    payload.safeAddress = try XCTUnwrap(EVMAddress("0x00000000000000000000000000000000000000bb"))
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) {
      if case .wrongSafe = $0 { return true } else { return false }
    }
  }

  func testWrongNonceIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    payload.safeNonce = SafeUInt256(UInt64(77))
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) {
      if case .wrongNonce = $0 { return true } else { return false }
    }
  }

  func testDelegateCallIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    payload.operation = .delegateCall
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) { $0 == .operationIsNotCall }
  }

  /// A non-zero gasPrice turns the Safe into a second payer, reimbursing `refundReceiver` from
  /// Circle funds for an amount nobody reviewed.
  func testGasRefundToAnUnreviewedPartyIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    payload.gasPrice = SafeUInt256(UInt64(1))
    payload.refundReceiver = try XCTUnwrap(EVMAddress("0x00000000000000000000000000000000000000cc"))
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) { $0 == .refundParametersNotNeutral }
  }

  func testNonTransferCalldataIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    // approve(attacker, uint256.max) — drains the Circle later, and looks like nothing now.
    payload.data = Data(prismHex: "0x095ea7b3")!
      + Data(repeating: 0, count: 12)
      + Data(repeating: 0xEE, count: 20)
      + Data(repeating: 0xFF, count: 32)
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) { $0 == .calldataIsNotUsdcTransfer }
  }

  /// Trailing bytes are ignored by an ABI decoder but are part of the signed digest, so they must
  /// not be silently accepted.
  func testTransferCalldataWithTrailingBytesIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    payload.data = payload.data + Data([0x00])
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) { $0 == .calldataIsNotUsdcTransfer }
  }

  func testNativeValueTransferIsRejected() throws {
    var (payload, expectation) = try approvalFixture()
    payload.value = SafeUInt256(UInt64(1))
    payload.safeTxHash = recompute(payload)
    assertRejects(payload, expectation) {
      if case .nonZeroNativeValue = $0 { return true } else { return false }
    }
  }

  // MARK: - 256-bit arithmetic

  func testSafeUInt256ParsingIsExactAtTheBoundaries() throws {
    XCTAssertEqual(SafeUInt256(decimalString: "0")?.decimalString, "0")
    XCTAssertEqual(SafeUInt256(decimalString: "20000000")?.decimalString, "20000000")
    let max = String(repeating: "1", count: 0) + "115792089237316195423570985008687907853269984665640564039457584007913129639935"
    XCTAssertEqual(SafeUInt256(decimalString: max)?.decimalString, max, "2^256 - 1 must round-trip")
    // 2^256 does not fit and must be refused rather than wrapping to zero.
    XCTAssertNil(SafeUInt256(decimalString: "115792089237316195423570985008687907853269984665640564039457584007913129639936"))
    XCTAssertNil(SafeUInt256(decimalString: "12a"))
    XCTAssertNil(SafeUInt256(decimalString: ""))
    XCTAssertNil(SafeUInt256(decimalString: "-1"))
  }

  func testAddressParsingRejectsMalformedInput() {
    XCTAssertNil(EVMAddress("0x1234"), "short address must not be accepted")
    XCTAssertNil(EVMAddress("0xZZ00000000000000000000000000000000000000"))
    XCTAssertNil(EVMAddress("0x000000000000000000000000000000000000000000"), "long address")
    XCTAssertEqual(
      EVMAddress("0xAbC0000000000000000000000000000000000001")?.lowercasedHex,
      "0xabc0000000000000000000000000000000000001",
      "comparison must not depend on case")
  }

  // MARK: - Helpers

  private func unpack(_ v: CircleSafeTxVector) throws -> (SafeUInt256, EVMAddress, SafeTransaction) {
    let chainId = try XCTUnwrap(SafeUInt256(decimalString: v.chainId), "chainId \(v.chainId)")
    let safe = try XCTUnwrap(EVMAddress(v.safeAddress), "safe \(v.safeAddress)")
    let tx = SafeTransaction(
      to: try XCTUnwrap(EVMAddress(v.to)),
      value: try XCTUnwrap(SafeUInt256(decimalString: v.value)),
      data: try XCTUnwrap(Data(prismHex: v.data)),
      operation: try XCTUnwrap(SafeOperation(rawValue: v.operation)),
      safeTxGas: try XCTUnwrap(SafeUInt256(decimalString: v.safeTxGas)),
      baseGas: try XCTUnwrap(SafeUInt256(decimalString: v.baseGas)),
      gasPrice: try XCTUnwrap(SafeUInt256(decimalString: v.gasPrice)),
      gasToken: try XCTUnwrap(EVMAddress(v.gasToken)),
      refundReceiver: try XCTUnwrap(EVMAddress(v.refundReceiver)),
      nonce: try XCTUnwrap(SafeUInt256(decimalString: v.nonce)))
    return (chainId, safe, tx)
  }

  private func usdcTransferCalldata(to recipient: EVMAddress, amount: SafeUInt256) -> Data {
    CircleApprovalValidator.erc20TransferSelector + recipient.abiWord + amount.word
  }

  private func recompute(_ payload: CircleApprovalPayload) -> Data {
    SafeTransactionHash.hash(
      chainId: payload.chainId, safeAddress: payload.safeAddress, tx: payload.safeTransaction)
  }

  private func assertRejects(
    _ payload: CircleApprovalPayload,
    _ expectation: CircleApprovalExpectation,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ matches: (CircleApprovalRejection) -> Bool
  ) {
    do {
      try CircleApprovalValidator.validate(payload, against: expectation)
      XCTFail("validator accepted a payload it must reject", file: file, line: line)
    } catch let rejection as CircleApprovalRejection {
      XCTAssertTrue(matches(rejection), "rejected for the wrong reason: \(rejection)", file: file, line: line)
    } catch {
      XCTFail("unexpected error \(error)", file: file, line: line)
    }
  }

  /// Builds a well-formed "Pay Tobi 20.00 USDC" approval from the first canonical vector, so the
  /// tampering tests all start from something the validator genuinely accepts.
  private func approvalFixture() throws -> (CircleApprovalPayload, CircleApprovalExpectation) {
    let vector = try XCTUnwrap(CircleSafeTxVectors.all.first { $0.name == "usdc_pay_tobi_20" })
    let (chainId, safe, tx) = try unpack(vector)
    let (recipient, amount) = try CircleApprovalValidator.decodeUsdcTransfer(tx.data)

    let payload = CircleApprovalPayload(
      circleId: "circle_lagos_flat",
      safeAddress: safe,
      chainId: chainId,
      safeNonce: tx.nonce,
      target: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas,
      baseGas: tx.baseGas,
      gasPrice: tx.gasPrice,
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      humanRecipient: vector.humanRecipient,
      recipientAccount: recipient,
      asset: "USDC",
      amount: amount,
      safeTxHash: try XCTUnwrap(Data(prismHex: vector.safeTxHash)))

    let expectation = CircleApprovalExpectation(
      circleId: "circle_lagos_flat",
      safeAddress: safe,
      chainId: chainId,
      usdcAddress: tx.to,
      expectedNonce: tx.nonce,
      reviewedRecipientAccount: recipient,
      reviewedAmount: amount)

    return (payload, expectation)
  }
}
