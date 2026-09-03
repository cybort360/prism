import SwiftUI

struct ReceiveView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Receive")
          .font(PrismTheme.display(36))
          .tracking(-0.7)
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      .padding(.top, 10)

      Spacer()

      PrismCard(padding: 18) {
        QRCodeView(text: paymentURL)
          .frame(width: 210, height: 210)
          .padding(4)
      }

      Text(model.identity?.handle ?? "Your Prism")
        .font(PrismTheme.display(30))
        .tracking(-0.5)
        .padding(.top, 28)

      Text("Scan to pay this Prism account without sharing your account details.")
        .font(PrismTheme.body(13.5))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(.horizontal, 38)
        .padding(.top, 9)

      Text(paymentURL)
        .font(PrismTheme.mono(10.5))
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 15)
        .textSelection(.enabled)

      Spacer()

      ShareLink(item: paymentURL) {
        Label("Share payment link", systemImage: "square.and.arrow.up")
          .font(PrismTheme.body(14.5, weight: .semibold))
          .frame(maxWidth: .infinity)
          .frame(height: 54)
      }
      .buttonStyle(.plain)
      .foregroundStyle(PrismTheme.ink)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 22)
    .prismScreen()
  }

  private var paymentURL: String {
    "prism://pay/\(model.identity?.prismId ?? "")"
  }
}
