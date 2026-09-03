import SwiftUI

enum OnboardingStep {
  case story, creating, reachability, phone, otp, handle, secondAlias, contacts, pin, faceID, ready
}
enum AliasKind { case phone, handle }

struct OnboardingFlow: View {
  @EnvironmentObject private var model: AppModel
  @State private var step: OnboardingStep = .story
  @State private var phone = ""
  @State private var code = ""
  @State private var handle = ""
  @State private var busy = false
  @State private var error: String?
  @State private var firstAlias: AliasKind?
  @State private var addingSecond = false

  var body: some View {
    ZStack {
      PrismTheme.canvas.ignoresSafeArea()

      switch step {
      case .story:
        StoryStep { Task { await createBaseIdentity() } }
      case .creating:
        CreatingAccountStep()
      case .reachability:
        ReachabilityStep(phone: { startAlias(.phone) }, handle: { startAlias(.handle) })
      case .phone:
        PhoneStep(phone: $phone, busy: busy, back: { back() }) { Task { await startPhone() } }
      case .otp:
        OTPCodeStep(code: $code, phone: phone, busy: busy, back: { step = .phone }) {
          Task { await verifyPhone() }
        }
      case .handle:
        HandleStep(handle: $handle, busy: busy, back: { back() }) { Task { await saveHandle() } }
      case .secondAlias:
        SecondAliasStep(
          firstAlias: firstAlias ?? .phone,
          add: { addSecondAlias() },
          skip: { step = .contacts }
        )
      case .contacts:
        ContactsPermissionStep(
          allow: { Task { _ = try? await ContactService.shared.requestAccess(); step = .pin } },
          skip: { step = .pin }
        )
      case .pin:
        CreatePINStep { pin in
          do { try PINService.shared.set(pin); step = .faceID }
          catch { self.error = error.localizedDescription }
        }
      case .faceID:
        FaceIDStep(
          enable: { Task { await enableFaceID() } },
          skip: { UserDefaults.standard.set(false, forKey: "payments.faceID"); step = .ready }
        )
      case .ready:
        ReadyStep { model.finishOnboarding() }
      }
    }
    .foregroundStyle(PrismTheme.ink)
    .animation(.easeInOut(duration: 0.24), value: step)
    .alert("Prism", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") { error = nil }
    } message: {
      Text(error ?? "")
    }
  }

  // Reachability choice. On the first pass this records the primary alias; on the second pass it
  // adds the optional secondary alias.
  private func startAlias(_ kind: AliasKind) {
    phone = ""; code = ""; handle = ""
    step = kind == .phone ? .phone : .handle
  }
  private func back() {
    step = addingSecond ? .secondAlias : .reachability
  }
  private func addSecondAlias() {
    addingSecond = true
    startAlias(firstAlias == .phone ? .handle : .phone)
  }
  private func advanceAfterAlias(_ kind: AliasKind) {
    if firstAlias == nil { firstAlias = kind }
    step = addingSecond ? .contacts : .secondAlias
  }

  private func createBaseIdentity() async {
    guard !busy else { return }
    busy = true
    step = .creating
    defer { busy = false }
    do {
      // Create or restore the Mera passkey account, then bind it to a Prism Identity.
      _ = try await MeraAccountManager.shared.ensureAccount()
      if model.identity == nil {
        let auth = try await PrismAPI.shared.createDeviceIdentity()
        model.authenticated(auth)
      }
      step = .reachability
    } catch {
      self.error = error.localizedDescription
      step = .story
    }
  }

  private func startPhone() async {
    guard !busy else { return }
    guard let normalized = ContactService.normalize(phone) else {
      error = "Enter a valid phone number."
      return
    }
    busy = true
    defer { busy = false }
    do {
      try await PrismAPI.shared.startPhoneBinding(phone: normalized)
      phone = normalized
      step = .otp
    } catch { self.error = error.localizedDescription }
  }

