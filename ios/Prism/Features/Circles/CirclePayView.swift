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
  /// How this payment can actually happen, from live chain state. Asked before the confirm button
  /// does anything, so the person learns which it is before committing to it.
  @State private var preview: CirclePaymentPreview?
  @State private var overLimit: CirclePaymentPreview?
  @State private var showAuth = false
  @State private var circle: CircleDetail?
  @State private var network: PrismNetworkConfig?
  @State private var checking = false

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

        if let limit = preview?.limit, limit.hasSpendingAccess {
          CircleLimitStrip(limit: limit, spending: atomic)
            .padding(.horizontal, 24).padding(.top, 10)
        }

        if let error {
          ErrorBanner(message: error).padding(.horizontal, 24).padding(.top, 10)
        }

        MoneyKeypad(value: $amount).padding(.horizontal, 30).padding(.top, 8)

        Spacer()

        PrismPrimaryButton(title: confirmTitle, enabled: atomic != nil && !checking) {
          Task { await confirm() }
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
    .sheet(item: $overLimit) { over in
      // Over the limit is a fork, not a dead end: name the limit, and offer the Circle.
      CircleOverLimitSheet(preview: over, circleName: target.circleName) {
        overLimit = nil
        Task { await propose() }
      }
    }
    .sheet(isPresented: $showAuth) {
      PaymentAuthorizationSheet(amount: displayAmount) { pin, face in
        Task { await spend(pin: pin, face: face) }
      }
    }
    .task {
      circle = try? await PrismAPI.shared.circle(target.circleId)
      network = try? await PrismAPI.shared.config()
    }
    // Re-ask as the amount changes: the answer depends on how much, and a person typing past their
    // limit should see it happen rather than discover it at the confirm button.
    .onChange(of: amount) { _, _ in
      Task {
        guard let atomic else { preview = nil; return }
        preview = await coordinator.preview(circleId: target.circleId, amountAtomic: atomic)
      }
    }
  }

  /// The button says what will happen. Within a limit it is the member's own payment; over it, the
  /// honest verb is "request", because the Circle decides.
  private var confirmTitle: String {
    guard let preview, atomic != nil else { return "Review & Pay" }
    return preview.isWithinLimit ? "Pay \(displayAmount)" : "Request approval"
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

  /// Route the payment. Within a limit the member authorizes it alone; otherwise the Circle decides.
  /// The preview is re-fetched here rather than reused, because the limit could have moved while the
  /// amount sheet was open.
  private func confirm() async {
    guard let atomic else { return }
    error = nil
    checking = true
    defer { checking = false }
    let decision = await coordinator.preview(circleId: target.circleId, amountAtomic: atomic)
    preview = decision

    guard let decision else {
      // The question could not be answered, so fall back to the route that always exists.
      await propose()
      return
    }
    if decision.isWithinLimit {
      showAuth = true
    } else if decision.isOverLimit {
      overLimit = decision
    } else {
      await propose()
    }
  }

  private func spend(pin: String?, face: Bool) async {
    guard let atomic, let circle, let network else { return }
    guard let moduleAddress = network.allowanceModule else {
      // No verified module on this deployment, so there is nothing to spend through. The Circle
      // route always exists, so this is a fallback rather than a failure.
      await propose()
      return
    }
    error = nil
    await coordinator.spendWithinLimit(
      circleId: target.circleId, circle: circle, resolution: target.resolution,
      amountAtomic: atomic, memo: memo, moduleAddress: moduleAddress, usdcAddress: network.usdc,
      reviewedRecipient: target.resolution.attestation?.recipientAccount ?? "",
      availableAtomic: preview?.limit?.availableAtomic, pin: pin, useFaceID: face)

    switch coordinator.state {
    case .sent(let tx):
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Paid",
        amount: displayAmount,
        subtitle: "to \(target.contact.name) from \(target.circleName)",
        transactionHash: tx,
        status: "Completed",
        // A within-limit spend is an ordinary Prism payment, so its id opens the ordinary detail
        // screen — the same receipt and the same proof a personal payment gets.
        operationId: coordinator.lastSpend?.spendId)
    case .failed(let message): error = message
    default: break
    }
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
