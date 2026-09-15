import XCTest

@testable import Prism

/// The device half of Circle payment security: what the backend sends over the wire must survive
/// being rebuilt, checked and re-hashed on the phone before Face ID is ever presented.
///
/// `CircleSafeTxHashTests` already proves the digest arithmetic against hashes from a real Safe on
/// Monad. These tests cover the seam that comes after it — decoding an untrusted JSON payment into
/// `CircleApprovalPayload`, validating it against what this device independently believes about the
/// Circle, and refusing every substitution the backend could attempt.
///
/// The fixture is the first vector from `proof/circles/safe-tx-vectors.json`: a real Safe's own
/// answer for "pay Tobi $20 in USDC". So the happy path here is not a payload this test invented —
/// it is one a deployed Safe agreed with.
final class CircleApprovalWireTests: XCTestCase {

  private var vector: CircleSafeTxVector { CircleSafeTxVectors.all[0] }

  // MARK: - fixtures

  /// A payment shaped exactly as `GET /v1/circles/:id/payments/:id` returns it.
  private func paymentJSON(
    amount: String? = nil,
    recipientAccount: String? = nil,
    to: String? = nil,
    nonce: String? = nil,
    safeAddress: String? = nil,
    chainId: String? = nil,
    gasPrice: String = "0",
    refundReceiver: String? = nil,
    operation: Int = 0,
    value: String = "0",
    data: String? = nil,
    safeTxHash: String? = nil
  ) -> Data {
    let safeTransaction: [String: Any] = [
      "to": to ?? vector.to,
      "value": value,
      "data": data ?? vector.data,
      "operation": operation,
      "safeTxGas": vector.safeTxGas,
      "baseGas": vector.baseGas,
      "gasPrice": gasPrice,
      "gasToken": vector.gasToken,
      "refundReceiver": refundReceiver ?? vector.refundReceiver,
      "nonce": nonce ?? vector.nonce,
    ]
    let approvals: [[String: Any]] = [
      ["authorityAddress": "0x1111111111111111111111111111111111111111", "signatureType": "ECDSA"]
    ]
    let object: [String: Any] = [
      "proposalId": "prp_test", "circleId": "cir_lagos", "circleName": "Lagos Trip",
      "kind": "PAYMENT", "lifecycle": "APPROVAL_PENDING", "storedLifecycle": "APPROVAL_PENDING",
      "proposerPrismId": "prism_octane",
      "recipientPrismId": "prism_tobi",
      "recipientAccount": recipientAccount ?? "0xa65da47832e3cf3c63cde3203f07c87a5f264265",
      "recipientDisplayName": "Tobi", "recipientHandle": "@tobi",
      "amount": amount ?? "20000000", "asset": "USDC", "memo": "Dinner",
      "safeAddress": safeAddress ?? vector.safeAddress,
      "chainId": chainId ?? vector.chainId,
      "token": vector.to,
      "safeTxHash": safeTxHash ?? vector.safeTxHash,
      "safeNonce": nonce ?? vector.nonce,
      "safeTransaction": safeTransaction,
      "requiredApprovals": 2,
      "collectedApprovals": 1,
      "approvals": approvals,
      "binding": ["ok": true],
    ]
    return try! JSONSerialization.data(withJSONObject: object)
  }

  /// This device's own record of the Circle. Deliberately assembled separately from the payment —
  /// checking a payload against values it supplied would prove nothing.
  private func circleJSON(safeAddress: String? = nil, chainId: String? = nil, nonce: Int? = 0) -> Data {
    var authority: [String: Any] = ["threshold": 2, "adminCount": 2, "spare": 0]
    if let nonce { authority["nonce"] = nonce }
    let balance: [String: Any] = ["amountAtomic": "500000000", "decimals": 6, "symbol": "USDC"]
    let members: [[String: Any]] = []
    let object: [String: Any] = [
      "circleId": "cir_lagos", "name": "Lagos Trip", "icon": "🌴",
      "safeAddress": safeAddress ?? vector.safeAddress,
      "chainId": chainId ?? vector.chainId,
      "status": "ACTIVE",
      "verifiedOnChain": true,
      "authority": authority,
      "balance": balance,
      "members": members,
    ]
    return try! JSONSerialization.data(withJSONObject: object)
  }

  private func decode(_ data: Data) throws -> CirclePayment {
    try JSONDecoder().decode(CirclePayment.self, from: data)
  }