  private func verifyPhone() async {
    guard code.count == 6, !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let identity = try await PrismAPI.shared.checkPhoneBinding(phone: phone, code: code)
      model.updateIdentity(identity)
      try? KeychainStore.shared.setString(phone, for: "verifiedPhone")
      advanceAfterAlias(.phone)
    } catch { self.error = error.localizedDescription }
  }

  private func saveHandle() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let identity = try await PrismAPI.shared.setHandle(handle)
      model.updateIdentity(identity)
      advanceAfterAlias(.handle)
    } catch { self.error = error.localizedDescription }
  }

  private func enableFaceID() async {
    do {
      _ = try await BiometricService().authenticate(reason: "Enable Face ID for Prism payments")
      UserDefaults.standard.set(true, forKey: "payments.faceID")
      step = .ready
    } catch { self.error = error.localizedDescription }
  }
}

private struct StoryStep: View {
  let next: () -> Void
  @State private var page = 0

  private let pages: [(headline: String, support: String, art: StoryArt)] = [
    ("Pay people.\nNot wallets.", "Money moves person to person.", .orbit),
    ("Your contacts already\nknow who you pay.", "No addresses, no usernames to hunt down.", .contacts),
    ("Send now.\nThey can join later.", "The money waits safely until they do.", .waiting),
    ("Your phone finds you.\nYour passkey proves you.", "Face ID signs every payment. No seed phrase, ever.", .passkey)
  ]

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        PrismWordmark()
        Spacer()
        if page < pages.count - 1 {
          Button("Skip") { withAnimation(.easeInOut) { page = pages.count - 1 } }
            .font(PrismTheme.body(13, weight: .semibold))
            .foregroundStyle(PrismTheme.muted)
            .accessibilityHint("Jump to the last intro screen")
        } else {
          Color.clear.frame(width: 1, height: 20)
        }
      }
      .padding(.top, 18)
      .padding(.horizontal, 24)

      TabView(selection: $page) {
        ForEach(pages.indices, id: \.self) { i in
          StoryPage(headline: pages[i].headline, support: pages[i].support, art: pages[i].art).tag(i)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))

      HStack(spacing: 7) {
        ForEach(pages.indices, id: \.self) { i in
          Capsule()
            .fill(i == page ? PrismTheme.mintDeep : PrismTheme.line)
            .frame(width: i == page ? 22 : 7, height: 7)
            .animation(.easeInOut(duration: 0.2), value: page)
        }
      }
      .padding(.bottom, 18)
      .accessibilityHidden(true)

      PrismPrimaryButton(title: page < pages.count - 1 ? "Continue" : "Get started", icon: "arrow.right") {
        if page < pages.count - 1 { withAnimation(.easeInOut) { page += 1 } } else { next() }
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 18)
    }
  }
}

private enum StoryArt { case orbit, contacts, waiting, passkey }

private struct StoryPage: View {
  let headline: String
  let support: String
  let art: StoryArt

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Spacer(minLength: 8)
      Group {
        switch art {
        case .orbit: PaymentOrbit()
        case .contacts: StoryGlyph(symbol: "person.2.fill")
        case .waiting: StoryGlyph(symbol: "clock.badge.checkmark")
        case .passkey: StoryGlyph(symbol: "faceid")
        }
      }
      .frame(maxWidth: .infinity)

      Spacer(minLength: 20)

      Text(headline)
        .font(PrismTheme.display(45))
        .tracking(-1.2)
        .lineSpacing(-4)
        .minimumScaleFactor(0.7)
        .fixedSize(horizontal: false, vertical: true)

      Text(support)
        .font(PrismTheme.body(15))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(3)
        .padding(.top, 13)
        .frame(maxWidth: 360, alignment: .leading)

      Spacer(minLength: 8)
    }
    .padding(.horizontal, 24)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(headline.replacingOccurrences(of: "\n", with: " ")) \(support)")
  }
}

