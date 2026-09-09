import SwiftUI

/// Pay from the user's **PrismP256Account** — a smart account whose spending authority is this device's
/// P-256 key (Secure Enclave on hardware; a labeled software key in the Simulator), verified on-chain
/// by Monad's precompile. The relayer sponsors gas. This is a distinct funding source from the Mera
/// account and is surfaced here as a capability, not the primary consumer send path.
struct P256PayView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var coordinator = PaymentCoordinator()

  @State private var credential: DeviceP256Credential?
  @State private var account: String?
  @State private var recipient = ""
  @State private var amount = ""
  @State private var loading = true
  @State private var error: String?

  var body: some View {
    ZStack {
      ScrollView(showsIndicators: false) {
        VStack(alignment: .leading, spacing: 16) {
          header
          if loading {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
          } else {
            accountCard
            field("Recipient address", text: $recipient, placeholder: "0x…", mono: true)
            field("Amount (USDC)", text: $amount, placeholder: "1.00", mono: false)
            if let error { ErrorBanner(message: error) }
            PrismPrimaryButton(
              title: atomic == nil ? "Enter recipient & amount" : "Pay \(displayAmount) with device key",
              enabled: atomic != nil && isAddress(recipient),
              icon: "lock.shield"
            ) { Task { await pay() } }
            .padding(.top, 4)
          }
        }
        .padding(.horizontal, 22).padding(.top, 8).padding(.bottom, 32)
      }
      if coordinator.state != .idle { OperationStateOverlay(state: coordinator.state) }
    }
    .background(PrismTheme.canvas.ignoresSafeArea())
    .navigationTitle("").navigationBarTitleDisplayMode(.inline)
    .task { await load() }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Device-key account").font(PrismTheme.display(28)).tracking(-0.4)
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      Text("Spending is authorized by your device's P-256 key and verified on-chain. Gas is sponsored — you hold no MON.")
        .font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted).lineSpacing(2)
    }
    .padding(.top, 6)
  }

  private var accountCard: some View {
    PrismCard {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          PrismSectionLabel(text: "This account")
          Spacer()
          Text(credential?.isSecureEnclave == true ? "Secure Enclave" : "Software key (dev)")
            .font(PrismTheme.body(10.5, weight: .semibold))
            .foregroundStyle(credential?.isSecureEnclave == true ? PrismTheme.mintDeep : PrismTheme.amber)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background((credential?.isSecureEnclave == true ? PrismTheme.mintSoft : PrismTheme.amber.opacity(0.12)))
            .clipShape(Capsule())
        }
        Text(account ?? "—").font(PrismTheme.mono(11.5)).foregroundStyle(PrismTheme.ink).textSelection(.enabled)
        Text("Fund this account with USDC to pay from it. It holds no MON — the relayer pays gas.")
          .font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted).lineSpacing(1.5)
      }
    }
  }

  private func field(_ label: String, text: Binding<String>, placeholder: String, mono: Bool) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      PrismSectionLabel(text: label)
      TextField(placeholder, text: text)
        .font(mono ? PrismTheme.mono(12.5) : PrismTheme.body(15))
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .keyboardType(mono ? .default : .decimalPad)
        .padding(.horizontal, 14).frame(height: 48)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(PrismTheme.line, lineWidth: 0.7))
    }
  }

  private var atomic: String? {
    guard let a = Money.atomic(fromDollars: amount), a != "0" else { return nil }
    return a
  }
  private var displayAmount: String {
    amount.isEmpty ? "$0.00" : (Decimal(string: amount) ?? 0).formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }
  private func isAddress(_ s: String) -> Bool { s.count == 42 && s.hasPrefix("0x") }

  private func load() async {
    let cred = DeviceP256CredentialStore.loadOrCreate()
    credential = cred
    do {
      let (qx, qy) = cred.publicKeyXY
      account = try await PrismAPI.shared.ensureP256Account(qx: qx, qy: qy).account
    } catch {
      self.error = error.localizedDescription
    }
    loading = false
  }

  private func pay() async {
    guard let credential, let atomic, isAddress(recipient) else { return }
    error = nil
    await coordinator.payViaP256Account(credential: credential, recipientAddress: recipient, amountAtomic: atomic)
    switch coordinator.state {
    case .sent(let tx):
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Sent from device key", amount: displayAmount,
        subtitle: "to \(short(recipient))", transactionHash: tx, status: "Completed")
    case .failed(let m):
      error = m
    default:
      break
    }
  }
  private func short(_ a: String) -> String { a.count > 12 ? "\(a.prefix(6))…\(a.suffix(4))" : a }
}
