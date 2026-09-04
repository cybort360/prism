import SwiftUI

struct SendMoneyView: View {
  let target: SendTarget
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var coordinator = PaymentCoordinator()
  @State private var amount = ""
  @State private var memo = ""
  @State private var asset: Stablecoin = .ausd
  @State private var showAuth = false
  @State private var error: String?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Send money", back: { dismiss() }).padding(.horizontal, 22).padding(
          .top, 10)
        Spacer().frame(height: 16)
        PrismAvatar(initials: target.contact.initials, size: 68, highlighted: true)
        Text(target.contact.name).font(PrismTheme.body(17, weight: .semibold)).padding(.top, 10)
        if let h = target.contact.handle {
          Text(h).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted)
        }
        Spacer().frame(height: 24)
        AmountText(dollars: displayAmount, size: 76).padding(.horizontal, 22)
        StablecoinPicker(selection: $asset, locked: target.requestedAsset != nil)
          .padding(.top, 8)
        HStack(spacing: 10) {
          Image(systemName: "pencil")
          TextField("Add a note", text: $memo)
        }.font(PrismTheme.body(14)).padding(.horizontal, 15).frame(height: 50).background(
          PrismTheme.surface
        ).clipShape(RoundedRectangle(cornerRadius: 15)).overlay(
          RoundedRectangle(cornerRadius: 15).stroke(PrismTheme.line, lineWidth: 0.7)
        ).padding(.horizontal, 24).padding(.top, 18)
        if let requestId = target.requestId {
          Text("Fulfills request \(short(requestId))").font(PrismTheme.body(11)).foregroundStyle(
            PrismTheme.muted
          ).padding(.top, 10)
        }
        if let error {
          VStack(spacing: 8) {
            ErrorBanner(message: error)
            if error.localizedCaseInsensitiveContains("balance") || error.localizedCaseInsensitiveContains("insufficient") {
              PrismSecondaryButton(title: "Add money", icon: "plus") { dismiss(); model.addMoneyPresented = true }
            }
          }
          .padding(.horizontal, 24).padding(.top, 10)
        }
        MoneyKeypad(value: $amount).padding(.horizontal, 30).padding(.top, 10)
        Spacer()
        PrismPrimaryButton(title: "Review & Send", enabled: atomic != nil) { showAuth = true }
          .padding(24)
      }.prismScreen()
      if coordinator.state != .idle { OperationStateOverlay(state: coordinator.state) }
    }
    .sheet(isPresented: $showAuth) {
      PaymentAuthorizationSheet(amount: displayAssetAmount) { pin, face in
        Task { await send(pin: pin, face: face) }
      }
    }
    .onAppear {
      if let requestedAsset = target.requestedAsset { asset = requestedAsset }
      if let requestId = target.requestId {
        Task {
          if let req = (try? await PrismAPI.shared.requests())?.first(where: {
            $0.requestId == requestId
          }) {
            amount = decimalText(req.amountAtomic)
            if memo.isEmpty { memo = req.memo }
          }
        }
      }
    }
  }

  private var atomic: String? {
    guard let a = Money.atomic(fromDollars: amount), a != "0" else { return nil }
    return a
  }
  private var displayAmount: String {
    amount.isEmpty
      ? "$0.00"
      : (Decimal(string: amount) ?? 0).formatted(
        .currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }
  private var displayAssetAmount: String { "\(displayAmount) \(asset.rawValue)" }
  private func decimalText(_ atomic: String) -> String {
    let n = Decimal(string: atomic) ?? 0
    return NSDecimalNumber(decimal: n / 1_000_000).stringValue
  }
  private func short(_ v: String) -> String { v.count > 12 ? "\(v.prefix(6))…\(v.suffix(4))" : v }

  private func send(pin: String?, face: Bool) async {
    guard let atomic else { return }
    await coordinator.pay(
      resolution: target.resolution, amountAtomic: atomic, asset: asset, requestId: target.requestId, memo: memo,
      pin: pin, useFaceID: face)
    switch coordinator.state {
    case .sent(let tx):
      IdentityTrustStore.shared.remember(contact: target.contact, resolution: target.resolution)
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Sent", amount: displayAssetAmount, subtitle: "to \(target.contact.name)",
        transactionHash: tx, status: "Completed")
    case .failed(let m): error = m
    default: break
    }
  }
}
