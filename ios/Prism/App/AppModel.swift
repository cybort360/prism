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
  @Published var presentIdentityChange: IdentityChangeCandidate?
  @Published var presentClaimDetail: ClaimDetailPresentation?
  @Published var presentRequestDetail: RequestDetailPresentation?
  @Published var sendPickerPresented = false
  @Published var requestPickerPresented = false
  @Published var addMoneyPresented = false
  @Published var receivePresented = false
  @Published var scanPresented = false
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