  private func validate(payment paymentData: Data, circle circleData: Data, usdc: String? = nil) throws {
    let payment = try decode(paymentData)
    let circle = try JSONDecoder().decode(CircleDetail.self, from: circleData)
    let payload = try CircleApprovalPayloadBuilder.make(from: payment)
    // The expectation deliberately comes from the Circle record plus what the screen showed — never
    // from the payment being checked, which would make the whole exercise circular.
    let expectation = try CircleApprovalPayloadBuilder.expectation(
      circle: circle,
      usdcAddress: usdc ?? vector.to,
      reviewedRecipient: payload.recipientAccount,
      reviewedAmount: payload.amount)
    try CircleApprovalValidator.validate(payload, against: expectation)
  }

  // MARK: - the happy path

  func testAWellFormedPaymentFromARealSafeValidates() throws {
    XCTAssertNoThrow(try validate(payment: paymentJSON(), circle: circleJSON()))
  }

  func testTheSignedPayloadIsBuiltFromTheValidatedFields() throws {
    let payment = try decode(paymentJSON())
    let payload = try CircleApprovalPayloadBuilder.make(from: payment)
    let typed = SafeTypedData.safeTransaction(for: payload)

    // Safe's domain carries only the chain and the Safe — that is what makes one signature
    // unreplayable onto another Circle or another chain.
    let domain = try XCTUnwrap(typed["domain"] as? [String: Any])
    XCTAssertEqual(domain["chainId"] as? String, vector.chainId)
    XCTAssertEqual((domain["verifyingContract"] as? String)?.lowercased(), vector.safeAddress.lowercased())
    XCTAssertNil(domain["name"], "Safe's EIP-712 domain has no name")
    XCTAssertNil(domain["version"], "Safe's EIP-712 domain has no version")
    XCTAssertEqual(typed["primaryType"] as? String, "SafeTx")

    // And the message is the transaction that was checked, field for field.
    let message = try XCTUnwrap(typed["message"] as? [String: Any])
    XCTAssertEqual((message["to"] as? String)?.lowercased(), vector.to.lowercased())
    XCTAssertEqual(message["value"] as? String, "0")
    XCTAssertEqual((message["data"] as? String)?.lowercased(), vector.data.lowercased())
    XCTAssertEqual(message["operation"] as? Int, 0)
    XCTAssertEqual(message["nonce"] as? String, vector.nonce)
    XCTAssertEqual(message["gasPrice"] as? String, "0")
  }

  // MARK: - every substitution the backend could attempt

  func testRecipientSubstitutionIsRefused() throws {
    // The calldata pays an attacker while every human-readable field still says Tobi.
    let attackerCalldata =
      "0xa9059cbb000000000000000000000000baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000001312d00"
    XCTAssertThrowsError(try validate(payment: paymentJSON(data: attackerCalldata), circle: circleJSON())) { error in
      // The screen said Tobi; the calldata says otherwise. Caught before the digest check even runs.
      guard case CircleApprovalRejection.recipientMismatch = error else {
        return XCTFail("expected a recipient mismatch, got \(error)")
      }
    }
  }

  func testAmountSubstitutionIsRefused() throws {
    // $9,000 in the calldata, $20 on the screen.
    let inflated =
      "0xa9059cbb000000000000000000000000a65da47832e3cf3c63cde3203f07c87a5f26426500000000000000000000000000000000000000000000000000000002185d9600"
    XCTAssertThrowsError(try validate(payment: paymentJSON(data: inflated), circle: circleJSON())) { error in
      guard case CircleApprovalRejection.amountMismatch = error else {
        return XCTFail("expected an amount mismatch, got \(error)")
      }
    }
  }

  func testAWrongTokenTargetIsRefused() throws {
    let otherToken = "0x1111111111111111111111111111111111111111"
    XCTAssertThrowsError(try validate(payment: paymentJSON(to: otherToken), circle: circleJSON())) { error in
      guard case CircleApprovalRejection.targetIsNotCircleUsdc = error else {
        return XCTFail("expected a target rejection, got \(error)")
      }
    }
  }

  func testAWrongSafeIsRefused() throws {
    let otherSafe = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
    XCTAssertThrowsError(try validate(payment: paymentJSON(safeAddress: otherSafe), circle: circleJSON())) { error in
      guard case CircleApprovalRejection.wrongSafe = error else {
        return XCTFail("expected a Safe rejection, got \(error)")
      }
    }
  }

  func testAWrongChainIsRefused() throws {
    XCTAssertThrowsError(try validate(payment: paymentJSON(chainId: "1"), circle: circleJSON())) { error in
      guard case CircleApprovalRejection.wrongChain = error else {
        return XCTFail("expected a chain rejection, got \(error)")
      }
    }
  }