private struct StoryGlyph: View {
  let symbol: String
  var body: some View {
    ZStack {
      Circle().fill(PrismTheme.mintSoft).frame(width: 150, height: 150)
      Circle().stroke(PrismTheme.mint.opacity(0.26), lineWidth: 1).frame(width: 184, height: 184)
      Image(systemName: symbol).font(.system(size: 52, weight: .medium)).foregroundStyle(PrismTheme.mintDeep)
    }
    .frame(height: 210)
  }
}

private struct CreatingAccountStep: View {
  var body: some View {
    VStack(spacing: 0) {
      HStack { PrismWordmark(); Spacer() }.padding(.top, 18)
      Spacer()
      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 126, height: 126)
        ProgressView().tint(PrismTheme.mintDeep).scaleEffect(1.25)
      }
      Text("Setting up your\nPrism account")
        .font(PrismTheme.display(34))
        .tracking(-0.6)
        .multilineTextAlignment(.center)
        .padding(.top, 30)
      Text("Creating a passkey account with Face ID. Nothing to write down.")
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(.top, 12)
        .padding(.horizontal, 30)
      Spacer()
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Setting up your Prism account")
  }
}

private struct SecondAliasStep: View {
  let firstAlias: AliasKind
  let add: () -> Void
  let skip: () -> Void

  var body: some View {
    let addingHandle = firstAlias == .phone
    return CenteredMilestone(
      icon: addingHandle ? "at" : "phone.fill",
      title: addingHandle ? "Add a public\n@handle too?" : "Add your phone\nnumber too?",
      message: addingHandle
        ? "A @handle lets people pay you without sharing your number. You can add one anytime."
        : "Your number lets people in your contacts find you. You can add it anytime.",
      primary: addingHandle ? "Add a @handle" : "Add my number",
      primaryAction: add,
      secondary: "Not now",
      secondaryAction: skip
    )
  }
}

private struct PaymentOrbit: View {
  var body: some View {
    ZStack {
      Circle()
        .stroke(PrismTheme.line, lineWidth: 1)
        .frame(width: 248, height: 248)

      Circle()
        .stroke(PrismTheme.mint.opacity(0.34), style: StrokeStyle(lineWidth: 1.2, dash: [5, 8]))
        .frame(width: 188, height: 188)
        .rotationEffect(.degrees(-18))

      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .fill(PrismTheme.paper)
        .frame(width: 130, height: 84)
        .overlay(
          VStack(alignment: .leading, spacing: 5) {
            Text("YOU SENT").font(PrismTheme.body(8.5, weight: .semibold)).tracking(1.2).foregroundStyle(PrismTheme.muted)
            Text("$20.00").font(PrismTheme.display(26)).tracking(-0.7)
            Text("to Tobi").font(PrismTheme.body(10.5)).foregroundStyle(PrismTheme.muted)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
        )
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(PrismTheme.line, lineWidth: 0.6))
        .prismCardShadow()
        .rotationEffect(.degrees(-7))
        .offset(x: 18, y: 4)

      PrismAvatar(initials: "TB", size: 58, tone: PrismTheme.rose)
        .offset(x: -106, y: -58)

      PrismAvatar(initials: "OA", size: 62, highlighted: true, tone: PrismTheme.mintSoft)
        .offset(x: 100, y: 73)

      PrismMark(size: 48)
        .offset(x: 94, y: -82)

      Circle().fill(PrismTheme.mint).frame(width: 8, height: 8).offset(x: -82, y: 84)
    }
    .frame(height: 275)
  }
}

private struct PrismMark: View {
  var size: CGFloat = 28

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.18)
        .fill(PrismTheme.mintDeep)
        .frame(width: size * 0.72, height: size * 0.72)
        .rotationEffect(.degrees(45))
      RoundedRectangle(cornerRadius: size * 0.15)
        .stroke(PrismTheme.mint, lineWidth: 2)
        .frame(width: size * 0.48, height: size * 0.48)
        .rotationEffect(.degrees(45))
    }
    .frame(width: size, height: size)
  }
}

private struct PrismWordmark: View {
  var body: some View {
    HStack(spacing: 9) {
      PrismMark(size: 21)
      Text("PRISM")
        .font(PrismTheme.body(13.5, weight: .semibold))
        .tracking(2.5)
    }
  }
}

