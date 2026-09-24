import SwiftUI

/// Where a fulfilled request's money lands. Mirrors the backend's uppercase destination enum.
enum RequestDestination: String, CaseIterable, Identifiable {
  case primary = "PRIMARY", circle = "CIRCLE", savings = "SAVINGS"
  var id: String { rawValue }
  var title: String {
    switch self {
    case .primary: "Primary"
    case .circle: "Circle"
    case .savings: "Savings"
    }
  }
  var icon: String {
    switch self {
    case .primary: "person.crop.circle"
    case .circle: "person.3"
    case .savings: "chart.line.uptrend.xyaxis"
    }
  }
}

enum RequestSweepSigningError: LocalizedError {
  case malformedAuthorization
  var errorDescription: String? {
    "That request's sweep authorization came back malformed. Try again."
  }
}

struct RequestMoneyView: View {
  let target: SendTarget
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var amount = ""
  @State private var memo = ""
  @State private var busy = false
  @State private var error: String?
  @State private var sent = false

  @State private var destination: RequestDestination = .primary
  @State private var selectedCircleId: String?
  @State private var circles: [CircleSummary] = []
  @State private var circlesLoading = false
  @State private var circlesError: String?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Request money", back: { dismiss() })
          .padding(.horizontal, 22)
          .padding(.top, 10)

        Spacer().frame(height: 20)
        PrismAvatar(initials: target.contact.initials, size: 72, highlighted: true)
        Text(target.contact.name)
          .font(PrismTheme.body(17, weight: .semibold))
          .padding(.top, 10)
        if let handle = target.contact.handle {
          Text(handle)
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
            .padding(.top, 2)
        }

        Spacer().frame(height: 24)
        AmountText(dollars: displayAmount, size: 78)

        HStack(spacing: 9) {
          Image(systemName: "pencil").font(.system(size: 13, weight: .medium)).foregroundStyle(PrismTheme.muted)
          TextField("Add a note", text: $memo).font(PrismTheme.body(13.5))
        }
        .padding(.horizontal, 15)
        .frame(height: 48)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
        .frame(maxWidth: 250)
        .padding(.top, 18)

        destinationPicker
          .padding(.horizontal, 24)
          .padding(.top, 16)

        if let error {
          ErrorBanner(message: error).padding(.horizontal, 24).padding(.top, 10)
        }

        MoneyKeypad(value: $amount)
          .padding(.horizontal, 30)
          .padding(.top, 8)

        Spacer(minLength: 4)

