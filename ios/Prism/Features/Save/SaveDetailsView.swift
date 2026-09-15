import SwiftUI

/// Save → How it works. The primary view stays in plain money terms (your Prism balance is USDC; your
/// savings are yield-bearing dollars). This is the ONE place the substrate becomes visible, behind an
/// explicit "Advanced details" disclosure — never on the primary screens.
struct SaveDetailsView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var showAdvanced = false

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text("How it works").font(PrismTheme.display(31)).tracking(-0.5)
          Spacer()
          PrismHeaderIconButton(icon: "xmark") { dismiss() }
        }
        .padding(.top, 10)

        PrismCard {
          VStack(alignment: .leading, spacing: 0) {
            plainRow("Your Prism balance", "USDC", "The dollars you spend and send.")
            Divider().overlay(PrismTheme.line).padding(.vertical, 14)
            plainRow("Savings", "Yield-bearing dollars", "The dollars you've set aside to earn a variable return.")
          }
        }.padding(.top, 22)

        Text("Saving converts dollars from your Prism balance into a savings position that earns a variable rate, and converts them back to your balance when you withdraw.")
          .font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted).lineSpacing(3).padding(.top, 18)

        // Advanced disclosure — the substrate lives here and only here.
        VStack(alignment: .leading, spacing: 0) {
          Button { withAnimation(.easeOut(duration: 0.18)) { showAdvanced.toggle() } } label: {
            HStack {
              Text("Advanced details").font(PrismTheme.body(13.5, weight: .semibold)).foregroundStyle(PrismTheme.muted)
              Spacer()
              Image(systemName: showAdvanced ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(PrismTheme.faint)
            }
          }.buttonStyle(.plain)

          if showAdvanced {
            VStack(alignment: .leading, spacing: 0) {
              techRow("Savings asset", "AUSD")
              techRow("Position", "earnAUSD")
              techRow("Vault", "Upshift earnAUSD")
              techRow("Curator", "Gamma Research")
              techRow("Network", "Monad", last: true)
            }
            .padding(.top, 12)
            .transition(.opacity)
          }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PrismTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(PrismTheme.line, lineWidth: 0.6))
        .padding(.top, 20)

        Text("Rates are variable, and savings involve stablecoin, smart-contract and underlying strategy risk. Not a bank deposit; not insured or guaranteed.")
          .font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted).lineSpacing(2).padding(.top, 18)
      }
      .padding(.horizontal, 24).padding(.bottom, 24)
    }
    .prismScreen()
  }

  private func plainRow(_ title: String, _ value: String, _ detail: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(title).font(PrismTheme.body(14.5, weight: .semibold)).foregroundStyle(PrismTheme.ink)
        Spacer()
        Text(value).font(PrismTheme.body(13, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
      }
      Text(detail).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted).lineSpacing(1.5)
    }
    .accessibilityElement(children: .combine)
  }
  private func techRow(_ label: String, _ value: String, last: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack {
        Text(label).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
        Spacer()
        Text(value).font(PrismTheme.mono(11.5)).foregroundStyle(PrismTheme.ink)
      }.padding(.vertical, 9)
      if !last { Divider().overlay(PrismTheme.line) }
    }
    .accessibilityElement(children: .combine)
  }
}