  func testAWrongNonceIsRefused() throws {
    // The Circle's next nonce is 0; this payment claims 7.
    XCTAssertThrowsError(try validate(payment: paymentJSON(nonce: "7"), circle: circleJSON(nonce: 0))) { error in
      guard case CircleApprovalRejection.wrongNonce = error else {
        return XCTFail("expected a nonce rejection, got \(error)")
      }
    }
  }

  func testANonNeutralGasRefundIsRefused() throws {
    // A non-zero gasPrice makes the Safe reimburse `refundReceiver` out of Circle funds — a second,
    // unreviewed payment hiding inside the first.
    XCTAssertThrowsError(try validate(payment: paymentJSON(gasPrice: "1"), circle: circleJSON())) { error in
      guard case CircleApprovalRejection.refundParametersNotNeutral = error else {
        return XCTFail("expected a refund-parameter rejection, got \(error)")
      }
    }
    let attackerRefund = "0xbaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    XCTAssertThrowsError(
      try validate(payment: paymentJSON(gasPrice: "1", refundReceiver: attackerRefund), circle: circleJSON()))
  }

  func testADelegatecallIsRefused() throws {
    XCTAssertThrowsError(try validate(payment: paymentJSON(operation: 1), circle: circleJSON())) { error in
      guard case CircleApprovalRejection.operationIsNotCall = error else {
        return XCTFail("expected a delegatecall rejection, got \(error)")
      }
    }
  }

  func testNativeValueIsRefused() throws {
    XCTAssertThrowsError(try validate(payment: paymentJSON(value: "1"), circle: circleJSON())) { error in
      guard case CircleApprovalRejection.nonZeroNativeValue = error else {
        return XCTFail("expected a native-value rejection, got \(error)")
      }
    }
  }

  /// The check that makes all the others load-bearing: a payload whose fields are individually
  /// plausible, but whose digest is not the digest of those fields.
  func testADigestThatDoesNotMatchTheFieldsIsRefused() throws {
    let wrongDigest = "0x" + String(repeating: "ab", count: 32)
    XCTAssertThrowsError(try validate(payment: paymentJSON(safeTxHash: wrongDigest), circle: circleJSON())) { error in
      guard case CircleApprovalRejection.safeTxHashMismatch = error else {
        return XCTFail("expected a digest mismatch, got \(error)")
      }
    }
  }

  // MARK: - malformed input fails closed

  func testMalformedFieldsAbortRatherThanDecodingToSomethingShorter() throws {
    let payment = try decode(paymentJSON(data: "0xnothex"))
    XCTAssertThrowsError(try CircleApprovalPayloadBuilder.make(from: payment)) { error in
      guard case CircleApprovalPayloadBuilder.Failure.malformed = error else {
        return XCTFail("expected a malformed-field failure, got \(error)")
      }
    }
  }

  func testAnAmountTooLargeForTwoFiftySixBitsIsRefused() throws {
    let payment = try decode(paymentJSON(amount: String(repeating: "9", count: 80)))
    XCTAssertThrowsError(try CircleApprovalPayloadBuilder.make(from: payment))
  }

  // MARK: - the wire model itself

  func testLifecycleHelpersDescribeTheBackendStates() throws {
    XCTAssertTrue(try decode(paymentJSON()).isAwaitingApproval)
    XCTAssertEqual(try decode(paymentJSON()).approvalProgress, "1 of 2")

    for dead in ["INVALIDATED", "EXPIRED", "CANCELLED", "FAILED"] {
      var object = try XCTUnwrap(JSONSerialization.jsonObject(with: paymentJSON()) as? [String: Any])
      object["lifecycle"] = dead
      let payment = try decode(JSONSerialization.data(withJSONObject: object))
      XCTAssertTrue(payment.isDead, "\(dead) must read as dead")
      XCTAssertFalse(payment.isComplete)
    }
  }

  /// An unreadable chain means an unknown approval count. The UI must be able to say "unknown"
  /// rather than render a number Prism merely remembered.
  func testAnUnknownApprovalCountIsRepresentable() throws {
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: paymentJSON()) as? [String: Any])
    object["collectedApprovals"] = NSNull()
    let payment = try decode(JSONSerialization.data(withJSONObject: object))
    XCTAssertNil(payment.collectedApprovals)
    XCTAssertEqual(payment.approvalProgress, "approvals unknown")
  }
}
