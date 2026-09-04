import XCTest

/// Drives the real onboarding flow (real WKWebView Mera bridge + backend) and captures the exact
/// error at the OTP step. Requires the dev backend running on 127.0.0.1:8787 — CI starts one in the
/// iOS job before invoking xcodebuild.
///
/// `@MainActor` on the test method: every XCUI API (`XCUIApplication`, `buttons`, `tap()`, …) is
/// main-actor isolated under Swift 6, so a nonisolated test body cannot touch any of them. The
/// annotation goes on the method rather than the type so the `setUp()` override keeps XCTestCase's
/// own nonisolated isolation.
final class OnboardingFlowUITests: XCTestCase {
  override func setUp() { continueAfterFailure = true }

  @MainActor
  func testPhoneOnboardingReachesHome() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--uitest-reset"]
    app.launch()

    // Story: advance through the pages, then Get started.
    _ = app.buttons.firstMatch.waitForExistence(timeout: 8)
    for _ in 0..<5 {
      if app.buttons["Get started"].exists { break }
      let cont = app.buttons["Continue"]
      if cont.exists { cont.tap(); usleep(500_000) }
    }
    let getStarted = app.buttons["Get started"]
    if !getStarted.waitForExistence(timeout: 5) {
      XCTFail("no Get started. buttons=[" + app.buttons.allElementsBoundByIndex.map { $0.label }.joined(separator: ", ") + "]")
      return
    }
    getStarted.tap()

    // Reachability: choose phone (first WKWebView account creation can take a while).
    let phoneChoice = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Use my phone number'")).firstMatch
    if !phoneChoice.waitForExistence(timeout: 60) {
      XCTFail("no reachability. buttons=[" + app.buttons.allElementsBoundByIndex.map { $0.label }.joined(separator: ", ") + "]")
      return
    }
    phoneChoice.tap()

    // Phone entry.
    let field = app.textFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5), "phone field")
    field.tap()
    // Unique 11-digit Nigerian local number per run so repeated runs don't collide on a bound phone.
    let phone = "080" + (0..<8).map { _ in String(Int.random(in: 0...9)) }.joined()
    field.typeText(phone)
    app.buttons["Continue"].firstMatch.tap()

    // OTP.
    XCTAssertTrue(app.staticTexts["Enter the code"].waitForExistence(timeout: 8), "OTP screen")
    for digit in ["1", "2", "3", "4", "5", "6"] {
      let key = app.buttons[digit]
      XCTAssertTrue(key.waitForExistence(timeout: 3), "digit \(digit)")
      key.tap()
    }
    app.buttons["Verify"].tap()

    // Either an alert (error) or the next screen. Capture the alert message if present.
    let alert = app.alerts.firstMatch
    let secondAlias = app.staticTexts["Add a public\n@handle too?"]
    let contacts = app.staticTexts["Find people\nyou know"]
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
      if alert.exists {
        let message = alert.staticTexts.allElementsBoundByIndex.map { $0.label }.joined(separator: " | ")
        XCTFail("OTP alert appeared: \(message)")
        return
      }
      if secondAlias.exists || contacts.exists { return } // success: advanced past OTP
      usleep(300_000)
    }
    XCTFail("Timed out after Verify with no alert and no advance")
  }
}
