import SwiftUI
import UIKit

struct ProfileView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var phoneDiscoverable = true
  @State private var handleSearchable = true
  @State private var showSecurity = false
  @State private var showRecovery = false
  @State private var showReachability = false
  @State private var showEditProfile = false
  @State private var showProof = false
  @State private var showP256 = false
  @State private var showContinuityLab = false
  @State private var showAdvanced = false
  @State private var error: String?
  // Advanced (web3) surfaces, hidden from everyday users. Off by default.
  @AppStorage("feature.crossChainSend") private var crossChainSend = false
  @AppStorage("feature.addMoneyDeposit") private var addMoneyDeposit = false

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(spacing: 0) {
        HStack {
          PrismHeaderIconButton(icon: "xmark") { dismiss() }
            .accessibilityLabel("Close")
          Spacer()
          PrismHeaderIconButton(icon: "gearshape") { showSecurity = true }
        }
        .padding(.horizontal, 22)
        .padding(.top, 10)

        Button { showEditProfile = true } label: {
          ZStack(alignment: .bottomTrailing) {
            PrismAvatar(initials: profileInitials, size: 82, highlighted: true, tone: PrismTheme.mintSoft)
            Circle().fill(PrismTheme.paper).frame(width: 27, height: 27)
              .overlay(Image(systemName: "pencil").font(.system(size: 10, weight: .semibold)).foregroundStyle(PrismTheme.teal))
              .overlay(Circle().stroke(PrismTheme.line, lineWidth: 0.7))
          }
        }.buttonStyle(.plain)

        Text(profileName)
          .font(PrismTheme.display(30))
          .tracking(-0.5)
          .padding(.top, 13)

        Text(model.identity?.handle ?? "No public handle")
          .font(PrismTheme.body(12.5))
          .foregroundStyle(PrismTheme.muted)
          .padding(.top, 2)

        PrismStatusPill(text: "Prism identity active", tone: .positive)
          .padding(.top, 11)

        section("Reachability") {
          settingsButton {
            showReachability = true
          } content: {
            row("phone", "Phone", model.identity?.phoneMasked ?? "Not connected", model.identity?.hasVerifiedPhone == true ? "Verified" : nil)
          }
          divider
          settingsButton { showReachability = true } content: {
            row("at", "Prism handle", model.identity?.handle ?? "Add handle", model.identity?.handle != nil ? "Public" : nil)
          }
          divider
          settingsButton { model.receivePresented = true } content: {
            row("qrcode", "Payment QR", "Show QR", nil)
          }
          divider
          settingsButton { model.receivePresented = true } content: {
            row("link", "Payment link", "Share", nil)
          }
        }

        section("Security") {
          settingsButton { showSecurity = true } content: {
            row("faceid", "Face ID", UserDefaults.standard.bool(forKey: "payments.faceID") ? "On" : "Off", nil)
          }
          divider
          settingsButton { showSecurity = true } content: {
            row("lock", "Payment PIN", "••••••", nil)
          }
          divider
          settingsButton { showSecurity = true } content: {
            row("iphone", "Trusted devices", "This iPhone", nil)
          }
          divider
          settingsButton { showRecovery = true } content: {
            row("lifepreserver", "Recovery", "Review", nil)
          }
        }

        section("Privacy") {
          Toggle("Allow people in my contacts to find me", isOn: $phoneDiscoverable)
            .tint(PrismTheme.mintDeep)
            .font(PrismTheme.body(13))
            .padding(.vertical, 10)
            .onChange(of: phoneDiscoverable) { _, _ in Task { await savePrivacy() } }
          divider
          Toggle("Make @handle searchable", isOn: $handleSearchable)
            .tint(PrismTheme.mintDeep)
            .font(PrismTheme.body(13))
            .padding(.vertical, 10)
            .onChange(of: handleSearchable) { _, _ in Task { await savePrivacy() } }
        }

        section("Advanced") {
          advancedToggle(
            "Send to another network", isOn: $crossChainSend,
            caption: "Pay any wallet on any chain. Off while cross-chain settlement is in preview.")
          divider
          advancedToggle(
            "Add money by crypto transfer", isOn: $addMoneyDeposit,
            caption: "Fund with an on-chain deposit. Off by default. Adding money with a card is coming soon.")
        }

        section("Account") {
          row("checkmark.seal", "Signing", "Secured by passkey", nil)
          divider
          settingsButton { showAdvanced = true } content: {
            row("key.horizontal", "Advanced", "Wallet details", nil)
          }
          divider
          row("arrow.triangle.2.circlepath", "Reachability updates", "\(model.identity?.aliasVersion ?? 0)", nil)
        }

        #if DEBUG
        section("Developer") {
          settingsButton { showProof = true } content: {
            row("checkmark.seal.fill", "Payment proof", "Chain + Envio", nil)
          }
          divider
          settingsButton { showP256 = true } content: {
            row("lock.shield", "Device-key account", "Pay via on-chain P-256", nil)
          }
          divider
          settingsButton { showContinuityLab = true } content: {
            row("shield.lefthalf.filled", "Continuity Lab", "Baseline vs PRISM", nil)
          }
        }
        #endif

        if let error {
          ErrorBanner(message: error)
            .padding(.horizontal, 22)
            .padding(.top, 16)
        }

        Button("Sign out", role: .destructive) { model.signOut() }
          .font(PrismTheme.body(13.5, weight: .semibold))
          .padding(.vertical, 30)
      }
      .padding(.bottom, 20)
    }
    .task {
      phoneDiscoverable = model.identity?.phoneDiscoverable ?? true
      handleSearchable = model.identity?.handleSearchable ?? true
    }
    .sheet(isPresented: $showSecurity) { SecurityCenterView() }
    .sheet(isPresented: $showRecovery) { RecoveryView() }
    .sheet(isPresented: $showReachability) { ReachabilityEditorView() }
    .sheet(isPresented: $showEditProfile) { ProfileNameEditorView() }
    .sheet(isPresented: $showAdvanced) { AdvancedAccountView() }
    #if DEBUG
    .sheet(isPresented: $showProof) { ProofView() }
    .sheet(isPresented: $showP256) { P256PayView() }
    .sheet(isPresented: $showContinuityLab) { ContinuityLabView() }
    .onAppear {
      if ProcessInfo.processInfo.arguments.contains("--uitest-advanced-account") {
        showAdvanced = true
      }
    }
    #endif
    .prismScreen()
  }


  private var profileName: String {
    if let name = model.identity?.displayName, !name.isEmpty { return name }
    if let handle = model.identity?.handle {
      return handle.replacingOccurrences(of: "@", with: "").replacingOccurrences(of: "_", with: " ").capitalized
    }
    return "Prism user"
  }

  private var profileInitials: String {
    let parts = profileName.split(separator: " ").prefix(2)
    let value = parts.compactMap { $0.first }.map(String.init).joined().uppercased()
    return value.isEmpty ? "P" : value
  }

  private var divider: some View {
    Divider().overlay(PrismTheme.line)
  }

  private func advancedToggle(_ title: String, isOn: Binding<Bool>, caption: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Toggle(title, isOn: isOn)
        .tint(PrismTheme.mintDeep)
        .font(PrismTheme.body(13, weight: .semibold))
      Text(caption)
        .font(PrismTheme.body(11.5))
        .foregroundStyle(PrismTheme.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 10)
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: title)
      VStack(spacing: 0) { content() }
        .padding(.horizontal, 15)
        .padding(.vertical, 3)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
        .prismCardShadow()
    }
    .padding(.horizontal, 22)
    .padding(.top, 27)
  }

  private func settingsButton<Content: View>(action: @escaping () -> Void, @ViewBuilder content: () -> Content) -> some View {
    Button(action: action) { content() }.buttonStyle(.plain)
  }

  private func row(_ icon: String, _ title: String, _ value: String, _ badge: String?) -> some View {
    HStack(spacing: 12) {
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(PrismTheme.mintSoft)
        .frame(width: 35, height: 35)
        .overlay(Image(systemName: icon).font(.system(size: 13, weight: .medium)).foregroundStyle(PrismTheme.teal))

      Text(title)
        .font(PrismTheme.body(13, weight: .medium))
        .foregroundStyle(PrismTheme.ink)

      Spacer()

      Text(value)
        .font(PrismTheme.body(11.5))
        .foregroundStyle(PrismTheme.muted)
        .lineLimit(1)

      if let badge {
        Text(badge)
          .font(PrismTheme.body(9, weight: .semibold))
          .foregroundStyle(PrismTheme.positive)
      }

      Image(systemName: "chevron.right")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(PrismTheme.faint)
    }
    .frame(minHeight: 52)
  }

  private func short(_ value: String?) -> String {
    guard let value else { return "Unavailable" }
    return value.count > 14 ? "\(value.prefix(6))…\(value.suffix(5))" : value
  }

  private func savePrivacy() async {
    do {
      let identity = try await PrismAPI.shared.setPrivacy(
        phoneDiscoverable: phoneDiscoverable,
        handleSearchable: handleSearchable
      )
      model.updateIdentity(identity)
    } catch {
      self.error = error.localizedDescription
    }
  }
}