private struct ReachabilityStep: View {
  let phone: () -> Void
  let handle: () -> Void

  var body: some View {
    SetupPage(
      eyebrow: "REACHABILITY",
      title: "How should people\nfind you?",
      subtitle: "Choose how friends and family can find and pay you on Prism.",
      back: nil
    ) {
      VStack(spacing: 14) {
        ChoiceCard(
          icon: "phone.fill",
          title: "Use my phone number",
          detail: "Find and pay people already in your contacts.",
          badge: "RECOMMENDED",
          action: phone
        )
        ChoiceCard(
          icon: "at",
          title: "Create a @Prism handle",
          detail: "Receive money without sharing your number.",
          badge: nil,
          action: handle
        )

        HStack(spacing: 7) {
          Image(systemName: "lock.fill").font(.system(size: 9))
          Text("Aliases help people find you. Your device controls your money.")
        }
        .font(PrismTheme.body(10.5))
        .foregroundStyle(PrismTheme.faint)
        .padding(.top, 6)

        Spacer()
      }
      .padding(.top, 30)
    }
  }
}

private struct ChoiceCard: View {
  let icon: String
  let title: String
  let detail: String
  let badge: String?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 15) {
        RoundedRectangle(cornerRadius: 15, style: .continuous)
          .fill(PrismTheme.mintSoft)
          .frame(width: 52, height: 52)
          .overlay(Image(systemName: icon).font(.system(size: 18, weight: .medium)).foregroundStyle(PrismTheme.teal))

        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 8) {
            Text(title).font(PrismTheme.body(15.5, weight: .semibold))
            if let badge {
              Text(badge)
                .font(PrismTheme.body(8.2, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(PrismTheme.mintDeep)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(PrismTheme.mintSoft)
                .clipShape(Capsule())
            }
          }
          Text(detail)
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
            .multilineTextAlignment(.leading)
        }

        Spacer()
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(PrismTheme.faint)
      }
      .padding(17)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
      .prismCardShadow()
    }
    .buttonStyle(.plain)
  }
}

private struct PhoneStep: View {
  @Binding var phone: String
  let busy: Bool
  let back: () -> Void
  let next: () -> Void

  var body: some View {
    SetupPage(
      eyebrow: "YOUR NUMBER",
      title: "What’s your\nnumber?",
      subtitle: "People who have your number can find and pay you. Your number never becomes your spending key.",
      back: back
    ) {
      VStack(spacing: 0) {
        HStack(spacing: 12) {
          Text("🇳🇬").font(.system(size: 22))
          Text("+234").font(PrismTheme.body(17, weight: .semibold))
          Rectangle().fill(PrismTheme.line).frame(width: 1, height: 27)
          TextField("803 123 4567", text: $phone)
            .keyboardType(.phonePad)
            .font(PrismTheme.body(18, weight: .medium))
            .textContentType(.telephoneNumber)
        }
        .padding(.horizontal, 17)
        .frame(height: 66)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.mint, lineWidth: 1.1))
        .prismCardShadow()
        .padding(.top, 34)

        Spacer()

        PrismPrimaryButton(
          title: busy ? "Sending code…" : "Continue",
          enabled: !busy && !phone.isEmpty,
          icon: "arrow.right"
        ) { next() }
      }
    }
  }
}

private struct OTPCodeStep: View {
  @Binding var code: String
  let phone: String
  let busy: Bool
  let back: () -> Void
  let verify: () -> Void

