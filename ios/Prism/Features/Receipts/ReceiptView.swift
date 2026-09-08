import SwiftUI

struct ReceiptView: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var model: AppModel
  let receipt: ReceiptPresentation
  @State private var showNetwork = false

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      .padding(.top, 10)

      Spacer()

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 112, height: 112)
        Circle().stroke(PrismTheme.mint.opacity(0.24), lineWidth: 1).frame(width: 136, height: 136)
        Image(systemName: receipt.status.lowercased().contains("waiting") ? "clock" : "checkmark")
          .font(.system(size: 38, weight: .semibold))
          .foregroundStyle(PrismTheme.mintDeep)
      }

      Text(receipt.title)
        .font(PrismTheme.body(18, weight: .semibold))
        .padding(.top, 28)

      AmountText(dollars: receipt.amount, size: 69)
        .padding(.top, 7)

      Text(receipt.subtitle)
        .font(PrismTheme.body(13.5))
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 5)

      PrismStatusPill(text: receipt.status, tone: receipt.status.lowercased().contains("fail") ? .danger : .positive)
        .padding(.top, 16)

      if let expiresLine = receipt.expiresLine {
        Text(expiresLine)
          .font(PrismTheme.body(12.5))
          .foregroundStyle(PrismTheme.muted)
          .padding(.top, 10)
      }

      Spacer()

      if let invite = receipt.shareMessage {
        ShareLink(item: invite) {
          HStack(spacing: 8) {
            Image(systemName: "paperplane.fill").font(.system(size: 13, weight: .semibold))
            Text("Remind them").font(PrismTheme.body(15, weight: .semibold))
          }
          .foregroundStyle(PrismTheme.mintDeep)
          .frame(maxWidth: .infinity)
          .frame(height: 52)
          .background(PrismTheme.mintSoft)
          .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
        }
        .padding(.bottom, 12)
      }

      if receipt.transactionHash != nil {
        VStack(spacing: 0) {
          Button {
            withAnimation(.easeOut(duration: 0.16)) { showNetwork.toggle() }
          } label: {
            HStack {
              Text("Network details")
                .font(PrismTheme.body(13.5, weight: .medium))
              Spacer()
              Image(systemName: showNetwork ? "chevron.up" : "chevron.down")
                .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(PrismTheme.ink)
            .padding(.vertical, 15)
          }
          .buttonStyle(.plain)

          if showNetwork, let hash = receipt.transactionHash {
            Divider().overlay(PrismTheme.line)
            VStack(alignment: .leading, spacing: 8) {
              PrismSectionLabel(text: "Reference")
              Text(hash)
                .font(PrismTheme.mono(10.5))
                .foregroundStyle(PrismTheme.muted)
                .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 15)
          }
        }
        .padding(.horizontal, 16)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
      }

      PrismPrimaryButton(title: "Done", icon: "checkmark") { dismiss() }
        .padding(.top, 18)

      if let opId = receipt.operationId {
        Button("View details") {
          dismiss()
          // Hand off to the canonical detail sheet after the receipt dismiss animation completes.
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            model.presentPaymentDetails = PaymentDetailsPresentation(operationId: opId)
          }
        }
        .font(PrismTheme.body(14, weight: .semibold))
        .foregroundStyle(PrismTheme.mintDeep)
        .padding(.top, 12)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 24)
    .prismScreen()
  }
}
