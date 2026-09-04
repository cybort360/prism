import Foundation
import UIKit
import WebKit

/// Production `MeraAccountService`. Hosts the official `@category-labs/mera` TypeScript library
/// inside an offscreen WKWebView and exposes only a narrow command channel to Swift.
///
/// Why a WebView bridge: Mera is a first-party TypeScript library with no pure-Swift API, and its
/// account derivation uses the WebAuthn PRF extension. A native iOS app reuses the exact same
/// passkeys through the platform's WebAuthn support inside WKWebView, so Prism runs the *official*
/// implementation rather than re-deriving accounts itself. Passkey secrets and the derived root
/// never leave the WebView; only public addresses and signatures cross into Swift, and nothing
/// key-related is ever sent to the Prism backend.
///
/// The web payload is built from `ios/MeraBridge/web` (see BUILD.md). If the bundle is absent the
/// bridge fails with an actionable error instead of silently degrading.
@MainActor
final class WKWebViewMeraBridge: NSObject, MeraAccountService {
  private var webView: WKWebView?
  private var ready = false
  private var pending: [String: CheckedContinuation<Data?, Error>] = [:]
  private var loadContinuation: CheckedContinuation<Void, Error>?
  // Cached ONCE per app run so every dev call derives the exact same account, independent of any
  // WebView/JS state (which does not reliably survive WebContent process reloads).
  private lazy var devSeedValue: String = Self.stableDevSeed()

  private func ensureLoaded() async throws {
    if ready { return }
    if webView == nil { try await load() }
  }

  /// A persisted 32-byte hex seed for the simulator dev signer, so the derived dev account is
  /// identical across every bridge call and page reload (device builds use real passkeys instead).
  private static func stableDevSeed() -> String {
    let key = "mera.dev.seed"
    if let existing = try? KeychainStore.shared.string(for: key), existing.hasPrefix("0x"), existing.count == 66 {
      return existing
    }
    var bytes = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
    let seed = "0x" + bytes.map { String(format: "%02x", $0) }.joined()
    try? KeychainStore.shared.setString(seed, for: key)
    return seed
  }

  private func load() async throws {
    let config = WKWebViewConfiguration()
    let controller = WKUserContentController()
    controller.add(self, name: "prism")
    #if targetEnvironment(simulator)
      // Enables the dev-seeded signer (no passkey) for simulator/testnet demos. See BUILD.md.
      // A stable, persisted seed guarantees the SAME dev account on every call and page reload,
      // so onboarding and later signing recover to one identity.
      let seed = Self.stableDevSeed()
      controller.addUserScript(WKUserScript(source: "window.PRISM_MERA_DEV = true; window.PRISM_DEV_SEED = \"\(seed)\";", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    #endif
    config.userContentController = controller
    // WebAuthn/passkeys require an https relying-party origin; the bundle is served under one.
    let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
    view.navigationDelegate = self
    webView = view

    // Attach the web view to the key window (hidden, non-interactive). An offscreen WKWebView that
    // is not in the view hierarchy has its WebContent process throttled/suspended, which stalls JS
    // execution; attaching it keeps the process alive so signing is prompt.
    attachToWindow(view)

    guard let url = Bundle.main.url(forResource: "mera-bridge", withExtension: "html", subdirectory: "MeraWeb")
        ?? Bundle.main.url(forResource: "mera-bridge", withExtension: "html") else {
      throw MeraBridgeError.bridge("Mera web bundle missing. Build it: see ios/MeraBridge/web/BUILD.md")
    }
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
      loadContinuation = cont
      view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }
  }

  private func attachToWindow(_ view: WKWebView) {
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive } ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    guard let window = scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first else { return }
    view.alpha = 0.01
    view.isUserInteractionEnabled = false
    view.isHidden = false
    window.addSubview(view)
  }

