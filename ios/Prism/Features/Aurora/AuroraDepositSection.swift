import SwiftUI
import UIKit

/// The "from another network" half of Add money.
///
/// The user picks where the money is coming from; Prism hands back a permanent address for that
/// chain, and anything sent to it arrives as USDC in their Prism balance. There is nothing to sign
/// and nothing to approve — the address is derived from their own account — so this is a picker and
/// an address, not a transaction flow.
///
/// A section rather than a screen: it lives inside `AddMoneyView` next to the native Monad address,
/// because both answer the same question and splitting them across two screens would make the user
/// choose a surface before they know which one they need.
struct AuroraDepositSection: View {
  @State private var chains: [AuroraChain] = []
  @State private var selectedChain: String?
  @State private var deposit: AuroraDeposit?
  @State private var notice: AuroraNotice?
  @State private var loadingChains = true
  @State private var generating = false
  @State private var unavailableReason: String?
  @State private var errorMessage: String?
  @State private var copied = false
  @State private var arrivals: AuroraArrivalsDisplay?

  private var display: AuroraDepositDisplay? { deposit.map(AuroraDepositDisplay.init) }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let unavailableReason {
        // Cross-chain isn't configured for this build. Say that plainly instead of showing a picker
        // that cannot produce an address.
        unavailableCard(unavailableReason)
      } else {
        if let notice { noticeBanner(notice) }
        if let errorMessage { ErrorBanner(message: errorMessage) }

        chainPicker

        if generating {
          PrismLoadingRow()
        } else if let display {
          addressCard(display)
          timeline(display)
        }

        if let arrivals { arrivalsList(arrivals) }
      }
    }
    .task {
      await loadChains()
      await loadArrivals()
    }
  }

  // MARK: sections

  private var chainPicker: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "Sending from")

      if loadingChains {
        PrismLoadingRow()
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
          ForEach(chains) { chain in
            let selected = selectedChain == chain.chain
            Button {
              Task { await select(chain) }
            } label: {
              Text(chain.label)
                .font(PrismTheme.body(13, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? PrismTheme.mintDeep : PrismTheme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .frame(height: 42)
                .background(selected ? PrismTheme.mintSoft : PrismTheme.paper)
                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(selected ? PrismTheme.mint : PrismTheme.line, lineWidth: 0.7))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Send from \(chain.label)")
            .accessibilityAddTraits(selected ? [.isSelected] : [])
          }
        }
      }
    }
  }

  private func addressCard(_ display: AuroraDepositDisplay) -> some View {
    PrismCard(padding: 18) {
      VStack(alignment: .leading, spacing: 14) {
        HStack {
          PrismSectionLabel(text: "\(display.chainLabel) deposit address")
          Spacer()
          PrismStatusPill(text: display.statusLabel, tone: display.statusTone)
        }

        Text(display.address)
          .font(PrismTheme.mono(11.5))
          .foregroundStyle(PrismTheme.ink)
          .textSelection(.enabled)
          .accessibilityLabel("\(display.chainLabel) deposit address")

        // Some chains drop a deposit that arrives without its memo, and that is unrecoverable. It
        // is presented as a requirement, not a footnote.
        if let memo = display.memoRequirement {
          VStack(alignment: .leading, spacing: 4) {
            Text("Include this memo — a deposit without it cannot be recovered")
              .font(PrismTheme.body(12, weight: .semibold))
              .foregroundStyle(PrismTheme.amber)
            Text(memo)
              .font(PrismTheme.mono(12))
              .textSelection(.enabled)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .background(PrismTheme.sand)
          .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }

        HStack(spacing: 10) {
          PrismSecondaryButton(title: copied ? "Copied" : "Copy address", icon: copied ? "checkmark" : "doc.on.doc") {
            UIPasteboard.general.string = display.address
            withAnimation { copied = true }
            PrismHaptics.success()
            Task { try? await Task.sleep(for: .seconds(1.6)); withAnimation { copied = false } }
          }
          PrismSecondaryButton(title: "Refresh", icon: "arrow.clockwise") {
            Task { await refresh() }
          }
        }

        QRCodeView(text: display.address)
          .frame(width: 170, height: 170)
          .frame(maxWidth: .infinity)
          .accessibilityLabel("\(display.chainLabel) deposit address QR code")

        Text(display.explanation)
          .font(PrismTheme.body(12.5))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func timeline(_ display: AuroraDepositDisplay) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "Progress")
      VStack(alignment: .leading, spacing: 12) {
        ForEach(display.timeline) { step in
          HStack(spacing: 10) {
            Circle()
              .fill(step.reached ? PrismTheme.mint : PrismTheme.line)
              .frame(width: 8, height: 8)
            Text(step.title)
              .font(PrismTheme.body(13.5, weight: step.reached ? .semibold : .regular))
              .foregroundStyle(step.reached ? PrismTheme.ink : PrismTheme.faint)
            Spacer()
          }
        }
      }
      .padding(15)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
    }
  }

  /// What has actually landed in the account, from the activity index. Shown regardless of which
  /// chain is selected: money that arrived is money that arrived, whatever route brought it.
  private func arrivalsList(_ display: AuroraArrivalsDisplay) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "Recent arrivals")
      VStack(alignment: .leading, spacing: 12) {
        if let empty = display.emptyMessage {
          Text(empty)
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
            .fixedSize(horizontal: false, vertical: true)
        } else {
          ForEach(display.arrivals) { arrival in
            HStack {
              Text(display.amountLabel(arrival))
                .font(PrismTheme.body(14, weight: .semibold))
              Spacer()
              Text(arrival.symbol)
                .font(PrismTheme.body(12))
                .foregroundStyle(PrismTheme.muted)
            }
          }
        }
      }
      .padding(15)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
    }
  }

  private func noticeBanner(_ notice: AuroraNotice) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(notice.headline)
        .font(PrismTheme.body(13, weight: .semibold))
        .foregroundStyle(PrismTheme.amber)
      Text(notice.detail)
        .font(PrismTheme.body(12.5))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .background(PrismTheme.sand)
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
  }

  private func unavailableCard(_ reason: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "info.circle").foregroundStyle(PrismTheme.muted)
      Text(reason)
        .font(PrismTheme.body(12.5))
        .foregroundStyle(PrismTheme.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
  }

  // MARK: actions

  private func loadChains() async {
    loadingChains = true
    defer { loadingChains = false }
    do {
      let response = try await PrismAPI.shared.auroraChains()
      // Only chains this build has vocabulary for. An unknown slug has no label and no address
      // validation, so offering it would be offering something Prism cannot check.
      chains = response.chains.filter(\.known).filter { $0.chain != response.destinationChain }
      notice = response.notice
    } catch {
      unavailableReason = (error as? APIError)?.errorDescription
        ?? "Adding money from another network isn't available in this build."
    }
  }

  private func loadArrivals() async {
    // A failure here is not worth an error banner: the balance on Home is read from the chain and is
    // unaffected by whether this list can be built.
    guard let response = try? await PrismAPI.shared.auroraArrivals() else { return }
    arrivals = AuroraArrivalsDisplay(response)
  }

  private func select(_ chain: AuroraChain) async {
    guard selectedChain != chain.chain else { return }
    selectedChain = chain.chain
    deposit = nil
    copied = false
    errorMessage = nil
    generating = true
    defer { generating = false }
    do {
      deposit = try await PrismAPI.shared.createAuroraDepositAddress(depositChain: chain.chain)
      PrismHaptics.success()
    } catch {
      errorMessage = (error as? APIError)?.errorDescription ?? "Couldn't get an address for \(chain.label)."
      selectedChain = nil
    }
  }

  private func refresh() async {
    guard let address = deposit?.depositAddress else { return }
    do {
      deposit = try await PrismAPI.shared.refreshAuroraDeposit(address: address)
      await loadArrivals()
    } catch {
      errorMessage = (error as? APIError)?.errorDescription ?? "Couldn't refresh."
    }
  }
}