  var body: some View {
    SetupPage(
      eyebrow: "VERIFY",
      title: "Enter the code",
      subtitle: "We sent a 6-digit code to \(masked(phone)).",
      back: back
    ) {
      VStack(spacing: 18) {
        HStack(spacing: 8) {
          ForEach(0..<6, id: \.self) { index in
            ZStack {
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(PrismTheme.paper)
                .overlay(
                  RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(index == code.count ? PrismTheme.mint : PrismTheme.line, lineWidth: index == code.count ? 1.4 : 0.6)
                )
              Text(index < code.count ? String(code[code.index(code.startIndex, offsetBy: index)]) : "")
                .font(PrismTheme.display(23))
            }
            .frame(height: 56)
          }
        }
        .padding(.top, 32)

        #if DEBUG
        Text("Development verification is enabled only when the backend explicitly allows a development OTP.")
          .font(PrismTheme.body(9.5))
          .foregroundStyle(PrismTheme.faint)
          .multilineTextAlignment(.center)
        #endif

        DigitPad(value: $code, maxDigits: 6)
          .padding(.top, 2)

        Spacer()

        PrismPrimaryButton(
          title: busy ? "Verifying…" : "Verify",
          enabled: code.count == 6 && !busy,
          icon: "checkmark"
        ) { verify() }
      }
    }
  }

  private func masked(_ phone: String) -> String {
    let digits = phone.filter(\.isNumber)
    guard digits.count > 6 else { return phone }
    return "+\(digits.prefix(6)) ••• ••\(digits.suffix(2))"
  }
}

private struct HandleStep: View {
  @Binding var handle: String
  let busy: Bool
  let back: () -> Void
  let save: () -> Void
  @State private var availability: HandleAvailability = .empty

  private var normalized: String { handle.replacingOccurrences(of: "@", with: "").lowercased() }
  private var borderColor: Color {
    switch availability {
    case .available: PrismTheme.mint
    case .taken, .invalid: PrismTheme.danger
    default: PrismTheme.line
    }
  }

  var body: some View {
    SetupPage(
      eyebrow: "PUBLIC ALIAS",
      title: "Choose your\nPrism handle",
      subtitle: "A payment name for people you don’t want to share your number with.",
      back: back
    ) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 7) {
          Text("@").font(PrismTheme.display(28)).foregroundStyle(PrismTheme.mintDeep)
          TextField("octane", text: $handle)
            .font(PrismTheme.display(28))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel("Prism handle")
        }
        .padding(.horizontal, 18)
        .frame(height: 68)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(borderColor, lineWidth: borderColor == PrismTheme.line ? 0.6 : 1.2))
        .prismCardShadow()
        .padding(.top, 34)

        availabilityRow.padding(.top, 12).frame(height: 20)

        Spacer()

        PrismPrimaryButton(
          title: busy ? "Reserving…" : (availability == .available ? "Reserve @\(normalized)" : "Continue"),
          enabled: availability == .available && !busy,
          icon: "checkmark"
        ) { save() }
      }
    }
    .task(id: handle) { await checkAvailability() }
  }

  @ViewBuilder private var availabilityRow: some View {
    switch availability {
    case .empty: EmptyView()
    case .tooShort: hint("At least 3 characters", "info.circle", PrismTheme.muted)
    case .invalid: hint("Letters, numbers and underscore only", "xmark.circle", PrismTheme.danger)
    case .checking:
      HStack(spacing: 7) { ProgressView().scaleEffect(0.7); Text("Checking availability…").font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted) }
    case .available: hint("@\(normalized) is available", "checkmark.circle.fill", PrismTheme.mintDeep)
    case .taken: hint("@\(normalized) is taken", "xmark.circle.fill", PrismTheme.danger)
    }
  }

  private func hint(_ text: String, _ icon: String, _ color: Color) -> some View {
    HStack(spacing: 6) {
      Image(systemName: icon).font(.system(size: 11, weight: .semibold))
      Text(text).font(PrismTheme.body(12, weight: .medium))
    }
    .foregroundStyle(color)
    .accessibilityElement(children: .combine)
  }

  private func checkAvailability() async {
    let h = normalized
    if h.isEmpty { availability = .empty; return }
    if h.count < 3 { availability = .tooShort; return }
    if h.range(of: "^[a-z0-9_]{3,24}$", options: .regularExpression) == nil { availability = .invalid; return }
    availability = .checking
    try? await Task.sleep(for: .milliseconds(450)) // debounce keystrokes
    if Task.isCancelled { return }
    do {
      let result = try await PrismAPI.shared.resolve(handle: h)
      if Task.isCancelled { return }
      availability = result.found ? .taken : .available
    } catch {
      // Not resolvable → available to reserve; the backend still validates on reservation.
      if !Task.isCancelled { availability = .available }
    }
  }
}

