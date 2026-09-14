import XCTest

@testable import Prism

/// A displayed handle must always read "@name", never "@@name", whether or not the stored value
/// already carries the "@" (backend/stored values are inconsistent about it).
final class HandleFormatTests: XCTestCase {
  func testAddsASingleAtWhenMissing() {
    XCTAssertEqual("james".asPrismHandle, "@james")
  }
  func testDoesNotDoubleTheAtWhenPresent() {
    XCTAssertEqual("@james".asPrismHandle, "@james")
  }
  func testCollapsesAccidentalDoubleAt() {
    XCTAssertEqual("@@james".asPrismHandle, "@james")
  }
  func testEmptyBecomesJustTheAt() {
    XCTAssertEqual("".asPrismHandle, "@")
  }
}