private struct AdvancedAccountView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var copied = false
  @State private var network = "Loading…"

  private var address: String? {
    model.identity?.accountAddress ?? model.identity?.account
  }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        PrismTopBar(title: "Advanced account", back: { dismiss() })
          .padding(.top, 10)

        Text("Wallet details")
          .font(PrismTheme.display(40))
          .tracking(-0.8)
          .padding(.top, 28)

        Text("Technical account information for receiving funds, verification, and support checks.")
          .font(PrismTheme.body(14))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .padding(.top, 11)

        detailGroup("Public account") {
          VStack(alignment: .leading, spacing: 12) {
            detailLabel("Wallet address")
            Text(address ?? "Account unavailable")
              .font(PrismTheme.mono(12))
              .foregroundStyle(PrismTheme.ink)
              .textSelection(.enabled)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityLabel("Wallet address")

            HStack(spacing: 10) {
              PrismSecondaryButton(
                title: copied ? "Address copied" : "Copy address",
                icon: copied ? "checkmark" : "doc.on.doc"
              ) { copyAddress() }

              if let address {
                ShareLink(item: address) {
                  Label("Share", systemImage: "square.and.arrow.up")
                    .font(PrismTheme.body(15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                }
                .buttonStyle(.plain)
                .foregroundStyle(PrismTheme.ink)
                .background(PrismTheme.paper)
                .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 17, style: .continuous)
                    .stroke(PrismTheme.line, lineWidth: 0.7)
                )
              }
            }
          }
        }

        detailGroup("Account details") {
          detailRow("Network", value: network)
          Divider().overlay(PrismTheme.line)
          detailRow("Account type", value: accountType)
          Divider().overlay(PrismTheme.line)
          detailRow("Signing key", value: signingKeyStatus)
          Divider().overlay(PrismTheme.line)
          detailRow("Secret phrase", value: "Not used")
        }

        PrismCard(padding: 17) {
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: "lock.shield.fill")
              .foregroundStyle(PrismTheme.mintDeep)
            Text(securityExplanation)
              .font(PrismTheme.body(12.5))
              .foregroundStyle(PrismTheme.muted)
              .lineSpacing(2)
          }
        }
        .padding(.top, 24)
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 30)
    }
    .task { await loadNetwork() }
    .prismScreen()
  }

  private var accountType: String {
    #if targetEnvironment(simulator)
      "Development EVM account"
    #else
      "Mera passkey account"
    #endif
  }

  private var signingKeyStatus: String {
    #if targetEnvironment(simulator)
      "Simulator protected"
    #else
      "Passkey protected"
    #endif
  }

  private var securityExplanation: String {
    #if targetEnvironment(simulator)
      "This simulator uses a development signer for testnet. Prism does not display or export its test seed. Device builds use a Mera passkey instead."
    #else
      "Prism does not receive or export your signing secret. Your Mera passkey restores the same account, so there is no recovery phrase to store or share."
    #endif
  }

  private func detailGroup<Content: View>(
    _ title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: title)
      VStack(alignment: .leading, spacing: 0) { content() }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .stroke(PrismTheme.line, lineWidth: 0.6)
        )
        .prismCardShadow()
    }
    .padding(.top, 25)
  }

  private func detailLabel(_ text: String) -> some View {
    Text(text)
      .font(PrismTheme.body(12, weight: .semibold))
      .foregroundStyle(PrismTheme.muted)
  }

  private func detailRow(_ label: String, value: String) -> some View {
    HStack(spacing: 16) {
      Text(label)
        .font(PrismTheme.body(13.5, weight: .medium))
      Spacer()
      Text(value)
        .font(PrismTheme.body(12))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.trailing)
    }
    .padding(.vertical, 14)
  }

  private func copyAddress() {
    guard let address else { return }
    UIPasteboard.general.string = address
    withAnimation { copied = true }
    PrismHaptics.success()
    Task {
      try? await Task.sleep(for: .seconds(1.6))
      withAnimation { copied = false }
    }
  }

  private func loadNetwork() async {
    guard let config = try? await PrismAPI.shared.config() else {
      network = "Unavailable"
      return
    }
    network = switch config.chainId {
    case "143": "Monad Mainnet"
    case "10143": "Monad Testnet"
    default: "Chain \(config.chainId)"
    }
  }
}


