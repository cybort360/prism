import SwiftUI

struct UnregisteredSendView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let contact: ContactPerson
  @StateObject private var coordinator = PaymentCoordinator()
  @State private var amount = ""
  @State private var memo = ""
  @State private var showAuth = false
  @State private var error: String?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Send money", back: { dismiss() })
          .padding(.horizontal, 22)
          .padding(.top, 10)

        Spacer().frame(height: 20)
        PrismAvatar(initials: contact.initials, size: 72, highlighted: true)
        Text(contact.name)
          .font(PrismTheme.body(17, weight: .semibold))
          .padding(.top, 10)
        PrismStatusPill(text: "Not on Prism yet", tone: .pending)
          .padding(.top, 7)

        Spacer().frame(height: 21)
        AmountText(dollars: displayAmount, size: 77)

        HStack(spacing: 9) {
          Image(systemName: "pencil").font(.system(size: 13)).foregroundStyle(PrismTheme.muted)
          TextField("Add a note", text: $memo).font(PrismTheme.body(13.5))
        }
        .padding(.horizontal, 15)
        .frame(height: 48)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(PrismTheme.line, lineWidth: 0.6))
        .frame(maxWidth: 250)
        .padding(.top, 17)

        HStack(alignment: .top, spacing: 9) {
          Image(systemName: "clock.badge.checkmark")
            .foregroundStyle(PrismTheme.mintDeep)
          Text("Send now. The money waits for up to 7 days. If this number never verifies and claims it, your refund becomes available.")
            .font(PrismTheme.body(11.5))
            .foregroundStyle(PrismTheme.muted)
            .lineSpacing(1.5)
        }
        .padding(.horizontal, 28)
        .padding(.top, 14)

        if let error {
          ErrorBanner(message: error).padding(.horizontal, 24).padding(.top, 10)
        }

        MoneyKeypad(value: $amount)
          .padding(.horizontal, 30)
          .padding(.top, 7)

        Spacer(minLength: 2)

        PrismPrimaryButton(
          title: atomic == nil ? "Enter an amount" : "Send anyway",
          enabled: atomic != nil,
          icon: "arrow.up.right"
        ) { showAuth = true }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
      }
      .prismScreen()

      if coordinator.state != .idle {
        OperationStateOverlay(state: coordinator.state)
      }
    }
    .sheet(isPresented: $showAuth) {
      PaymentAuthorizationSheet(amount: displayAmount) { pin, face in
        Task { await fund(pin: pin, face: face) }
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

  private func fund(pin: String?, face: Bool) async {
    guard let phone = contact.phone, let atomic else { return }
    await coordinator.fundClaim(phone: phone, amountAtomic: atomic, memo: memo, pin: pin, useFaceID: face)

    switch coordinator.state {
    case .sent(let transactionHash):
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Money waiting",
        amount: displayAmount,
        subtitle: "Waiting for \(contact.name) to join and claim",
        transactionHash: transactionHash,
        status: "Waiting to be claimed",
        operationId: coordinator.lastOperationId
      )
    case .failed(let message):
      error = message
    default:
      break
    }
  }
}
