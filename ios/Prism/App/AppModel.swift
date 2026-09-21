import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
  @Published var identity: PrismIdentity?
  @Published var isBooting = true
  @Published var selectedTab: MainTab = .home
  @Published var presentSend: SendTarget?
  @Published var presentRequest: SendTarget?
  @Published var presentClaim: ClaimRecord?
  @Published var presentUnregistered: ContactPerson?
  @Published var presentReceipt: ReceiptPresentation?
  @Published var presentPaymentDetails: PaymentDetailsPresentation?
  @Published var presentIdentityChange: IdentityChangeCandidate?
  @Published var presentClaimDetail: ClaimDetailPresentation?
  /// Circles. Adding money and proposing a payment are separate sheets because they are separate
  /// authorities: one needs only the contributor's own consent, the other needs the Circle's.
  @Published var presentCircleAddMoney: CircleSummary?
  @Published var presentCirclePay: CirclePayTarget?
  @Published var presentCircleApproval: CircleApprovalPresentation?
  /// The Circle being looked at. A full-screen place rather than a sheet, because a Circle is
  /// somewhere a person stays — with its own members, settings and history to move between.
  @Published var presentCircleDetail: CircleSummary?
  @Published var presentCircleCreate = false
  @Published var presentRequestDetail: RequestDetailPresentation?
  @Published var sendPickerPresented = false
  @Published var requestPickerPresented = false
  @Published var addMoneyPresented = false
  @Published var sendAnywherePresented = false
  @Published var receivePresented = false
  @Published var scanPresented = false
  @Published var savePresented = false
  @Published var withdrawPresented = false
  @Published var saveDetailsPresented = false
  @Published var presentSaveReceipt: SaveReceiptPresentation?
  /// Profile & Settings, reached from the top-left avatar on Home rather than a bottom tab.
  @Published var presentProfile = false
  @Published var toast: String?
  @Published var onboardingComplete = false

  init() {
    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("--uitest-reset") {
      for key in ["session", "verifiedPhone", "pin.salt", "pin.digest", "pin.iterations", "mera.dev.seed", "device.account"] {
        KeychainStore.shared.delete(key)
      }
      for key in ["onboarding.complete", "payments.faceID", "pin.kdfVersion", "pin.failures", "pin.lockedUntil", "pin.lockouts"] {
        UserDefaults.standard.removeObject(forKey: key)
      }
    }
    onboardingComplete = UserDefaults.standard.bool(forKey: "onboarding.complete")

    #if DEBUG
      sendPickerPresented = arguments.contains("--uitest-send-picker")
      requestPickerPresented = arguments.contains("--uitest-request-picker")
      if arguments.contains("--uitest-advanced-account") { presentProfile = true }
      if arguments.contains("--uitest-save") { savePresented = true }
      if arguments.contains("--uitest-withdraw") { withdrawPresented = true }
      if arguments.contains("--uitest-save-details") { saveDetailsPresented = true }
      if arguments.contains("--uitest-save-receipt") { presentSaveReceipt = SaveReceiptPresentation(operationId: "demo") }
      if arguments.contains("--uitest-circles-tab") { selectedTab = .circles }
      if arguments.contains("--uitest-circle-create") { selectedTab = .circles; presentCircleCreate = true }
      // Review-only: render the main shell without a real backend session (for screenshots of a
      // logged-in surface). Never used in a shipping build.
      if arguments.contains("--uitest-preview-home") {
        onboardingComplete = true
        identity = PrismIdentity(prismId: "preview", displayName: "James", handle: "james", accountAddress: "0x0000000000000000000000000000000000000001", aliasVersion: 1)
      }
      // Review-only: force the returning-user story (device already has an account, no session), so the
      // "Already have an account? Sign in" affordance renders. Seeds the durable marker deviceHasAccount reads.
      if arguments.contains("--uitest-returning-story") {
        try? KeychainStore.shared.setString("0x0000000000000000000000000000000000000001", for: Self.deviceAccountKey)
        onboardingComplete = false
        identity = nil
      }
    #endif
  }

  var hasSession: Bool { (try? KeychainStore.shared.string(for: "session")) != nil }

  /// Durable marker that an account was established on this device (its address). Set at authentication
  /// and deliberately NOT cleared by sign-out, so a returning user can be offered "Sign in". Its
  /// lifecycle matches the Mera signer (dev seed / passkey), which is what actually recovers the account.
  static let deviceAccountKey = "device.account"

  /// True when this device has onboarded an account before — i.e. a returning user who signed out.
  /// Gates the "Already have an account? Sign in" affordance on the onboarding story.
  var deviceHasAccount: Bool { (try? KeychainStore.shared.string(for: Self.deviceAccountKey)) != nil }

  private var authObserver: NSObjectProtocol?

  func bootstrap() async {
    registerAuthObserver()
    defer { isBooting = false }
    guard hasSession else { return }
    do { identity = try await PrismAPI.shared.me() } catch {
      KeychainStore.shared.delete("session")
    }
  }

  /// When any authed request 401s, the session is gone — end it cleanly and return to sign-in, instead
  /// of leaving the app showing "missing session" on every screen.
  private func registerAuthObserver() {
    guard authObserver == nil else { return }
    authObserver = NotificationCenter.default.addObserver(forName: .prismUnauthorized, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.sessionExpired() }
    }
  }

  func sessionExpired() {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--uitest-preview-home") { return } // review hook: no real session
    #endif
    guard hasSession || identity != nil else { return }
    signOut()
    notify("Your session ended. Please sign in again.")
  }

  func refreshIdentity() async {
    guard hasSession else { return }
    identity = try? await PrismAPI.shared.me()
  }

  func authenticated(_ auth: AuthResponse, phone: String? = nil) {
    identity = auth.identity
    if let phone { try? KeychainStore.shared.setString(phone, for: "verifiedPhone") }
    // Durable "an account exists on this device" marker — survives sign-out so we can offer re-login.
    if let account = auth.identity.accountAddress {
      try? KeychainStore.shared.setString(account, for: Self.deviceAccountKey)
    }
  }

  func updateIdentity(_ value: PrismIdentity) { identity = value }

  /// Resolve a Prism recipient link/QR through the SAME resolver used by contacts, then open the Send
  /// review (never an instant send). Returns an error string on failure, or nil on success.
  /// `entryMethod` records how the recipient was reached (.qr for a scan, .paymentLink for a link).
  func openPaymentLink(_ raw: String, entryMethod: PrismEntryMethod) async -> String? {
    guard let link = PrismDeepLink.parse(raw) else { return "That isn't a Prism payment link." }
    do {
      let resolution: ResolutionResponse
      if let id = link.prismId {
        resolution = try await PrismAPI.shared.resolve(prismId: id)
      } else if let handle = link.handle {
        resolution = try await PrismAPI.shared.resolve(handle: handle)
      } else {
        return "That isn't a Prism payment link."
      }
      guard resolution.found else { return "This Prism account is unavailable." }
      let display = link.handle.map { "@\($0)" } ?? "Prism recipient"
      let initials = link.handle.map { String($0.prefix(2)).uppercased() } ?? "PR"
      let contact = ContactPerson(
        id: "link:\(link.handle ?? link.prismId ?? UUID().uuidString)",
        name: display, phone: nil, initials: initials, handle: link.handle.map { "@\($0)" },
        prismState: .onPrism(resolution))
      presentSend = SendTarget(
        contact: contact, resolution: resolution,
        initialAmount: link.amount, initialMemo: link.reference, entryMethod: entryMethod)
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  func notify(_ message: String) {
    toast = message
    Task {
      try? await Task.sleep(for: .seconds(2.5))
      if toast == message { toast = nil }
    }
  }

  func finishOnboarding() {
    UserDefaults.standard.set(true, forKey: "onboarding.complete")
    onboardingComplete = true
  }

  func signOut() {
    KeychainStore.shared.delete("session")
    UserDefaults.standard.set(false, forKey: "onboarding.complete")
    onboardingComplete = false
    identity = nil
    selectedTab = .home
    presentProfile = false
  }
}