private struct ProfileNameEditorView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var saving = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      PrismTopBar(title: "Profile", back: { dismiss() })
        .padding(.top, 10)

      Text("What should people\ncall you?")
        .font(PrismTheme.display(40))
        .tracking(-0.7)
        .padding(.top, 30)

      Text("This is your display name inside Prism. Your phone, handle and financial authority remain separate.")
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .padding(.top, 12)

      TextField("Display name", text: $name)
        .textContentType(.name)
        .textInputAutocapitalization(.words)
        .font(PrismTheme.body(17, weight: .medium))
        .padding(.horizontal, 16)
        .frame(height: 58)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(PrismTheme.line, lineWidth: 0.7))
        .padding(.top, 28)

      if let error { ErrorBanner(message: error).padding(.top, 14) }

      Spacer()

      PrismPrimaryButton(title: saving ? "Saving…" : "Save", enabled: !saving && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
        Task { await save() }
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
    .onAppear { name = model.identity?.displayName ?? "" }
    .prismScreen()
  }

  private func save() async {
    saving = true
    defer { saving = false }
    do {
      let updated = try await PrismAPI.shared.setDisplayName(name)
      model.updateIdentity(updated)
      PrismHaptics.success()
      dismiss()
    } catch {
      self.error = error.localizedDescription
      PrismHaptics.error()
    }
  }
}

