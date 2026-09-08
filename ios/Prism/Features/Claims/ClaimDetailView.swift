import SwiftUI

struct ClaimDetailView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let claim: ClaimRecord
  @State private var pin = ""
  @State private var showPIN = false
  @State private var busy = false
  @State private var message = ""
  @State private var error: String?

  // The recipient's friendly name lives only on the sender's device (never on-chain / on the backend).
  private var recipientName: String { ClaimRecipientStore.name(for: claim.claimId) ?? "your recipient" }

  private enum Phase { case waiting, expired, delivered, returned }
  private var phase: Phase {
    switch claim.status {
    case "claimed", "claim_submitted": return .delivered
    case "refunded", "refund_submitted": return .returned
    default: return claim.isExpired ? .expired : .waiting
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Payment").font(PrismTheme.display(35)).tracking(-0.5)
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      .padding(.top, 10)

      Spacer()

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 104, height: 104)
        Image(systemName: headerIcon)
          .font(.system(size: 34, weight: .medium))
          .foregroundStyle(PrismTheme.mintDeep)
      }

      Text(recipientName.uppercased())
        .font(PrismTheme.body(11, weight: .semibold))
        .tracking(1.2)
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 20)

      AmountText(dollars: Money.dollars(fromAtomic: claim.amountAtomic), size: 60)
        .padding(.top, 8)

      Text(headline)
        .font(PrismTheme.body(14.5, weight: .semibold))
        .foregroundStyle(PrismTheme.ink)
        .padding(.top, 8)

      if let memo = claim.memo, !memo.isEmpty {
        Text(memo)
          .font(PrismTheme.body(11.5, weight: .semibold))
          .padding(.horizontal, 12)
          .padding(.vertical, 7)
          .background(PrismTheme.paper)
          .clipShape(Capsule())
          .overlay(Capsule().stroke(PrismTheme.line, lineWidth: 0.6))
          .padding(.top, 12)
      }

      if phase == .expired {
        Text("\(recipientName) did not claim this payment.\n\(Money.dollars(fromAtomic: claim.amountAtomic)) can now be returned to you.")
          .font(PrismTheme.body(13))
          .foregroundStyle(PrismTheme.muted)
          .multilineTextAlignment(.center)
          .lineSpacing(2)
          .padding(.horizontal, 34)
          .padding(.top, 18)
      } else {
        timeline.padding(.top, 22).padding(.horizontal, 8)
      }

      if !message.isEmpty {
        Text(message).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted).padding(.top, 16)
      }

      Spacer()

      footer
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 24)
    .prismScreen()
    .sheet(isPresented: $showPIN) {
      PINAuthorizationSheet(pin: $pin, title: "Approve refund") {
        Task { await refund(faceID: false) }
      }
    }
    .alert("Prism", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") { error = nil }
    } message: {
      Text(error ?? "")
    }
  }

  // MARK: header/copy per phase

  private var headerIcon: String {
    switch phase {
    case .waiting: return "clock"
    case .expired: return "arrow.uturn.backward"
    case .delivered: return "checkmark"
    case .returned: return "arrow.uturn.backward"
    }
  }

  private var headline: String {
    switch phase {
    case .waiting: return "Protected — waiting to be claimed"
    case .expired: return "Expired"
    case .delivered: return "Delivered to \(recipientName)"
    case .returned: return "Returned to you"
    }
  }

  // MARK: timeline

  private var timeline: some View {
    let claimedOrDelivered = phase == .delivered
    let steps: [(String, Bool)] = [
      ("Payment created", true),
      ("Funds protected", true),
      (claimedOrDelivered ? "\(recipientName) claimed it" : "Waiting for \(recipientName)", claimedOrDelivered),
      ("Delivered", claimedOrDelivered)
    ]
    return VStack(alignment: .leading, spacing: 14) {
      ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
        HStack(spacing: 12) {
          Image(systemName: step.1 ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 17))
            .foregroundStyle(step.1 ? PrismTheme.mintDeep : PrismTheme.line)
          Text(step.0)
            .font(PrismTheme.body(13.5, weight: step.1 ? .semibold : .regular))
            .foregroundStyle(step.1 ? PrismTheme.ink : PrismTheme.muted)
          Spacer()
        }
      }
      HStack(spacing: 12) {
        Image(systemName: "calendar").font(.system(size: 14)).foregroundStyle(PrismTheme.muted)
        Text(expiryText).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
        Spacer()
      }
      .padding(.top, 2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: footer action per phase

  @ViewBuilder private var footer: some View {
    switch phase {
    case .waiting:
      ShareLink(item: ClaimInvite.message(senderName: senderName, amount: Money.dollars(fromAtomic: claim.amountAtomic), claimId: claim.claimId)) {
        HStack(spacing: 8) {
          Image(systemName: "paperplane.fill").font(.system(size: 14, weight: .semibold))
          Text("Remind \(recipientName)").font(PrismTheme.body(16, weight: .semibold))
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .frame(height: 56)
        .background(PrismTheme.ink)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
      }
    case .expired:
      PrismPrimaryButton(
        title: busy ? "Returning…" : "Return \(Money.dollars(fromAtomic: claim.amountAtomic))",
        enabled: !busy,
        icon: "arrow.uturn.backward"
      ) {
        if UserDefaults.standard.bool(forKey: "payments.faceID") {
          Task { await refund(faceID: true) }
        } else {
          showPIN = true
        }
      }
    case .delivered, .returned:
      if let opId = deliveredOpId {
        Button("View payment") {
          dismiss()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            model.presentPaymentDetails = PaymentDetailsPresentation(operationId: opId)
          }
        }
        .font(PrismTheme.body(15, weight: .semibold))
        .foregroundStyle(PrismTheme.mintDeep)
      }
    }
  }

  private var deliveredOpId: String? {
    claim.claimTransactionHash ?? claim.refundTransactionHash
  }

  private var senderName: String {
    model.identity?.displayName ?? model.identity?.handle.map { "@\($0)" } ?? "Someone"
  }

  private var expiryText: String {
    let verb = claim.isExpired ? "Expired" : "Expires"
    return "\(verb) \(claim.expiresAt.formatted(date: .abbreviated, time: .shortened))"
  }

  private func refund(faceID: Bool) async {
    busy = true
    message = "Returning your money…"
    defer { busy = false }

    // Refund-after-expiry returns funds to the original sender (contract-enforced); relayer-submitted.
    let coordinator = PaymentCoordinator()
    await coordinator.refundClaim(claim, pin: faceID ? nil : pin, useFaceID: faceID)
    switch coordinator.state {
    case .sent(let tx):
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "\(Money.dollars(fromAtomic: claim.amountAtomic)) returned",
        amount: Money.dollars(fromAtomic: claim.amountAtomic),
        subtitle: "This payment expired before \(recipientName) claimed it",
        transactionHash: tx,
        status: "Returned",
        operationId: coordinator.lastOperationId
      )
    case .failed(let m):
      message = ""
      error = ClaimFailure.classify(m).message
    default:
      break
    }
  }
}