  private func call(_ method: String, _ params: [String: Any] = [:]) async throws -> Data? {
    try await ensureLoaded()
    guard let webView else { throw MeraBridgeError.notReady }
    let id = UUID().uuidString
    var params = params
    #if targetEnvironment(simulator)
      // Stateless dev signing: the same cached seed rides every call, so the derived account is
      // constant regardless of JS/WebView state. Device builds ignore this and use real passkeys.
      params["devPk"] = devSeedValue
    #endif
    let payload: [String: Any] = ["id": id, "method": method, "params": params]
    let json = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
    return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data?, Error>) in
      pending[id] = cont
      // Report a missing/broken bundle synchronously instead of leaving the caller hanging.
      let js = "(function(){ if(!window.prismMera){return 'no-bridge';} window.prismMera.dispatch(\(json)); return 'ok'; })()"
      webView.evaluateJavaScript(js) { result, error in
        if let error { self.resume(id, .failure(MeraBridgeError.bridge(error.localizedDescription))) }
        else if (result as? String) == "no-bridge" {
          self.resume(id, .failure(MeraBridgeError.bridge("Mera bridge failed to load. Build it: ios/MeraBridge/web/BUILD.md")))
        }
      }
    }
  }

  private func resume(_ id: String, _ result: Result<Data?, Error>) {
    guard let cont = pending.removeValue(forKey: id) else { return }
    switch result {
    case .success(let value): cont.resume(returning: value)
    case .failure(let error): cont.resume(throwing: error)
    }
  }

  // MARK: MeraAccountService

  func createAccount() async throws -> PrismMeraAccount { try account(from: await call("createAccount")) }
  func restoreAccount() async throws -> PrismMeraAccount { try account(from: await call("restoreAccount")) }

  func signTypedData(_ typedData: Data) async throws -> Data {
    let typed = try JSONSerialization.jsonObject(with: typedData)
    return try signature(from: await call("signTypedData", ["typedData": typed]))
  }

  func signMessage(_ message: Data) async throws -> Data {
    let text = String(data: message, encoding: .utf8) ?? message.hexString
    return try signature(from: await call("signMessage", ["message": text]))
  }

  func createSession(_ options: MeraSessionOptions) async throws {
    _ = try await call("createSession", ["scope": options.scope.rawValue, "ttlSeconds": options.ttlSeconds])
  }
  func revokeSession() async throws { _ = try await call("revokeSession") }

  private func account(from data: Data?) throws -> PrismMeraAccount {
    guard let data, let dict = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any],
          let address = dict["address"] as? String else {
      throw MeraBridgeError.bridge("Mera bridge returned no account address")
    }
    return PrismMeraAccount(address: address)
  }
  private func signature(from data: Data?) throws -> Data {
    guard let data, let hex = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? String,
          let sig = hex.hexData else {
      throw MeraBridgeError.bridge("Mera bridge returned no signature")
    }
    return sig
  }
}

extension WKWebViewMeraBridge: WKScriptMessageHandler {
  // WebKit delivers script messages on the main actor and `WKScriptMessage.body` is main-actor
  // isolated, so this cannot be `nonisolated` — the class's own @MainActor isolation is correct
  // here, and it lets the continuation resume directly instead of hopping through a Task.
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let id = body["id"] as? String else { return }
    let ok = body["ok"] as? Bool ?? false
    let errorText = body["error"] as? String
    // Re-serialize the result into JSON Data so nothing non-Sendable is retained past this call.
    let resultData: Data? = body["result"].flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
    if ok { resume(id, .success(resultData)) }
    else { resume(id, .failure(MeraBridgeError.bridge(errorText ?? "Mera error"))) }
  }
}

extension WKWebViewMeraBridge: WKNavigationDelegate {
  nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Task { @MainActor in
      self.ready = true
      self.loadContinuation?.resume(); self.loadContinuation = nil
    }
  }
  nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    Task { @MainActor in self.loadContinuation?.resume(throwing: MeraBridgeError.bridge(error.localizedDescription)); self.loadContinuation = nil }
  }
}
