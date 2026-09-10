import XCTest

@testable import Prism

/// The refined continuity experience around `IdentityTrustStore`: the review-candidate factory (what
/// the safety surface is built from), the transparent continuity-event log for legitimate route
/// changes, and preservation of "trusted since" across rotations.
final class ContinuityUXTests: XCTestCase {
  private let store = IdentityTrustStore.shared
  private let acctA = "0x1111111111111111111111111111111111111111"
  private let acctB = "0x2222222222222222222222222222222222222222"
  private var ids: [String] = []

  override func tearDown() {
    ids.forEach { store.reset(contactId: $0) }
    ids = []
    super.tearDown()
  }

  private func contact() -> ContactPerson {
    let id = UUID().uuidString
    ids.append(id)
    return ContactPerson(id: id, name: "Tobi", phone: nil, initials: "TB")
  }
  private func resolution(prismId: String, account: String, aliasVersion: Int) -> ResolutionResponse {
    let iso = ISO8601DateFormatter()
    let now = Date()
    return ResolutionResponse(
      found: true, reason: nil,
      attestation: ResolutionAttestation(
        recipientAccount: account, prismIdentity: prismId, aliasVersion: aliasVersion,
        requesterPrismId: "me", requestId: "req_\(UUID().uuidString)", route: "phone",
        issuedAt: iso.string(from: now), expiresAt: iso.string(from: now.addingTimeInterval(120))),
      signature: "0xsig", resolverKeyId: "resolver-v1")
  }

  // MARK: review candidate factory

  func testNoReviewOnFirstContactOrLegitimateContinuity() {
    let c = contact()
    let first = resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1)
    XCTAssertNil(store.reviewCandidate(for: c, newResolution: first, action: .send), "first contact never reviews")
    store.remember(contact: c, resolution: first)
    let rotated = resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 4)
    XCTAssertNil(store.reviewCandidate(for: c, newResolution: rotated, action: .send), "same-identity alias change is silent")
  }

  func testDiscontinuityCandidateCarriesStateAndPreviousBinding() {
    let c = contact()
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    let different = resolution(prismId: "prism-someone-else", account: acctB, aliasVersion: 1)
    let candidate = store.reviewCandidate(for: c, newResolution: different, action: .send)
    XCTAssertNotNil(candidate)
    XCTAssertEqual(candidate?.state, .identityDiscontinuity)
    XCTAssertEqual(candidate?.previous?.prismId, "prism-tobi", "the review surface can show what was previously trusted")
    XCTAssertEqual(candidate?.action, .send)
  }

  func testAmbiguousChangeAlsoReviews() {
    let c = contact()
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 2))
    // Same identity, changed account, NO version advance → cannot confirm → review (fail closed).
    let unconfirmed = resolution(prismId: "prism-tobi", account: acctB, aliasVersion: 2)
    XCTAssertEqual(store.reviewCandidate(for: c, newResolution: unconfirmed, action: .send)?.state, .resolverUnavailableOrAmbiguous)
  }

  // MARK: transparent continuity-event log

  func testLegitimateRotationRecordsAContinuityEvent() {
    let c = contact()
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    let before = store.continuityEvents().count
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 2))
    let events = store.continuityEvents()
    XCTAssertEqual(events.count, before + 1)
    XCTAssertEqual(events.last?.fromAliasVersion, 1)
    XCTAssertEqual(events.last?.toAliasVersion, 2)
    XCTAssertEqual(events.last?.prismId, "prism-tobi")
  }

  func testIdentityChangeIsNotRecordedAsContinuity() {
    let c = contact()
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    let before = store.continuityEvents().count
    // A different identity is a discontinuity to be reviewed — never a silent continuity event.
    store.remember(contact: c, resolution: resolution(prismId: "prism-diff", account: acctB, aliasVersion: 1))
    XCTAssertEqual(store.continuityEvents().count, before)
  }

  func testTrustedSincePreservedAcrossRotation() {
    let c = contact()
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    let established = store.trusted(contactId: c.id)?.establishedAt
    XCTAssertNotNil(established)
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 2))
    XCTAssertEqual(store.trusted(contactId: c.id)?.establishedAt, established, "a route change must not reset when trust was first established")
    XCTAssertEqual(store.trusted(contactId: c.id)?.aliasVersion, 2, "but the current route is transparently updated")
  }
}