private enum HandleAvailability: Equatable { case empty, tooShort, invalid, checking, available, taken }

private struct ContactsPermissionStep: View {
  let allow: () -> Void
  let skip: () -> Void

  var body: some View {
    CenteredMilestone(
      icon: "person.crop.rectangle.stack",
      title: "Find people\nyou know",
      message: "Prism uses Contacts to help you find people you already know. Your whole address book is never uploaded.",
      primary: "Allow Contacts",
      primaryAction: allow,
      secondary: "Not now",
      secondaryAction: skip
    )
  }
}

private struct CreatePINStep: View {
  @State private var pin = ""
  @State private var firstPIN: String?
  @State private var mismatch = false
  let complete: (String) -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack { PrismWordmark(); Spacer() }
        .padding(.top, 18)

      Spacer().frame(height: 54)

      Text(firstPIN == nil ? "Create your\npayment PIN" : "Confirm your\npayment PIN")
        .font(PrismTheme.display(41))
        .tracking(-0.8)
        .multilineTextAlignment(.center)

      Text(firstPIN == nil
        ? "Six digits for familiar local approval. Your PIN is never your signing key."
        : "Enter the same six digits again so a typo can’t lock you out of payments.")
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(.top, 13)
        .padding(.horizontal, 28)

      HStack(spacing: 14) {
        ForEach(0..<6, id: \.self) { index in
          Circle()
            .fill(index < pin.count ? PrismTheme.mintDeep : Color.clear)
            .overlay(Circle().stroke(index < pin.count ? PrismTheme.mintDeep : PrismTheme.faint, lineWidth: 1))
            .frame(width: 12, height: 12)
        }
      }
      .padding(.top, 28)

      if mismatch {
        Text("Those PINs didn’t match. Start again.")
          .font(PrismTheme.body(11.5, weight: .medium))
          .foregroundStyle(PrismTheme.danger)
          .padding(.top, 12)
      } else {
        Spacer().frame(height: 27)
      }

      DigitPad(value: $pin, maxDigits: 6)
        .padding(.horizontal, 26)
        .onChange(of: pin) { _, _ in mismatch = false }

      Spacer()

      PrismPrimaryButton(
        title: firstPIN == nil ? "Continue" : "Confirm PIN",
        enabled: pin.count == 6,
        icon: firstPIN == nil ? "arrow.right" : "checkmark"
      ) {
        guard pin.count == 6 else { return }
        if let firstPIN {
          guard firstPIN == pin else {
            PrismHaptics.error()
            self.firstPIN = nil
            pin = ""
            mismatch = true
            return
          }
          PrismHaptics.success()
          complete(pin)
        } else {
          PrismHaptics.selection()
          firstPIN = pin
          pin = ""
        }
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
  }
}

private struct FaceIDStep: View {
  let enable: () -> Void
  let skip: () -> Void

  var body: some View {
    CenteredMilestone(
      icon: "faceid",
      title: "Use Face ID for\nfaster payments",
      message: "Approve payments with a glance. Your payment PIN remains available as a fallback.",
      primary: "Enable Face ID",
      primaryAction: enable,
      secondary: "I’ll do this later",
      secondaryAction: skip
    )
  }
}

private struct ReadyStep: View {
  let open: () -> Void

  var body: some View {
    CenteredMilestone(
      icon: "checkmark",
      title: "You’re ready.",
      message: "Your Prism is set up. Money can now move between people — starting with you.",
      primary: "Open Prism",
      primaryAction: open,
      secondary: nil,
      secondaryAction: {}
    )
  }
}