struct SecurityCenterView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var showPIN = false
  @State private var showRotation = false
  @State private var faceID = UserDefaults.standard.bool(forKey: "payments.faceID")

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        PrismTopBar(title: "Security", back: { dismiss() })
          .padding(.top, 10)

        Text("Your device\nproves you.")
          .font(PrismTheme.display(40))
          .tracking(-0.7)
          .padding(.top, 28)

        Text("Reachability helps people find you. Spending authority stays with cryptographic keys protected by this device.")
          .font(PrismTheme.body(14))
          .foregroundStyle(PrismTheme.muted)
          .padding(.top, 12)

        securityGroup("Payment approval") {
          Toggle("Face ID", isOn: $faceID)
            .tint(PrismTheme.mintDeep)
            .font(PrismTheme.body(14, weight: .medium))
            .padding(.vertical, 14)
            .onChange(of: faceID) { _, value in UserDefaults.standard.set(value, forKey: "payments.faceID") }
          Divider().overlay(PrismTheme.line)
          Button("Change payment PIN") { showPIN = true }
            .font(PrismTheme.body(14, weight: .medium))
            .foregroundStyle(PrismTheme.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 15)
        }

        securityGroup("Account authority") {
          securityRow("Signing", value: "Mera passkey")
          Divider().overlay(PrismTheme.line)
          securityRow("Current device", value: "This iPhone")
          Divider().overlay(PrismTheme.line)
          Button("About account recovery") { showRotation = true }
            .font(PrismTheme.body(14, weight: .semibold))
            .foregroundStyle(PrismTheme.teal)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 15)
        }

        PrismCard(padding: 17) {
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.shield.fill")
              .foregroundStyle(PrismTheme.mintDeep)
            Text("Phone numbers and OTP never authorize spending. A SIM swap alone cannot take control of a funded Prism account.")
              .font(PrismTheme.body(12.5))
              .foregroundStyle(PrismTheme.muted)
          }
        }
        .padding(.top, 24)
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 28)
    }
    .sheet(isPresented: $showPIN) { ChangePINView() }
    .sheet(isPresented: $showRotation) { MeraRecoveryInfoView() }
    .prismScreen()
  }

  private func securityGroup<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 9) {
      PrismSectionLabel(text: title)
      VStack(spacing: 0) { content() }
        .padding(.horizontal, 16)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
        .prismCardShadow()
    }
    .padding(.top, 25)
  }

  private func securityRow(_ label: String, value: String) -> some View {
    HStack {
      Text(label).font(PrismTheme.body(13.5, weight: .medium))
      Spacer()
      Text(value).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
    }
    .padding(.vertical, 15)
  }
}

