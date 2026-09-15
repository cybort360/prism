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
  @Published var presentRequestDetail: RequestDetailPresentation?
  @Published var sendPickerPresented = false
  @Published var requestPickerPresented = false
  @Published var addMoneyPresented = false
  @Published var sendAnywherePresented = false
  @Published var receivePresented = false
  @Published var scanPresented = false
  @Published var savePresented = false
  @Published var withdrawPresented = false
  @Published var toast: String?
  @Published var onboardingComplete = false

  init() {
    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("--uitest-reset") {
      for key in ["session", "verifiedPhone", "pin.salt", "pin.digest", "pin.iterations", "mera.dev.seed"] {
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
      if arguments.contains("--uitest-advanced-account") { selectedTab = .profile }
      if arguments.contains("--uitest-save") { savePresented = true }
    #endif
  }

  var hasSession: Bool { (try? KeychainStore.shared.string(for: "session")) != nil }

  func bootstrap() async {
    defer { isBooting = false }
    guard hasSession else { return }
    do { identity = try await PrismAPI.shared.me() } catch {
      KeychainStore.shared.delete("session")
    }
  }

  func refreshIdentity() async {
    guard hasSession else { return }
    identity = try? await PrismAPI.shared.me()
  }

  func authenticated(_ auth: AuthResponse, phone: String? = nil) {
    identity = auth.identity
    if let phone { try? KeychainStore.shared.setString(phone, for: "verifiedPhone") }
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
  }
}
