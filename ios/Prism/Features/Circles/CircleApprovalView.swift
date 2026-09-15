import SwiftUI

/// The admin's approval screen.
///
/// This is the most consequential screen in Circles, and the one with the narrowest job: show a
/// person exactly what they are about to authorize, then prove — on this device, before Face ID —
/// that what was shown is what will be signed.
///
/// The proof is not in this file. `CircleApprovalValidator` performs it, and `CircleCoordinator`
/// refuses to reach the signing call without it. What this file is responsible for is making the
/// *shown* half honest: the amount, the recipient, the Circle it comes out of, who asked, and how
/// many approvals are still needed — with the approval count coming from verified signatures against
/// the live Safe owner set, never from a number the backend kept.
struct CircleApprovalView: View {
  let presentation: CircleApprovalPresentation
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var coordinator = CircleCoordinator()
  @State private var payment: CirclePayment
  @State private var showAuth = false
  @State private var error: String?
  @State private var usdcAddress: String?

  init(presentation: CircleApprovalPresentation) {
    self.presentation = presentation
    _payment = State(initialValue: presentation.payment)
  }

  var body: some View {
    ZStack {
      ScrollView(showsIndicators: false) {
        VStack(spacing: 0) {
          PrismTopBar(title: "Approval", back: { dismiss() }).padding(.top, 10)

          Text((payment.memo?.isEmpty == false ? payment.memo! : payment.recipientLabel).uppercased())
            .font(PrismTheme.body(12, weight: .semibold))
            .tracking(1.4)
            .foregroundStyle(PrismTheme.muted)
            .padding(.top, 26)

          Text(Money.dollars(fromAtomic: payment.amount ?? "0"))
            .font(PrismTheme.display(56))
            .tracking(-1.4)
            .monospacedDigit()
            .padding(.top, 8)

          VStack(alignment: .leading, spacing: 14) {
            row("From", payment.circleName ?? presentation.circle.name)
            row("To", payment.recipientLabel)
            row("Requested by", requesterLabel)
            approvalRow
          }
          .padding(18)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(PrismTheme.surface)
          .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
          .padding(.horizontal, 22)
          .padding(.top, 26)

          if let state = blockingState {
            CircleNotice(state: state, action: noticeAction(for: state))
              .padding(.horizontal, 22).padding(.top, 16)
          }

          if let error {
            ErrorBanner(message: error).padding(.horizontal, 24).padding(.top, 14)
          }

          // Said once, plainly, because it is the reason this screen is safe to trust.
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.shield.fill").foregroundStyle(PrismTheme.mintDeep)
            Text("Before you approve, this device rebuilds the transaction from what you see here and refuses to sign if it doesn't match.")
              .font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted).lineSpacing(2)
          }
          .padding(.horizontal, 24).padding(.top, 16)

          Spacer(minLength: 26)

          actions.padding(.horizontal, 22).padding(.bottom, 24)
        }
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
      PaymentAuthorizationSheet(amount: Money.dollars(fromAtomic: payment.amount ?? "0")) { pin, face in
        Task { await approve(pin: pin, face: face) }
      }
    }
    .task {
      // The USDC address the payment must target comes from the network config, not from the
      // payment — checking a payload against a value it supplied would prove nothing.
      let network = try? await PrismAPI.shared.config()
      usdcAddress = network?.usdc
      await refresh()
    }
  }

  @ViewBuilder private var actions: some View {
    if payment.isComplete {
      PrismPrimaryButton(title: "Done", icon: "checkmark") { dismiss() }
    } else if payment.isDead {
      PrismSecondaryButton(title: "Close", icon: "xmark") { dismiss() }
    } else if payment.isReadyToSend {
      // Enough valid signatures exist. Sending grants nothing further — the backend still re-reads
      // the Safe's live authority and simulates before anything is broadcast.
      PrismPrimaryButton(title: "Send payment", icon: "paperplane.fill") { Task { await send() } }
    } else {
      PrismPrimaryButton(title: "Approve", enabled: canApprove && usdcAddress != nil) { showAuth = true }
    }
  }

  private var approvalRow: some View {
    HStack {
      Text("Approval").font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      if let progress = payment.approvalProgress {
        Text(progress).font(PrismTheme.body(13.5, weight: .semibold)).monospacedDigit()
      } else {
        // The chain could not be read. An unknown approval count is a truthful answer; a
        // remembered one would not be.
        Text("Unknown").font(PrismTheme.body(13.5, weight: .semibold)).foregroundStyle(PrismTheme.amber)
      }
    }
  }

  /// Everything that would stop this approval, in the order a person would want to hear it.
  ///
  /// These are the shared Circle states rather than strings written here, so the same situation
  /// reads identically on this screen, in the Circle's list and on the pay screen — and so each one
  /// carries a next action instead of dead-ending.
  private var blockingState: CircleState? {
    if let binding = payment.binding, binding.ok == false {
      return .setupFailed(reason: "This payment changed after it was proposed, so the approvals on it no longer count: \(binding.reasons?.first ?? "its details no longer match what was signed").")
    }
    switch payment.lifecycle {
    case "EXPIRED": return .proposalStale
    case "FAILED": return .setupFailed(reason: payment.failureReason)
    case "CANCELLED": return .setupFailed(reason: "This payment was cancelled.")
    case "COMPLETED": return .alreadyExecuted(transactionHash: payment.executionTxHash)
    default: break
    }
    // The one state only the backend can tell us about: an approval that counted before an admin was
    // removed no longer counts, so a payment slips back from APPROVED to waiting.
    if payment.storedLifecycle == "APPROVED" && payment.lifecycle == "APPROVAL_PENDING" {
      return .adminRemoved
    }
    if alreadyApproved { return .approvalAlreadyCounted }
    if let blocked = coordinator.blockedReason { return .networkUnavailable(detail: blocked) }
    if payment.approvalProgress == nil { return .networkUnavailable(detail: nil) }
    if payment.sufficientBalance == false {
      return .insufficientFunds(
        available: nil, needed: Money.assetAmount(fromAtomic: payment.amount ?? "0"))
    }
    return nil
  }

  /// Whether this admin's approval is already counted — matched on the authority that signed, which
  /// is what the Safe counts, so a second approval is never solicited.
  private var alreadyApproved: Bool {
    guard let mine = presentation.circle.members?
      .first(where: { $0.prismId == model.identity?.prismId })?.authorityAddress?.lowercased()
    else { return false }
    return (payment.approvals ?? []).contains { $0.authorityAddress.lowercased() == mine }
  }

  /// Every notice leads somewhere. Closing returns to the Circle, which is where adding money,
  /// seeing the receipt and suggesting the payment again all live — so "back to the Circle" is a
  /// real next step rather than a way of dismissing the problem.
  private func noticeAction(for state: CircleState) -> (() -> Void)? {
    switch state {
    case .networkUnavailable: return { Task { await refresh() } }
    case .insufficientFunds, .approvalAlreadyCounted, .alreadyExecuted, .proposalStale, .adminRemoved:
      return { dismiss() }
    default: return nil
    }
  }

  private var canApprove: Bool {
    payment.binding?.ok != false && !payment.isDead && !payment.isComplete && !alreadyApproved
  }

  private var requesterLabel: String {
    guard let proposer = payment.proposerPrismId else { return "a member" }
    if let member = presentation.circle.members?.first(where: { $0.prismId == proposer }) {
      return member.displayName ?? member.handle ?? "a member"
    }
    return proposer == model.identity?.prismId ? "you" : "a member"
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      Text(value).font(PrismTheme.body(13.5, weight: .semibold)).multilineTextAlignment(.trailing)
    }
  }

  private func refresh() async {
    if let fresh = try? await PrismAPI.shared.circlePayment(
      circleId: payment.circleId, proposalId: payment.proposalId) {
      payment = fresh
    }
  }

  private func approve(pin: String?, face: Bool) async {
    guard let usdcAddress else { return }
    error = nil
    await coordinator.approve(
      payment: payment, circle: presentation.circle, usdcAddress: usdcAddress, pin: pin, useFaceID: face)
    switch coordinator.state {
    case .failed(let message): error = message
    default: if let updated = coordinator.lastPayment { payment = updated }
    }
  }

  private func send() async {
    error = nil
    await coordinator.send(payment: payment)
    if let updated = coordinator.lastPayment { payment = updated }
    switch coordinator.state {
    case .sent(let tx):
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Paid",
        amount: Money.dollars(fromAtomic: payment.amount ?? "0"),
        subtitle: "from \(payment.circleName ?? presentation.circle.name)",
        transactionHash: tx,
        status: "Completed",
        // The proposal id IS the canonical payment id: "View details" opens the shared receipt,
        // with who requested it, who approved it, and the proof underneath.
        operationId: payment.proposalId)
    case .failed(let message): error = message
    default: break
    }
  }
}
