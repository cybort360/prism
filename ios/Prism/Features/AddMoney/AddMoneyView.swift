import SwiftUI
import UIKit

struct AddMoneyView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var copied = false
  @State private var showQR = false
  @State private var asset: Stablecoin = .ausd

  private var address: String? { model.identity?.accountAddress }
  private var faucetURL: URL? {
    (Bundle.main.object(forInfoDictionaryKey: "PRISM_FAUCET_URL") as? String)
      .flatMap { $0.contains("$(") ? nil : URL(string: $0) }
  }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        PrismTopBar(title: "Add money", back: { dismiss() }).padding(.top, 10)

        Text("Add \(asset.rawValue) to\nyour balance")
          .font(PrismTheme.display(38))
          .tracking(-0.8)
          .padding(.top, 24)

        Text("Send \(asset.rawValue) on Monad to your Prism address. Your balance updates after the transfer confirms.")
          .font(PrismTheme.body(14))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .padding(.top, 12)

        StablecoinPicker(selection: $asset)
          .padding(.top, 18)

        PrismCard(padding: 18) {
          VStack(alignment: .leading, spacing: 16) {
            HStack {
              ZStack {
                Circle().fill(PrismTheme.mintSoft).frame(width: 42, height: 42)
                Text("$").font(PrismTheme.display(20)).foregroundStyle(PrismTheme.mintDeep)
              }
              VStack(alignment: .leading, spacing: 2) {
                Text(asset.rawValue).font(PrismTheme.body(15, weight: .semibold))
                Text(asset.name).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
              }
              Spacer()
              PrismStatusPill(text: "Supported", tone: .positive)
            }

            Divider().overlay(PrismTheme.line)

            PrismSectionLabel(text: "Your deposit address")
            Text(address ?? "Account unavailable")
              .font(PrismTheme.mono(11.5))
              .foregroundStyle(PrismTheme.ink)
              .textSelection(.enabled)
              .accessibilityLabel("Deposit address")

            HStack(spacing: 10) {
              PrismSecondaryButton(title: copied ? "Copied" : "Copy address", icon: copied ? "checkmark" : "doc.on.doc") {
                guard let address else { return }
                UIPasteboard.general.string = address
                withAnimation { copied = true }
                PrismHaptics.success()
                Task { try? await Task.sleep(for: .seconds(1.6)); withAnimation { copied = false } }
              }
              PrismSecondaryButton(title: showQR ? "Hide QR" : "Show QR", icon: "qrcode") {
                withAnimation { showQR.toggle() }
              }
            }

            if showQR, let address {
              QRCodeView(text: address)
                .frame(width: 180, height: 180)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .accessibilityLabel("Deposit address QR code")
            }
          }
        }
        .padding(.top, 22)

        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "checkmark.shield.fill").foregroundStyle(PrismTheme.mintDeep)
          Text("Only AUSD and USDC on Monad are supported. Do not send assets from another network.")
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
        }
        .padding(.top, 16)

        #if DEBUG
          developerFaucet.padding(.top, 22)
        #endif

        Spacer(minLength: 24)

        PrismPrimaryButton(title: "Done", icon: "checkmark") { dismiss() }.padding(.top, 8)
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 22)
    }
    .prismScreen()
  }

  #if DEBUG
    private var developerFaucet: some View {
      VStack(alignment: .leading, spacing: 10) {
        PrismSectionLabel(text: "Developer")
        VStack(alignment: .leading, spacing: 12) {
          Text("Testnet build. Fund this address with testnet \(asset.rawValue), then pull to refresh your balance on Home.")
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
          if let faucetURL {
            PrismSecondaryButton(title: "Open testnet faucet", icon: "drop") { UIApplication.shared.open(faucetURL) }
          } else {
            Text("Set PRISM_FAUCET_URL in the build config to enable a one-tap faucet.")
              .font(PrismTheme.body(11))
              .foregroundStyle(PrismTheme.faint)
          }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
      }
    }
  #endif
}