        PrismPrimaryButton(
          title: busy ? "Sending request…" : submitTitle,
          enabled: canSubmit && !busy,
          icon: "arrow.down.left"
        ) { Task { await submit() } }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
      }
      .prismScreen()

      if sent {
        ZStack {
          Color.black.opacity(0.18).ignoresSafeArea()
          VStack(spacing: 16) {
            Circle().fill(PrismTheme.mintSoft).frame(width: 82, height: 82).overlay(
              Image(systemName: "checkmark").font(.system(size: 29, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
            )
            Text("Request sent").font(PrismTheme.display(34))
            Text("\(displayAmount) requested from \(target.contact.name).")
              .font(PrismTheme.body(14))
              .foregroundStyle(PrismTheme.muted)
              .multilineTextAlignment(.center)
            PrismPrimaryButton(title: "Done") { dismiss() }
          }
          .padding(28)
          .background(PrismTheme.paper)
          .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
          .prismCardShadow()
          .padding(28)
        }
      }
    }
  }

  private var atomic: String? {
    guard let value = Money.atomic(fromDollars: amount), value != "0" else { return nil }
    return value
  }

  private var displayAmount: String {
    amount.isEmpty
      ? "$0.00"
      : (Decimal(string: amount) ?? 0).formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }

  /// Circle destination additionally needs a Circle picked before the draft is even worth sending.
  private var canSubmit: Bool {
    guard atomic != nil else { return false }
    if destination == .circle { return selectedCircleId != nil }
    return true
  }

  private var submitTitle: String {
    if atomic == nil { return "Enter an amount" }
    if destination == .circle && selectedCircleId == nil { return "Choose a Circle" }
    return "Review request"
  }

  // MARK: destination picker

  private var destinationPicker: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "Deposit into")

      Picker("Destination", selection: $destination) {
        ForEach(RequestDestination.allCases) { option in
          Label(option.title, systemImage: option.icon).tag(option)
        }
      }
      .pickerStyle(.segmented)
      .onChange(of: destination) { _, newValue in
        if newValue == .circle && circles.isEmpty && !circlesLoading {
          Task { await loadCircles() }
        }
      }

      switch destination {
      case .primary:
        EmptyView()
      case .circle:
        circlePicker
      case .savings:
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "info.circle.fill")
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(PrismTheme.mintDeep)
          Text("Demo — deposits into your testnet savings.")
            .font(PrismTheme.body(12))
            .foregroundStyle(PrismTheme.muted)
        }
        .padding(.top, 2)
      }
    }
  }

  private var circlePicker: some View {
    VStack(alignment: .leading, spacing: 8) {
      if circlesLoading {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small).tint(PrismTheme.mintDeep)
          Text("Loading Circles…").font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
        }
      } else if let circlesError {
        ErrorBanner(message: circlesError)
      } else if circles.isEmpty {
        Text("You're not in any Circles yet.")
          .font(PrismTheme.body(12))
          .foregroundStyle(PrismTheme.muted)
      } else {
        Menu {
          ForEach(circles) { circle in
            Button {
              selectedCircleId = circle.circleId
            } label: {
              if selectedCircleId == circle.circleId {
                Label(circle.name, systemImage: "checkmark")
              } else {
                Text(circle.name)
              }
            }
          }
        } label: {
          HStack(spacing: 8) {
            CircleGlyph(icon: circles.first { $0.circleId == selectedCircleId }?.icon, name: selectedCircleName ?? "Circle", size: 13)
            Text(selectedCircleName ?? "Choose a Circle")
              .font(PrismTheme.body(13, weight: .medium))
              .foregroundStyle(selectedCircleId == nil ? PrismTheme.muted : PrismTheme.ink)
            Spacer(minLength: 0)
            Image(systemName: "chevron.up.chevron.down")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(PrismTheme.muted)
          }
          .padding(.horizontal, 13)
          .frame(height: 42)
          .background(PrismTheme.paper)
          .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
        }
        .buttonStyle(.plain)
      }
    }
  }

  private var selectedCircleName: String? {
    guard let selectedCircleId else { return nil }
    return circles.first { $0.circleId == selectedCircleId }?.name
  }

  private func loadCircles() async {
    circlesLoading = true
    defer { circlesLoading = false }
    do {
      circles = try await PrismAPI.shared.circles()
      circlesError = nil
    } catch {
      circlesError = error.localizedDescription
    }
  }

  private func submit() async {
    guard let atomic, let payer = target.resolution.attestation?.prismIdentity else { return }
    guard canSubmit else { return }
    busy = true
    defer { busy = false }

    do {
      let draft = try await PrismAPI.shared.draftRequest(
        payerPrismId: payer,
        amountAtomic: atomic,
        memo: memo,
        destination: destination.rawValue,
        circleId: destination == .circle ? selectedCircleId : nil
      )

      var sigs = PrismAPI.SweepSignaturesBody()
      if let sweep = draft.sweep {
        let mera = MeraAccountManager.shared
        try await mera.beginSession(.payments)
        if sweep.destination == "CIRCLE" {
          guard let env = sweep.authorization["envelope"], let tok = sweep.authorization["tokenAuthorization"] else {
            throw RequestSweepSigningError.malformedAuthorization
          }
          sigs.prismSignature = try await mera.signTypedDataHex(env.jsonData())
          sigs.tokenSignature = try await mera.signTypedDataHex(tok.jsonData())
        } else { // SAVINGS
          sigs.signature = try await mera.signTypedDataHex(sweep.authorization.jsonData())
        }
      }

      _ = try await PrismAPI.shared.commitRequest(draft, sweepSignatures: draft.sweep != nil ? sigs : nil)
      sent = true
    } catch {
      self.error = error.localizedDescription
    }
  }
}
