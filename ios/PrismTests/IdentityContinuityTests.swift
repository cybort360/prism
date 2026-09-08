import XCTest

@testable import Prism

/// Prism Continuity, client half (INV-C1 / INV-C3): reachability may change without silently changing
/// recipient identity. `IdentityTrustStore.warning` is the visible discontinuity guard — it must stay
/// silent for a legitimate alias change to the SAME identity, and it must speak up (route to review)
/// when the alias now resolves to a DIFFERENT PrismIdentity or account.
final class IdentityContinuityTests: XCTestCase {

  private let store = IdentityTrustStore.shared

  // Each test uses a fresh contact id so persisted trust records never collide.
  private func contact(_ id: String = UUID().uuidString) -> ContactPerson {
    ContactPerson(id: id, name: "Tobi", phone: nil, initials: "TB")
  }

  private func resolution(prismId: String, account: String, aliasVersion: Int) -> ResolutionResponse {
    ResolutionResponse(
      found: true, reason: nil,
      attestation: ResolutionAttestation(
        recipientAccount: account, prismIdentity: prismId, aliasVersion: aliasVersion,
        requesterPrismId: "me", requestId: "req_\(UUID().uuidString)", route: "phone",
        issuedAt: "2026-09-08T00:00:00Z", expiresAt: "2026-09-08T00:05:00Z"),
      signature: "0xsig", resolverKeyId: "resolver-v1")
  }

  private let acctA = "0x1111111111111111111111111111111111111111"
  private let acctB = "0x2222222222222222222222222222222222222222"

  override func tearDown() {
    // Leave no trust records behind (defensive; ids are unique anyway).
    store.reset(contactId: lastContactId)
    super.tearDown()
  }
  private var lastContactId = ""

  // MARK: INV-C1 — a legitimate alias change preserves continuity

  func testAliasVersionBumpToSameIdentityDoesNotWarn() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    // Recipient rotated their phone: same identity, same account, higher alias version.
    let rotated = resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 4)
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

  // MARK: INV-C3 — a different identity is visibly blocked for review

  func testChangedAccountTriggersReview() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    // Same PrismIdentity id but a different account address → still a discontinuity.
    let movedAccount = resolution(prismId: "prism-tobi", account: acctB, aliasVersion: 2)
    XCTAssertNotNil(store.warning(for: c, newResolution: movedAccount),
      "a changed payment account must be blocked for review, never silently redirected")
  }

  func testChangedIdentityTriggersReview() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    // The alias now resolves to a DIFFERENT person (number reassigned).
    let differentPerson = resolution(prismId: "prism-someone-else", account: acctB, aliasVersion: 1)
    XCTAssertNotNil(store.warning(for: c, newResolution: differentPerson),
      "an alias reassigned to a different identity must be blocked for review")
  }

  // MARK: edges

  func testFirstTimeRecipientNeverWarns() {
    let c = contact(); lastContactId = c.id
    // No prior trusted record → nothing to be discontinuous with.
    XCTAssertNil(store.warning(for: c, newResolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1)))
  }

  func testResetClearsTrustSoNextResolutionIsTreatedAsNew() {
    let c = contact(); lastContactId = c.id
    store.remember(contact: c, resolution: resolution(prismId: "prism-tobi", account: acctA, aliasVersion: 1))
    store.reset(contactId: c.id)
    // After an explicit reset (e.g. the user approved the change), a differing identity no longer warns.
    XCTAssertNil(store.warning(for: c, newResolution: resolution(prismId: "prism-someone-else", account: acctB, aliasVersion: 1)))
  }
}
