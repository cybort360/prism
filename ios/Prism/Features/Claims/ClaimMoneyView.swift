import SwiftUI

struct ClaimMoneyView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let claim: ClaimRecord
  @State private var pin = ""
  @State private var showPIN = false
  @State private var busy = false
  @State private var message = ""
  @State private var failure: ClaimFailure?

  private var fromLine: String {
    if let sender = claim.senderDisplay, !sender.isEmpty { return "from \(sender)" }
    return "waiting for you"
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      .padding(.horizontal, 22)
      .padding(.top, 10)

      Spacer()

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 116, height: 116)
        Circle().stroke(PrismTheme.mint.opacity(0.25), lineWidth: 1).frame(width: 140, height: 140)
        Image(systemName: "gift.fill")
          .font(.system(size: 40, weight: .medium))
          .foregroundStyle(PrismTheme.mintDeep)
      }

      Text("You have money waiting")
        .font(PrismTheme.body(18, weight: .semibold))
        .padding(.top, 30)

      AmountText(dollars: Money.dollars(fromAtomic: claim.amountAtomic), size: 70)
        .padding(.top, 8)

      Text(fromLine)
        .font(PrismTheme.body(14, weight: .semibold))
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 4)

      if let memo = claim.memo, !memo.isEmpty {
        Text(memo)
          .font(PrismTheme.body(11.5, weight: .semibold))
          .foregroundStyle(PrismTheme.ink)
          .padding(.horizontal, 12)
          .padding(.vertical, 7)
          .background(PrismTheme.paper)
          .clipShape(Capsule())
          .overlay(Capsule().stroke(PrismTheme.line, lineWidth: 0.6))
          .padding(.top, 10)
      }

      Text("This money is already protected for you. Claiming moves it into your Prism balance.")
        .font(PrismTheme.body(13.5))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(.horizontal, 40)
        .padding(.top, 17)

      HStack(spacing: 7) {
        Image(systemName: "lock.fill").font(.system(size: 10))
        Text("Protected on Monad")
      }
      .font(PrismTheme.body(10.5, weight: .semibold))
      .foregroundStyle(PrismTheme.mintDeep)
      .padding(.horizontal, 13)
      .padding(.vertical, 8)
      .background(PrismTheme.mintSoft)
      .clipShape(Capsule())
      .padding(.top, 18)

      if !message.isEmpty {
        Text(message)
          .font(PrismTheme.body(12))
          .foregroundStyle(PrismTheme.muted)
          .padding(.top, 16)
      }

      Spacer()

      PrismPrimaryButton(
        title: busy ? "Claiming…" : "Claim \(Money.dollars(fromAtomic: claim.amountAtomic))",
        enabled: !busy,
        icon: "arrow.down"
      ) {
        if UserDefaults.standard.bool(forKey: "payments.faceID") {
          Task { await collect(faceID: true) }
        } else {
          showPIN = true
        }
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 24)
    }
    .sheet(isPresented: $showPIN) {
      PINAuthorizationSheet(pin: $pin, title: "Approve claim") {
        Task { await collect(faceID: false) }
      }
    }
    .alert("Prism", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
      switch failure?.recovery {
      case .tryAgain:
        Button("Try again") { retry() }
        Button("Not now", role: .cancel) { failure = nil }
      case .verifyAgain:
        Button("Verify again") { retry() }
        Button("Not now", role: .cancel) { failure = nil }
      default:
        Button("OK") { failure = nil }
      }
    } message: {
      Text(failure?.message ?? "")
    }
    .prismScreen()
  }

  private func retry() {
    failure = nil
    if UserDefaults.standard.bool(forKey: "payments.faceID") {
      Task { await collect(faceID: true) }
    } else {
      showPIN = true
    }
  }

  private func collect(faceID: Bool) async {
    busy = true
    message = "Claiming…"
    defer { busy = false }

    // Local approval, then the recipient's Mera ClaimIntent + backend eligibility, relayer-submitted.
    let coordinator = PaymentCoordinator()
    await coordinator.collectClaim(claim, pin: faceID ? nil : pin, useFaceID: faceID)
    switch coordinator.state {
    case .sent(let tx):
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Money received",
        amount: Money.dollars(fromAtomic: claim.amountAtomic),
        subtitle: fromLine,
        transactionHash: tx,
        status: "Completed",
        operationId: coordinator.lastOperationId
      )
    case .failed(let m):
      message = ""
      failure = ClaimFailure.classify(m)
    default:
      break
    }
  }
}
