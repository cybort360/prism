import XCTest

@testable import Prism

/// Every recipient surface (QR scan, universal link, shared payment link) flows through one parser,
/// so they resolve identically. These lock the supported forms and the safety rules.
final class DeepLinkTests: XCTestCase {

  func testOpaquePrismIdForms() {
    XCTAssertEqual(PrismDeepLink.parse("prism://pay/pid_123")?.prismId, "pid_123")
    XCTAssertEqual(PrismDeepLink.parse("https://prism.app/pay/pid_123")?.prismId, "pid_123")
    // Back-compat accessor.
    XCTAssertEqual(PrismDeepLink.prismId(from: "prism://pay/pid_123"), "pid_123")
  }

  func testPrettyHandleForms() {
    XCTAssertEqual(PrismDeepLink.parse("https://prism.app/octane")?.handle, "octane")
    XCTAssertEqual(PrismDeepLink.parse("https://prism.app/@octane")?.handle, "octane")
    XCTAssertEqual(PrismDeepLink.parse("prism://u/octane")?.handle, "octane")
    // A handle link carries no prismId; resolution happens through the handle resolver.
    XCTAssertNil(PrismDeepLink.parse("https://prism.app/octane")?.prismId)
  }

  func testAmountAndReferenceAreParsed() {
    let link = PrismDeepLink.parse("https://prism.app/octane?amount=20&ref=dinner")
    XCTAssertEqual(link?.handle, "octane")
    XCTAssertEqual(link?.amount, "20")
    XCTAssertEqual(link?.reference, "dinner")
  }

  func testReservedWordsAreNotHandles() {
    // Reserved routes must never be mistaken for a handle.
    XCTAssertNil(PrismDeepLink.parse("https://prism.app/pay")?.handle)
    XCTAssertNil(PrismDeepLink.parse("https://prism.app/claim")?.handle)
  }

  func testInvalidInputsReturnNil() {
    XCTAssertNil(PrismDeepLink.parse("https://example.com/random/deep/path"))
    XCTAssertNil(PrismDeepLink.parse("not a url at all %%%"))
    XCTAssertNil(PrismDeepLink.parse("mailto:someone@example.com"))
  }

  func testNonPositiveAmountIsDropped() {
    // A junk/zero/negative amount is ignored rather than prefilled.
    XCTAssertNil(PrismDeepLink.parse("https://prism.app/octane?amount=0")?.amount)
    XCTAssertNil(PrismDeepLink.parse("https://prism.app/octane?amount=-5")?.amount)
    XCTAssertNil(PrismDeepLink.parse("https://prism.app/octane?amount=abc")?.amount)
  }
}
