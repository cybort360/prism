import SwiftUI
import UIKit

struct AddMoneyView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var copied = false
  @State private var showQR = false
  /// Money enters Prism two ways: a direct USDC transfer on Monad, or a routed deposit from any
  /// other chain. Same question, so they live on one screen rather than two.
  @State private var origin: Origin = .monad
  // Normal users never see a blockchain. The crypto deposit flow (addresses, chains, QR) is an
  // advanced surface, off by default; the everyday "Add money" is a fiat on-ramp (coming soon).
  @AppStorage("feature.addMoneyDeposit") private var depositEnabled = false
  // Cross-chain deposit ("Another network") is gated by the same switch that governs cross-chain send.
  @AppStorage("feature.crossChainSend") private var crossChainEnabled = false

  private enum Origin: String, CaseIterable, Identifiable {
    case monad = "Monad"
    case anyChain = "Another network"
    var id: String { rawValue }
  }

  private var address: String? { model.identity?.accountAddress }
  private var faucetURL: URL? {
    (Bundle.main.object(forInfoDictionaryKey: "PRISM_FAUCET_URL") as? String)
      .flatMap { $0.contains("$(") ? nil : URL(string: $0) }
  }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        PrismTopBar(title: "Add money", back: { dismiss() }).padding(.top, 10)

        if depositEnabled {
          depositFlow
        } else {
          onRampComingSoon
        }

        Spacer(minLength: 24)

        PrismPrimaryButton(title: "Done", icon: "checkmark") { dismiss() }.padding(.top, 8)
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 22)
    }
    .prismScreen()
  }

  // The everyday experience: add money with money, no blockchain in sight. The real card/bank on-ramp
  // lands later; until then this is honest about what's coming rather than exposing a deposit address.
  private var onRampComingSoon: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Add money to\nyour balance")
        .font(PrismTheme.display(38))
        .tracking(-0.8)
        .padding(.top, 24)

      Text("Top up from your card or bank in a few taps. Coming soon.")
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .padding(.top, 12)

      PrismCard(padding: 20) {
        HStack(spacing: 14) {
          ZStack {
            Circle().fill(PrismTheme.mintSoft).frame(width: 46, height: 46)
            Image(systemName: "creditcard").font(.system(size: 19, weight: .medium)).foregroundStyle(PrismTheme.mintDeep)
          }
          VStack(alignment: .leading, spacing: 3) {
            Text("Buy with card or bank").font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.ink)
            Text("Instant top-ups, coming soon").font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
          }
          Spacer(minLength: 6)
          PrismStatusPill(text: "Coming soon", tone: .neutral)
        }
      }
      .padding(.top, 24)
    }
  }

  @ViewBuilder private var depositFlow: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Add USDC to\nyour balance")
        .font(PrismTheme.display(38))
        .tracking(-0.8)
        .padding(.top, 24)

      Text(crossChainEnabled
        ? "Top up from Monad directly, or send from another network and Prism converts it for you. Your balance updates after the transfer confirms."
        : "Send USDC on Monad to the address below. Your balance updates after the transfer confirms.")
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .padding(.top, 12)

      if crossChainEnabled {
        Picker("Where the money is coming from", selection: $origin) {
          ForEach(Origin.allCases) { option in Text(option.rawValue).tag(option) }
        }
        .pickerStyle(.segmented)
        .padding(.top, 18)
      }

      if crossChainEnabled && origin == .anyChain {
        AuroraDepositSection().padding(.top, 22)
      } else {
        PrismCard(padding: 18) {
            VStack(alignment: .leading, spacing: 16) {
              HStack {
                ZStack {
                  Circle().fill(PrismTheme.mintSoft).frame(width: 42, height: 42)
                  Text("$").font(PrismTheme.display(20)).foregroundStyle(PrismTheme.mintDeep)
                }
                VStack(alignment: .leading, spacing: 2) {
                  Text("USDC").font(PrismTheme.body(15, weight: .semibold))
                  Text("USD Coin").font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
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
            Text("This address only accepts USDC on Monad. To send from another network, switch to Another network above.")
              .font(PrismTheme.body(12.5))
              .foregroundStyle(PrismTheme.muted)
          }
          .padding(.top, 16)
        }

        #if DEBUG
          developerFaucet.padding(.top, 22)
        #endif
      }
    }

  #if DEBUG
    private var developerFaucet: some View {
      VStack(alignment: .leading, spacing: 10) {
        PrismSectionLabel(text: "Developer")
        VStack(alignment: .leading, spacing: 12) {
          Text("Testnet build. Fund this address with testnet USDC, then pull to refresh your balance on Home.")
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
