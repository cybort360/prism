import XCTest

@testable import Prism

/// A restarted onboarding must resume past aliases the identity already holds — not ask again and
/// then call the user's own reserved handle "taken".
final class OnboardingResumeTests: XCTestCase {
  private func identity(handle: String? = nil, phone: Bool? = nil) -> PrismIdentity {
    PrismIdentity(prismId: "p1", handle: handle, aliasVersion: 2, hasVerifiedPhone: phone)
  }

  func testFreshIdentityStartsAtReachability() {
    let plan = OnboardingResume.plan(for: identity())
    XCTAssertEqual(plan, .init(step: .reachability, firstAlias: nil, addingSecond: false))
    XCTAssertEqual(OnboardingResume.plan(for: nil).step, .reachability)
  }

  func testReservedHandleResumesAtSecondAlias() {
    // The tester's case: handle reserved, phone step abandoned.
    let plan = OnboardingResume.plan(for: identity(handle: "@keone"))
    XCTAssertEqual(plan, .init(step: .secondAlias, firstAlias: .handle, addingSecond: false))
  }

  func testVerifiedPhoneResumesAtSecondAlias() {
    let plan = OnboardingResume.plan(for: identity(phone: true))
    XCTAssertEqual(plan, .init(step: .secondAlias, firstAlias: .phone, addingSecond: false))
  }

  func testBothAliasesSkipToContacts() {
    let plan = OnboardingResume.plan(for: identity(handle: "@keone", phone: true))
    XCTAssertEqual(plan.step, .contacts)
    XCTAssertTrue(plan.addingSecond)
  }

  func testOwnHandleIsNormalized() {
    XCTAssertEqual(OnboardingResume.ownHandle(identity(handle: "@KeoneHD")), "keonehd")
    XCTAssertNil(OnboardingResume.ownHandle(identity(handle: "")))
    XCTAssertNil(OnboardingResume.ownHandle(nil))
  }
}
