import XCTest
import WebKit

@testable import Prism

@MainActor
final class MeraWebViewFocusTests: XCTestCase {
  func testBridgeDocumentHasFocusBeforeCredentialRequest() async throws {
    let bridge = WKWebViewMeraBridge()
    _ = try await bridge.createAccount()
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    let view = try XCTUnwrap(windows.flatMap(\.subviews).compactMap { $0 as? WKWebView }.last)
    defer { view.removeFromSuperview() }
    // Replace only the dispatch endpoint to observe focus at the native-to-JS request boundary.
    // No passkey or successful account response is fabricated by this test.
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      view.evaluateJavaScript("""
        window.prismMera.dispatch = ({id}) => window.webkit.messageHandlers.prism.postMessage({
          id, ok: false, error: document.hasFocus() ? 'FOCUSED' : 'UNFOCUSED'
        });
        true;
        """) { _, error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
    }
    do {
      _ = try await bridge.restoreAccount()
      XCTFail("The observation endpoint always returns an error")
    } catch {
      XCTAssertEqual(error.localizedDescription, "FOCUSED",
        "WebKit rejects passkey create/get before presenting a sheet when the bridge document lacks focus")
    }
    XCTAssertFalse(view.isFirstResponder, "The bridge releases focus after its request finishes")
  }
}
