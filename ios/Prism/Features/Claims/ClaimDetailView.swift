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

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Claim").font(PrismTheme.display(35)).tracking(-0.5)
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      .padding(.top, 10)

      Spacer()

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 104, height: 104)
        Image(systemName: claim.refundAvailable == true ? "arrow.uturn.backward" : "clock")
          .font(.system(size: 34, weight: .medium))
          .foregroundStyle(PrismTheme.mintDeep)
      }

      AmountText(dollars: Money.dollars(fromAtomic: claim.amountAtomic), size: 67)
        .padding(.top, 24)

      Text(claim.tokenSymbol ?? Stablecoin.resolve(symbol: nil, address: claim.token).rawValue)
        .font(PrismTheme.body(12, weight: .semibold))
        .foregroundStyle(PrismTheme.mintDeep)
        .padding(.top, 6)

      Text(claimStatus)
        .font(PrismTheme.body(14.5, weight: .semibold))
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 7)

      Text(expiryText)
        .font(PrismTheme.body(12.5))
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 6)

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

      if !message.isEmpty {
        Text(message).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted).padding(.top, 17)
      }

      Spacer()

      if claim.refundAvailable == true {
        PrismPrimaryButton(
          title: busy ? "Refunding…" : "Refund \(Money.assetAmount(fromAtomic: claim.amountAtomic, symbol: claim.tokenSymbol))",
          enabled: !busy,
          icon: "arrow.uturn.backward"
        ) {
          if UserDefaults.standard.bool(forKey: "payments.faceID") {
            Task { await refund(faceID: true) }
          } else {
            showPIN = true
          }
        }
      } else {
        PrismCard(padding: 16) {
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "clock").foregroundStyle(PrismTheme.mintDeep)
            Text("Refund becomes available after expiry if the recipient has not claimed the payment.")
              .font(PrismTheme.body(12.5))
              .foregroundStyle(PrismTheme.muted)
          }
        }
      }
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

  private var claimStatus: String {
    claim.status.replacingOccurrences(of: "_", with: " ").capitalized
  }

  private var expiryText: String {
    let date = Date(timeIntervalSince1970: TimeInterval(claim.expiry))
    return "Expires \(date.formatted(date: .abbreviated, time: .shortened))"
  }

  private func refund(faceID: Bool) async {
    busy = true
    message = "Returning your money…"
    defer { busy = false }

    // Refund-after-expiry returns funds to the sender; relayer-submitted after local approval.
    let coordinator = PaymentCoordinator()
    await coordinator.refundClaim(claim, pin: faceID ? nil : pin, useFaceID: faceID)
    switch coordinator.state {
    case .sent(let tx):
      dismiss()
      model.presentReceipt = ReceiptPresentation(
        title: "Refunded",
        amount: Money.assetAmount(fromAtomic: claim.amountAtomic, symbol: claim.tokenSymbol),
        subtitle: "Unclaimed payment returned",
        transactionHash: tx,
        status: "Completed"
      )
    case .failed(let m):
      error = m
    default:
      break
    }
  }
}