private struct ChangePINView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var pin = ""
  @State private var error: String?
  var body: some View {
    VStack(spacing: 0) {
      PrismTopBar(title: "Change PIN", back: { dismiss() }).padding(.top, 10)
      Spacer()
      Text("Choose a new\npayment PIN").font(PrismTheme.display(38)).multilineTextAlignment(.center)
      HStack(spacing: 13) {
        ForEach(0..<6, id: \.self) { i in
          Circle().fill(i < pin.count ? PrismTheme.mintDeep : .clear).overlay(
            Circle().stroke(PrismTheme.faint)
          ).frame(width: 12, height: 12)
        }
      }.padding(.vertical, 24)
      DigitPad(value: $pin, maxDigits: 6).padding(.horizontal, 28)
      if let error { Text(error).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.danger) }
      Spacer()
      PrismPrimaryButton(title: "Save PIN", enabled: pin.count == 6) {
        do {
          try PINService.shared.set(pin)
          dismiss()
        } catch { self.error = error.localizedDescription }
      }
    }.padding(24).prismScreen()
  }
}

private struct MeraRecoveryInfoView: View {
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    VStack(spacing: 18) {
      PrismTopBar(title: "Account recovery", back: { dismiss() }).padding(.horizontal, 22).padding(.top, 10)
      Spacer()
      Circle().fill(PrismTheme.mintSoft).frame(width: 96, height: 96).overlay(
        Image(systemName: "faceid").font(.system(size: 32)).foregroundStyle(PrismTheme.mintDeep))
      Text("Your account lives in your passkey").font(PrismTheme.display(32))
        .multilineTextAlignment(.center)
      Text(
        "Prism uses a Mera passkey to sign. Because your account is derived from that passkey, signing in on a new phone with Face ID or Touch ID restores the same account. Nothing to reset. No seed phrase to copy. A new SIM or OTP alone can never take over a funded account."
      ).font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted).multilineTextAlignment(.center).padding(.horizontal, 32)
      Spacer()
      PrismPrimaryButton(title: "Got it") { dismiss() }.padding(24)
    }.prismScreen()
  }
}

struct RecoveryView: View {
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      PrismTopBar(title: "Recovery", back: { dismiss() })
      Text("Recovery is separate from your phone number.").font(PrismTheme.display(38))
      Text(
        "A new SIM or OTP alone cannot take over a funded Prism account. Your account is derived from a Mera passkey, so signing in with Face ID or Touch ID on a new device restores the same account. No seed phrase, nothing to reset. Passkeys sync through your platform account (iCloud Keychain); loss of every passkey is handled by Mera's recovery, not by your phone number."
      ).font(PrismTheme.body(15)).foregroundStyle(PrismTheme.muted)
      PrismCard {
        VStack(alignment: .leading, spacing: 14) {
          Label("Passkey restores your account", systemImage: "checkmark.shield.fill")
            .foregroundStyle(PrismTheme.positive)
          Label("SMS-only recovery is rejected", systemImage: "xmark.shield.fill").foregroundStyle(
            PrismTheme.danger)
          Label("Recovery is a passkey, not your SIM", systemImage: "faceid").foregroundStyle(
            PrismTheme.amber)
        }
      }
      Spacer()
      PrismPrimaryButton(title: "Done") { dismiss() }
    }.padding(22).prismScreen()
  }
}

