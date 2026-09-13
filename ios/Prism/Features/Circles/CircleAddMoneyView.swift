import SwiftUI

/// Add money to a Circle from your own Prism balance.
///
/// The screen is deliberately plain, because the action is: this needs one person's consent — their
/// own — and no approval from anyone else. Underneath it is an ordinary Prism payment whose
/// recipient is the Circle's Safe, so the money leg is the audited router/ERC-3009/relayer path,
/// not a second mechanism (see docs/CIRCLE_PAYMENTS.md §2).
///
/// The one honesty requirement the UI carries: *Added* means the contribution reached COMPLETED,
/// which the backend only writes from an on-chain receipt. Everything before that says *Settling…*.
struct CircleAddMoneyView: View {
  let circle: CircleSummary
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var coordinator = CircleCoordinator()
  @State private var amount = ""
  @State private var showAuth = false
  @State private var error: String?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Add money", back: { dismiss() })
          .padding(.horizontal, 22).padding(.top, 10)

        Spacer().frame(height: 18)

        ZStack {
          Circle().fill(PrismTheme.mintSoft).frame(width: 64, height: 64)
          Text(circle.icon ?? "◎").font(PrismTheme.display(26)).foregroundStyle(PrismTheme.mintDeep)
        }
        Text(circle.name)
          .font(PrismTheme.body(17, weight: .semibold))
          .padding(.top, 10)

        Spacer().frame(height: 22)

        AmountText(dollars: displayAmount, size: 76).padding(.horizontal, 22)

        // "From" is stated rather than chosen: a contribution always comes from the contributor's
        // own Prism balance. Showing it as a fixed row — not a picker — keeps that honest.
        sourceRow.padding(.horizontal, 24).padding(.top, 18)

        if let error {
          VStack(spacing: 8) {
            ErrorBanner(message: error)
            if error.localizedCaseInsensitiveContains("balance") {
              PrismSecondaryButton(title: "Add money to your balance", icon: "plus") {
                dismiss()
                model.addMoneyPresented = true
              }
            }
          }
          .padding(.horizontal, 24).padding(.top, 10)
        }

        MoneyKeypad(value: $amount).padding(.horizontal, 30).padding(.top, 10)

        Spacer()

        PrismPrimaryButton(title: addButtonTitle, enabled: atomic != nil) { showAuth = true }
          .padding(24)
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
        Task { await add(pin: pin, face: face) }
      }
    }
  }

  private var sourceRow: some View {
    HStack(spacing: 12) {
      ZStack {
        Circle().fill(PrismTheme.surface).frame(width: 36, height: 36)
        Image(systemName: "wallet.bifold").font(.system(size: 15, weight: .medium)).foregroundStyle(PrismTheme.muted)
      }
      VStack(alignment: .leading, spacing: 2) {
        PrismSectionLabel(text: "From")
        Text("Your Prism balance").font(PrismTheme.body(14, weight: .semibold))
      }
      Spacer()
      Text("USDC").font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
    }
    .padding(15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
  }

  private var addButtonTitle: String {
    amount.isEmpty ? "Add money" : "Add \(displayAmount)"
  }

  private var atomic: String? {
    guard let value = Money.atomic(fromDollars: amount), value != "0" else { return nil }
    return value
  }

  private var displayAmount: String {
    amount.isEmpty
      ? "$0.00"
      : (Decimal(string: amount) ?? 0).formatted(
        .currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }

  private func add(pin: String?, face: Bool) async {
    guard let atomic else { return }
    await coordinator.addMoney(circleId: circle.circleId, amountAtomic: atomic, pin: pin, useFaceID: face)
    switch coordinator.state {
    case .sent(let tx):
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Added",
        amount: displayAmount,
        subtitle: "Added to \(circle.name)",
        transactionHash: tx,
        status: "Completed",
        operationId: coordinator.lastContribution?.operationId)
    case .failed(let message):
      error = message
    default:
      break
    }
  }
}
