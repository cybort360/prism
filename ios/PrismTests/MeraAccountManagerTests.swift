import XCTest

@testable import Prism

@MainActor
final class MeraAccountManagerTests: XCTestCase {
  func testFailedRestoreDoesNotCreateAnotherAccount() async {
    let service = AccountServiceSpy()
    service.restoreError = MeraBridgeError.bridge("Passkey request dismissed")
    let manager = MeraAccountManager(service: service)
    do {
      _ = try await manager.ensureAccount()
      XCTFail("Restore failure must propagate")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Passkey request dismissed")
    }
    XCTAssertNil(manager.account)
    XCTAssertEqual(service.restoreCount, 1)
    XCTAssertEqual(service.createCount, 0)
  }

  func testExplicitCreationIsReusedWithoutRestore() async throws {
    let service = AccountServiceSpy()
    let manager = MeraAccountManager(service: service)
    let created = try await manager.createAccount()
    let reused = try await manager.ensureAccount()
    XCTAssertEqual(created, reused)
    XCTAssertEqual(service.createCount, 1)
    XCTAssertEqual(service.restoreCount, 0)
  }

  func testSuccessfulRestoreIsCached() async throws {
    let service = AccountServiceSpy()
    let manager = MeraAccountManager(service: service)
    let restored = try await manager.ensureAccount()
    let reused = try await manager.ensureAccount()
    XCTAssertEqual(restored, reused)
    XCTAssertEqual(service.restoreCount, 1)
    XCTAssertEqual(service.createCount, 0)
  }
}

@MainActor
private final class AccountServiceSpy: MeraAccountService {
  var createCount = 0
  var restoreCount = 0
  var restoreError: Error?
  private let account = PrismMeraAccount(address: "0x1111111111111111111111111111111111111111")

  func createAccount() async throws -> PrismMeraAccount { createCount += 1; return account }
  func restoreAccount() async throws -> PrismMeraAccount {
    restoreCount += 1
    if let restoreError { throw restoreError }
    return account
  }
  func signTypedData(_ typedData: Data) async throws -> Data { throw MeraBridgeError.noAccount }
  func signMessage(_ message: Data) async throws -> Data { throw MeraBridgeError.noAccount }
  func createSession(_ options: MeraSessionOptions) async throws {}
  func revokeSession() async throws {}
}