struct ReachabilityEditorView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var mode = 0
  @State private var phone = ""
  @State private var code = ""
  @State private var handle = ""
  @State private var otpSent = false
  @State private var busy = false
  @State private var error: String?
  @State private var success: String?
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          Text("How people find you can change without changing what controls your money.").font(
            PrismTheme.display(34))
          Picker("Alias", selection: $mode) {
            Text("Phone").tag(0)
            Text("@handle").tag(1)
          }.pickerStyle(.segmented)
          .onChange(of: mode) { _, _ in error = nil; success = nil }
          if mode == 0 { phoneEditor } else { handleEditor }
          if let success { SuccessBanner(message: success) }
          if let error { ErrorBanner(message: error) }
        }.padding(22)
      }.navigationTitle("Reachability").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
      }
    }.prismScreen()
  }
  private var phoneEditor: some View {
    VStack(alignment: .leading, spacing: 14) {
      if model.identity?.hasVerifiedPhone == true {
        LabeledContent("Current phone", value: model.identity?.phoneMasked ?? "Verified")
      }
      TextField("+234 803 123 4567", text: $phone).keyboardType(.phonePad).padding(14).background(
        PrismTheme.surface
      ).clipShape(RoundedRectangle(cornerRadius: 14))
      if otpSent {
        TextField("6-digit code", text: $code).keyboardType(.numberPad).padding(14).background(
          PrismTheme.surface
        ).clipShape(RoundedRectangle(cornerRadius: 14))
        PrismPrimaryButton(
          title: busy ? "Verifying…" : "Verify & replace phone", enabled: code.count == 6 && !busy
        ) { Task { await finishPhone() } }
      } else {
        PrismPrimaryButton(
          title: busy ? "Sending code…" : "Verify new phone", enabled: !phone.isEmpty && !busy
        ) { Task { await startPhone() } }
      }
      Text(
        "Replacing your phone increments the alias version. Your account and signing don't change."
      ).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
    }
  }
  private var handleEditor: some View {
    VStack(alignment: .leading, spacing: 14) {
      TextField("@keoneHD", text: $handle).textInputAutocapitalization(.never)
        .autocorrectionDisabled().padding(14).background(PrismTheme.surface).clipShape(
          RoundedRectangle(cornerRadius: 14))
      PrismPrimaryButton(
        title: busy ? "Saving…" : "Save handle",
        enabled: handle.replacingOccurrences(of: "@", with: "").count >= 3 && !busy
      ) { Task { await saveHandle() } }
      Text(
        "Handles are public payment aliases. Changing one invalidates stale resolver attestations."
      ).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
    }
  }
  private func startPhone() async {
    success = nil
    guard let p = ContactService.normalize(phone) else {
      error = "Enter a valid phone number."
      return
    }
    busy = true
    defer { busy = false }
    do {
      phone = p
      try await PrismAPI.shared.startPhoneBinding(phone: p)
      otpSent = true
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func finishPhone() async {
    busy = true
    error = nil; success = nil
    defer { busy = false }
    do {
      let i = try await PrismAPI.shared.checkPhoneBinding(phone: phone, code: code)
      model.updateIdentity(i)
      otpSent = false
      code = ""
      success = "Your phone number is verified and connected."
      PrismHaptics.success()
    } catch {
      self.error = error.localizedDescription
      PrismHaptics.error()
    }
  }
  private func saveHandle() async {
    busy = true
    error = nil; success = nil
    defer { busy = false }
    do {
      let i = try await PrismAPI.shared.setHandle(handle)
      model.updateIdentity(i)
      handle = ""
      success = "\(i.handle?.asPrismHandle ?? "your handle") is now your public handle."
      PrismHaptics.success()
    } catch {
      self.error = error.localizedDescription
      PrismHaptics.error()
    }
  }
}
