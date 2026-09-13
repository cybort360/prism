import SwiftUI

/// Pay someone *from* a Circle.
///
/// Structurally this is the personal Send screen — the same amount keypad, the same note field, the
/// same person at the top, resolved through the same Protected Alias Resolver. One line differs, and
/// it is the important one: **Paid from Lagos Trip**. Money is leaving a shared account.
///
/// The other difference is what the button does. A personal send ends in a receipt. This ends in a
/// proposal: the Circle's admins have to approve it before anything moves, and saying so plainly is
/// the difference between a person understanding the Circle and being surprised by it.
struct CirclePayView: View {
  let target: CirclePayTarget
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var coordinator = CircleCoordinator()
  @State private var amount = ""
  @State private var memo = ""
  @State private var error: String?
  @State private var proposed: CirclePayment?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Pay", back: { dismiss() }).padding(.horizontal, 22).padding(.top, 10)

        Spacer().frame(height: 16)
        PrismAvatar(initials: target.contact.initials, size: 68, highlighted: true)
        Text(target.contact.name).font(PrismTheme.body(17, weight: .semibold)).padding(.top, 10)
        if let handle = target.contact.handle {
          Text(handle).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted)
        }

        Spacer().frame(height: 22)
        AmountText(dollars: displayAmount, size: 72).padding(.horizontal, 22)

        HStack(spacing: 10) {
          Image(systemName: "pencil")
          TextField("What's it for", text: $memo)
        }
        .font(PrismTheme.body(14))
        .padding(.horizontal, 15).frame(height: 50)
        .background(PrismTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 15))
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(PrismTheme.line, lineWidth: 0.7))
        .padding(.horizontal, 24).padding(.top, 16)

        paidFromRow.padding(.horizontal, 24).padding(.top, 12)

        if let error {
          ErrorBanner(message: error).padding(.horizontal, 24).padding(.top, 10)
        }

        MoneyKeypad(value: $amount).padding(.horizontal, 30).padding(.top, 8)

        Spacer()

        PrismPrimaryButton(title: "Review & Pay", enabled: atomic != nil) {
          Task { await propose() }
        }
        .padding(24)
      }
      .prismScreen()

      if coordinator.state != .idle {
        OperationStateOverlay(state: coordinator.state, onDismiss: { coordinator.reset() })
      }
    }
    .sheet(item: $proposed) { payment in
      CirclePaymentProposedSheet(payment: payment, circleName: target.circleName) { dismiss() }
    }
  }

  /// The single line that makes this screen different from a personal send.
  private var paidFromRow: some View {
    HStack(spacing: 12) {
      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 34, height: 34)
        Image(systemName: "person.2.fill").font(.system(size: 13, weight: .medium)).foregroundStyle(PrismTheme.mintDeep)
      }
      VStack(alignment: .leading, spacing: 2) {
        PrismSectionLabel(text: "Paid from")
        Text(target.circleName).font(PrismTheme.body(14, weight: .semibold))
      }
      Spacer()
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
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

  private func propose() async {
    guard let atomic else { return }
    error = nil
    await coordinator.proposePayment(
      circleId: target.circleId, resolution: target.resolution, amountAtomic: atomic, memo: memo)
    switch coordinator.state {
    case .failed(let message):
      error = message
    default:
      if let payment = coordinator.lastPayment {
        IdentityTrustStore.shared.remember(contact: target.contact, resolution: target.resolution)
        proposed = payment
      }
    }
  }
}

/// What happens after a Circle payment is proposed: nothing yet, and the sheet says so.
///
/// A person who has just tapped "Pay" reasonably expects the money to be gone. It is not, and
/// pretending otherwise — with a receipt, or a checkmark — would be the single most misleading thing
/// this flow could do. So the sheet leads with how many approvals are needed and who still has to
/// give them.
private struct CirclePaymentProposedSheet: View {
  let payment: CirclePayment
  let circleName: String
  let done: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      Capsule().fill(PrismTheme.line).frame(width: 38, height: 5).padding(.top, 10)

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 68, height: 68)
        Image(systemName: "person.2.badge.key.fill")
          .font(.system(size: 24, weight: .medium)).foregroundStyle(PrismTheme.mintDeep)
      }
      .padding(.top, 28)

      Text("Waiting for approval").font(PrismTheme.display(29)).tracking(-0.5).padding(.top, 18)

      Text(Money.dollars(fromAtomic: payment.amount ?? "0"))
        .font(PrismTheme.display(46)).tracking(-1.2).monospacedDigit().padding(.top, 4)

      Text("to \(payment.recipientLabel)")
        .font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted).padding(.top, 4)

      VStack(alignment: .leading, spacing: 12) {
        row("Paid from", circleName)
        if let progress = payment.approvalProgress { row("Approval", progress) }
        if payment.sufficientBalance == false {
          // Stated, not hidden: the Circle can still be topped up before this executes.
          row("Circle balance", "Not enough yet", tone: PrismTheme.amber)
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(PrismTheme.surface)
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .padding(.horizontal, 24).padding(.top, 22)

      Text("Nothing has moved yet. The Circle's admins each approve on their own device, and the payment is sent once enough of them have.")
        .font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center).lineSpacing(2)
        .padding(.horizontal, 30).padding(.top, 16)

      Spacer()

      PrismPrimaryButton(title: "Done", icon: "checkmark") { dismiss(); done() }
        .padding(24)
    }
    .prismScreen()
  }

  private func row(_ label: String, _ value: String, tone: Color = PrismTheme.ink) -> some View {
    HStack {
      Text(label).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      Text(value).font(PrismTheme.body(13.5, weight: .semibold)).foregroundStyle(tone)
    }
  }
}