private struct CenteredMilestone: View {
  let icon: String
  let title: String
  let message: String
  let primary: String
  let primaryAction: () -> Void
  let secondary: String?
  let secondaryAction: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack { PrismWordmark(); Spacer() }
        .padding(.top, 18)

      Spacer()

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 126, height: 126)
        Circle().stroke(PrismTheme.mint.opacity(0.28), lineWidth: 1).frame(width: 150, height: 150)
        Image(systemName: icon)
          .font(.system(size: 37, weight: .medium))
          .foregroundStyle(PrismTheme.mintDeep)
      }

      Text(title)
        .font(PrismTheme.display(39))
        .tracking(-0.7)
        .multilineTextAlignment(.center)
        .padding(.top, 34)

      Text(message)
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(.top, 13)
        .padding(.horizontal, 28)

      Spacer()

      PrismPrimaryButton(title: primary, icon: primary == "Open Prism" ? "arrow.right" : nil, action: primaryAction)

      if let secondary {
        Button(secondary, action: secondaryAction)
          .font(PrismTheme.body(14, weight: .semibold))
          .foregroundStyle(PrismTheme.muted)
          .padding(.vertical, 17)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 12)
  }
}

private struct SetupPage<Content: View>: View {
  let eyebrow: String
  let title: String
  let subtitle: String
  let back: (() -> Void)?
  @ViewBuilder let content: Content

  init(
    eyebrow: String,
    title: String,
    subtitle: String,
    back: (() -> Void)?,
    @ViewBuilder content: () -> Content
  ) {
    self.eyebrow = eyebrow
    self.title = title
    self.subtitle = subtitle
    self.back = back
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        if let back {
          PrismHeaderIconButton(icon: "chevron.left", action: back)
        } else {
          PrismWordmark()
        }
        Spacer()
        Text(eyebrow)
          .font(PrismTheme.body(9.5, weight: .semibold))
          .tracking(1.35)
          .foregroundStyle(PrismTheme.teal)
      }
      .frame(height: 58)

      Spacer().frame(height: 23)

      Text(title)
        .font(PrismTheme.display(42))
        .tracking(-0.9)
        .lineSpacing(-4)

      Text(subtitle)
        .font(PrismTheme.body(14.5))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .padding(.top, 13)
        .frame(maxWidth: 350, alignment: .leading)

      content
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
  }
}

struct DigitPad: View {
  @Binding var value: String
  let maxDigits: Int
  var allowsDecimal: Bool = false

  var body: some View {
    VStack(spacing: 13) {
      ForEach([["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]], id: \.self) { row in
        HStack(spacing: 12) {
          ForEach(row, id: \.self) { digit in
            key(digit) { append(digit) }
          }
        }
      }

      HStack(spacing: 12) {
        if allowsDecimal {
          key(".") {
            if !value.contains(".") && value.count < maxDigits {
              PrismHaptics.tap()
              value.append(".")
            }
          }
        } else {
          Color.clear.frame(maxWidth: .infinity).frame(height: 58)
        }

        key("0") { append("0") }

        Button {
          if !value.isEmpty {
            PrismHaptics.tap()
            value.removeLast()
          }
        } label: {
          Image(systemName: "delete.left")
            .font(.system(size: 19, weight: .regular))
            .frame(maxWidth: .infinity)
            .frame(height: 58)
        }
        .buttonStyle(.plain)
      }
    }
  }

  private func append(_ digit: String) {
    guard value.count < maxDigits else { return }
    PrismHaptics.tap()

    if allowsDecimal, let dot = value.firstIndex(of: ".") {
      let fraction = value.distance(from: value.index(after: dot), to: value.endIndex)
      if fraction >= 2 { return }
    }

    if allowsDecimal && value == "0" && digit != "." {
      value = digit
      return
    }

    value.append(digit)
  }

  private func key(_ text: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(text)
        .font(PrismTheme.display(25))
        .frame(maxWidth: .infinity)
        .frame(height: 58)
    }
    .buttonStyle(.plain)
  }
}
