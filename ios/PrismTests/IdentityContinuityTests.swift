import XCTest

@testable import Prism

/// Prism Continuity, client integration (INV-C1 / INV-C3) through `IdentityTrustStore` — the persisted
/// trust store + the shared `PrismContinuity` classifier. Reachability may change without silently
/// changing recipient identity: a same-identity alias change (or an authenticated account rotation) is
/// silent; a different PrismIdentity — or an unconfirmable account change — must be reviewed.
final class IdentityContinuityTests: XCTestCase {

  private let store = IdentityTrustStore.shared

  private func contact(_ id: String = UUID().uuidString) -> ContactPerson {
    ContactPerson(id: id, name: "Tobi", phone: nil, initials: "TB")
  }

  // A valid (non-expired) attestation — expiry is now enforced by the classifier.
  private func resolution(prismId: String, account: String, aliasVersion: Int) -> ResolutionResponse {
    let now = Date()
    let iso = ISO8601DateFormatter()
    return ResolutionResponse(
      found: true, reason: nil,
      attestation: ResolutionAttestation(
        recipientAccount: account, prismIdentity: prismId, aliasVersion: aliasVersion,
        requesterPrismId: "me", requestId: "req_\(UUID().uuidString)", route: "phone",
        issuedAt: iso.string(from: now), expiresAt: iso.string(from: now.addingTimeInterval(120))),
      signature: "0xsig", resolverKeyId: "resolver-v1")
  }

  private let acctA = "0x1111111111111111111111111111111111111111"
  private let acctB = "0x2222222222222222222222222222222222222222"

  override func tearDown() {
    store.reset(contactId: lastContactId)
    super.tearDown()
  }
  private var lastContactId = ""

  // MARK: INV-C1 — a legitimate alias change to the same identity preserves continuity

  func testAliasVersionBumpToSameIdentityDoesNotWarn() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    let rotated = resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 4)
    XCTAssertEqual(store.state(for: c, newResolution: rotated), .continuityMatch)
    XCTAssertNil(store.warning(for: c, newResolution: rotated),
      "an alias-only change to the same identity must not trigger a discontinuity review")
  }

  func testAccountCasingChangeDoesNotWarn() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA.lowercased(), aliasVersion: 1))
    let sameButUpper = resolution(prismId: "prism-tobi", account: acctA.uppercased(), aliasVersion: 2)
    XCTAssertNil(store.warning(for: c, newResolution: sameButUpper),
      "address casing must not be read as an identity change")
  }

  /// A wallet/account rotation belonging to the SAME PrismIdentity, recorded by the resolver as an
  /// authenticated mutation (advancing alias version), is continuity — NOT a different human.
  func testAuthenticatedAccountRotationSameIdentityDoesNotWarn() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    let rotatedAccount = resolution(prismId: "prism-tobi", account: acctB, aliasVersion: 5)
    XCTAssertEqual(store.state(for: c, newResolution: rotatedAccount), .continuityMatch)
    XCTAssertNil(store.warning(for: c, newResolution: rotatedAccount),
      "a same-identity account rotation under an advancing alias version must not be treated as a different human")
  }

  // MARK: INV-C3 — a different identity, or an unconfirmable change, must be reviewed

  func testChangedIdentityTriggersReview() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    let differentPerson = resolution(prismId: "prism-someone-else", account: acctB, aliasVersion: 1)
    XCTAssertEqual(store.state(for: c, newResolution: differentPerson), .identityDiscontinuity)
    XCTAssertNotNil(store.warning(for: c, newResolution: differentPerson),
      "an alias reassigned to a different identity must be blocked for review")
  }

  /// Same identity but a changed account WITHOUT an advancing alias version is anomalous — the resolver
  /// hasn't recorded an authenticated rotation, so PRISM must not silently proceed.
  func testAccountChangeWithoutVersionAdvanceIsReviewed() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 2))
    let unconfirmed = resolution(prismId: "prism-tobi", account: acctB, aliasVersion: 2)
    XCTAssertEqual(store.state(for: c, newResolution: unconfirmed), .resolverUnavailableOrAmbiguous)
    XCTAssertNotNil(store.warning(for: c, newResolution: unconfirmed))
  }

  // MARK: edges

  func testFirstTimeRecipientNeverWarns() {
    let c = contact(); lastContactId = c.id
    let r = resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1)
    XCTAssertEqual(store.state(for: c, newResolution: r), .firstContact)
    XCTAssertNil(store.warning(for: c, newResolution: r))
  }

  func testResetClearsTrustSoNextResolutionIsTreatedAsNew() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    store.reset(contactId: c.id)
    let r = resolution(prismId: "prism-someone-else", account: acctB, aliasVersion: 1)
    XCTAssertEqual(store.state(for: c, newResolution: r), .firstContact)
    XCTAssertNil(store.warning(for: c, newResolution: r))
  }
}
