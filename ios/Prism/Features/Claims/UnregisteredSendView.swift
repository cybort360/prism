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
          Image(systemName: "lock.shield")
            .foregroundStyle(PrismTheme.mintDeep)
          Text("\(contact.name) isn't on Prism yet. The money stays protected for 7 days until \(contact.name) verifies this number and claims it. If it isn't claimed, you'll be able to get it back.")
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
        OperationStateOverlay(
          state: coordinator.state,
          onDismiss: { coordinator.reset() },
          onViewActivity: { dismiss(); model.selectedTab = .activity })
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
      // Remember the recipient locally (name never leaves the device) and build a safe reminder.
      var invite: String? = nil
      var expiresLine: String? = nil
      if let claimId = coordinator.lastClaimId {
        ClaimRecipientStore.remember(claimId: claimId, name: contact.name)
        invite = ClaimInvite.message(senderName: senderName, amount: displayAmount, claimId: claimId)
        let expiry = Date().addingTimeInterval(7 * 24 * 3600)
        expiresLine = "Expires \(expiry.formatted(date: .abbreviated, time: .omitted))"
      }
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Protected for \(contact.name)",
        amount: displayAmount,
        subtitle: "Waiting for \(contact.name) to join Prism and claim it",
        transactionHash: transactionHash,
        status: "Waiting to be claimed",
        operationId: coordinator.lastOperationId,
        expiresLine: expiresLine,
        shareMessage: invite
      )
    case .failed(let message):
      error = message
    default:
      break
    }
  }

  private var senderName: String {
    model.identity?.displayName ?? model.identity?.handle.map { "@\($0)" } ?? "Someone"
  }
}
