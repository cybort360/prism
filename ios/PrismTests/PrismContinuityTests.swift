import XCTest

@testable import Prism

/// Platform-independent tests for the PRISM Continuity classifier — mirrors
/// backend/test/continuity.test.js so the two implementations can't drift. Pure, deterministic.
final class PrismContinuityTests: XCTestCase {

  private let acctA = "0xAAaa00000000000000000000000000000000AAaa"
  private let acctB = "0xBBbb00000000000000000000000000000000BBbb"
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  private func resolution(prismId: String = "prism-A", account: String = "0xAAaa00000000000000000000000000000000AAaa",
                          aliasVersion: Int = 1, expiresInSec: TimeInterval = 120, found: Bool = true) -> ResolutionResponse {
    let iso = ISO8601DateFormatter()
    return ResolutionResponse(
      found: found, reason: nil,
      attestation: found ? ResolutionAttestation(
        recipientAccount: account, prismIdentity: prismId, aliasVersion: aliasVersion,
        requesterPrismId: "payer", requestId: "res_abc", route: "phone",
        issuedAt: iso.string(from: now), expiresAt: iso.string(from: now.addingTimeInterval(expiresInSec))) : nil,
      signature: "0xsig", resolverKeyId: "resolver-v1")
  }
  private func known(prismId: String = "prism-A", account: String = "0xAAaa00000000000000000000000000000000AAaa",
                     aliasVersion: Int = 1) -> KnownRecipientBinding {
    KnownRecipientBinding(prismId: prismId, account: account, aliasVersion: aliasVersion)
  }
  private func classify(_ r: ResolutionResponse, _ k: KnownRecipientBinding?, signatureValid: Bool = true,
                        currentAliasVersion: Int? = nil, ambiguous: Bool = false) -> PrismContinuityState {
    PrismContinuity.classify(known: k, resolution: r, now: now, signatureValid: signatureValid,
                             currentAliasVersion: currentAliasVersion, ambiguous: ambiguous)
  }

  // A — FIRST_CONTACT
  func testFirstResolutionIsFirstContact() {
    XCTAssertEqual(classify(resolution(), nil), .firstContact)
  }

  // B — CONTINUITY_MATCH: same identity + same alias
  func testSameIdentitySameAliasIsContinuity() {
    XCTAssertEqual(classify(resolution(aliasVersion: 1), known(aliasVersion: 1)), .continuityMatch)
  }

  // B — CONTINUITY_MATCH: same identity + rotated alias
  func testSameIdentityRotatedAliasIsContinuity() {
    XCTAssertEqual(classify(resolution(aliasVersion: 4), known(aliasVersion: 1)), .continuityMatch)
  }

  // B — CONTINUITY_MATCH: same identity + rotated account under an advancing (authenticated) version
  func testSameIdentityRotatedAccountIsContinuity() {
    XCTAssertEqual(classify(resolution(account: acctB, aliasVersion: 5), known(account: acctA, aliasVersion: 1)), .continuityMatch)
  }

  // Guard: same identity + account change without version advance → ambiguous, fail closed
  func testAccountChangeWithoutVersionAdvanceIsAmbiguous() {
    XCTAssertEqual(classify(resolution(account: acctB, aliasVersion: 1), known(account: acctA, aliasVersion: 1)), .resolverUnavailableOrAmbiguous)
  }

  // C — IDENTITY_DISCONTINUITY
  func testDifferentIdentityIsDiscontinuity() {
    XCTAssertEqual(classify(resolution(prismId: "prism-B", account: acctB), known(prismId: "prism-A", account: acctA)), .identityDiscontinuity)
  }

  // D — STALE_RESOLUTION: superseded version
  func testSupersededVersionIsStale() {
    XCTAssertEqual(classify(resolution(aliasVersion: 2), known(), currentAliasVersion: 3), .staleResolution)
  }

  // D — STALE_RESOLUTION: expired attestation
  func testExpiredAttestationIsStale() {
    XCTAssertEqual(classify(resolution(expiresInSec: -1), known()), .staleResolution)
  }

  // D — STALE_RESOLUTION: invalid resolver signature
  func testInvalidSignatureIsStale() {
    XCTAssertEqual(classify(resolution(), known(), signatureValid: false), .staleResolution)
  }

  // D — STALE_RESOLUTION: revoked alias (live version advanced past the attestation)
  func testRevokedAliasIsStale() {
    XCTAssertEqual(classify(resolution(aliasVersion: 1), known(), currentAliasVersion: 2), .staleResolution)
  }

  // E — RESOLVER_UNAVAILABLE_OR_AMBIGUOUS
  func testAmbiguityIsUnavailable() {
    XCTAssertEqual(classify(resolution(), known(), ambiguous: true), .resolverUnavailableOrAmbiguous)
  }
  func testNotFoundIsUnavailable() {
    XCTAssertEqual(classify(resolution(found: false), known()), .resolverUnavailableOrAmbiguous)
  }

  // Fail-closed ordering: freshness is checked before identity.
  func testFreshnessBeforeIdentity() {
    XCTAssertEqual(classify(resolution(prismId: "prism-B", expiresInSec: -1), known()), .staleResolution)
  }
}
