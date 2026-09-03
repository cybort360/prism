import XCTest

@testable import Prism

final class MoneyTests: XCTestCase {
  func testAtomicConversion() {
    XCTAssertEqual(Money.atomic(fromDollars: "20.00"), "20000000")
    XCTAssertEqual(Money.dollars(fromAtomic: "20000000"), "$20.00")
  }
  func testZeroIsNotPayable() { XCTAssertNil(Money.atomic(fromDollars: "0")) }
}
