import SwiftUI
import UIKit

/// Send to any chain, in any asset.
///
/// The user picks a destination, pastes an address, enters an amount in dollars, and reads a real
/// quote before approving. "Send" and "Spend" are the same flow — paying a person or paying a
/// merchant differ only in framing, so there is one screen and one engine.
///
/// The screen never shows a price it did not get from Aurora, and never enables approval without
/// being able to say why it is enabled: `AuroraRouteDisplay.blockedReason` names every blocker.
struct SendToAnywhereView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var coordinator = PaymentCoordinator()

  @State private var chains: [AuroraChain] = []
  @State private var selectedChain: AuroraChain?
  @State private var selectedAsset: AuroraAsset?
  @State private var destinationAddress = ""
  @State private var amountText = ""
  @State private var route: AuroraRoute?
  @State private var notice: AuroraNotice?

  @State private var loadingChains = true
  @State private var quoting = false
  @State private var showAuth = false
  @State private var errorMessage: String?
  @State private var unavailableReason: String?

  private var display: AuroraRouteDisplay? { route.map { AuroraRouteDisplay($0) } }
  private var amountAtomic: String? { Money.atomic(fromDollars: amountText) }

  private var canQuote: Bool {
    selectedChain != nil && selectedAsset != nil && !destinationAddress.trimmed.isEmpty && amountAtomic != nil && !quoting
  }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 18) {
        PrismTopBar(title: "Send anywhere", back: { dismiss() }).padding(.top, 10)

        if let unavailableReason {
          infoCard(unavailableReason)
        } else {
          if let notice { noticeBanner(notice) }
          if let errorMessage { ErrorBanner(message: errorMessage) }

          destinationPicker
          if selectedChain != nil { assetPicker }
          addressField
          amountField

          if quoting {
            PrismLoadingRow()
          } else if let display {
            quoteCard(display)
          }

          if canQuote && route == nil && !quoting {
            PrismSecondaryButton(title: "Get a quote", icon: "arrow.left.arrow.right") {
              Task { await requestQuote() }
            }
          }
        }
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 28)
    }
    .prismScreen()
    .overlay(OperationStateOverlay(
      state: coordinator.state,
      onDismiss: { coordinator.reset() },
      onViewActivity: { dismiss(); model.selectedTab = .activity }))
    .sheet(isPresented: $showAuth) {
      PaymentAuthorizationSheet(amount: amountText) { pin, useFaceID in
        Task { await approve(pin: pin, useFaceID: useFaceID) }
      }
    }
    .task { await loadChains() }
  }

  // MARK: inputs

  private var destinationPicker: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "Sending to")
      if loadingChains {
        PrismLoadingRow()
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
          ForEach(chains) { chain in
            chip(chain.label, selected: selectedChain?.chain == chain.chain) {
              selectedChain = chain
              // Default to the chain's stablecoin when it has one — the least surprising choice for
              // a payments app — otherwise leave the pick to the user.
              selectedAsset = chain.assets.first { $0.symbol == "USDC" } ?? chain.assets.first
              invalidateQuote()
            }
          }
        }
      }
    }
  }

  private var assetPicker: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "They receive")
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 88), spacing: 8)], spacing: 8) {
        ForEach(selectedChain?.assets ?? []) { asset in
          chip(asset.symbol, selected: selectedAsset?.assetId == asset.assetId) {
            selectedAsset = asset
            invalidateQuote()
          }
        }
      }
    }
  }

  private var addressField: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "Their \(selectedChain?.label ?? "wallet") address")
      HStack(spacing: 8) {
        TextField("Paste address", text: $destinationAddress)
          .font(PrismTheme.mono(12))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .onChange(of: destinationAddress) { _, _ in invalidateQuote() }
        Button {
          destinationAddress = UIPasteboard.general.string ?? destinationAddress
          PrismHaptics.tap()
          invalidateQuote()
        } label: {
          Image(systemName: "doc.on.clipboard")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PrismTheme.muted)
        }
        .buttonStyle(.plain)
      }
      .padding(14)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
    }
  }

  private var amountField: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "You send")
      TextField("$0.00", text: $amountText)
        .font(PrismTheme.display(30))
        .keyboardType(.decimalPad)
        .onChange(of: amountText) { _, _ in invalidateQuote() }
        .padding(14)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
    }
  }

  // MARK: the quote

  private func quoteCard(_ display: AuroraRouteDisplay) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      PrismCard(padding: 18) {
        VStack(alignment: .leading, spacing: 14) {
          row("You send", display.youSend)
          // The floor, not the forecast: this is the number the approval is bound to.
          if let receive = display.theyReceiveLine { row("They receive", receive) }
          if let arrival = display.estimatedArrival { row("Arrives in", arrival) }
          row("To", display.shortDestinationAddress, mono: true)

          if let caution = display.addressCaution {
            Text(caution)
              .font(PrismTheme.body(12))
              .foregroundStyle(PrismTheme.amber)
              .fixedSize(horizontal: false, vertical: true)
          }

          if let seconds = display.secondsUntilExpiry, !display.isExpired {
            Text("This price holds for about \(max(1, seconds / 60)) more minute\(seconds >= 120 ? "s" : "").")
              .font(PrismTheme.body(11.5))
              .foregroundStyle(PrismTheme.faint)
          }
        }
      }

      if let blocked = display.blockedReason {
        infoCard(blocked)
        PrismSecondaryButton(title: "Get a new quote", icon: "arrow.clockwise") {
          Task { await requestQuote() }
        }
      } else {
        PrismPrimaryButton(title: "Review & send", icon: "arrow.up.right") { showAuth = true }
      }
    }
  }

  private func row(_ label: String, _ value: String, mono: Bool = false) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label)
        .font(PrismTheme.body(13))
        .foregroundStyle(PrismTheme.muted)
      Spacer()
      Text(value)
        .font(mono ? PrismTheme.mono(12) : PrismTheme.body(14, weight: .semibold))
        .foregroundStyle(PrismTheme.ink)
        .multilineTextAlignment(.trailing)
    }
  }

  // MARK: chrome

  private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(label)
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
    .accessibilityAddTraits(selected ? [.isSelected] : [])
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

  private func infoCard(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "info.circle").foregroundStyle(PrismTheme.muted)
      Text(message)
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

  /// Any input change makes the shown price stale, so it is discarded rather than left on screen
  /// next to inputs it no longer describes.
  private func invalidateQuote() {
    route = nil
    errorMessage = nil
  }

  private func loadChains() async {
    loadingChains = true
    defer { loadingChains = false }
    do {
      let response = try await PrismAPI.shared.auroraChains()
      chains = response.chains
        .filter(\.known)
        .filter { $0.chain != response.destinationChain }
      notice = response.notice
    } catch {
      unavailableReason = (error as? APIError)?.errorDescription
        ?? "Sending to another network isn't available in this build."
    }
  }

  private func requestQuote() async {
    guard let chain = selectedChain, let asset = selectedAsset, let amount = amountAtomic else { return }
    quoting = true
    errorMessage = nil
    defer { quoting = false }
    do {
      route = try await PrismAPI.shared.quoteAuroraSend(
        destinationChain: chain.chain,
        destinationAsset: asset.assetId,
        destinationAddress: destinationAddress.trimmed,
        amountAtomic: amount,
        contractAddress: asset.contractAddress)
    } catch {
      errorMessage = (error as? APIError)?.errorDescription ?? "Couldn't price this route."
    }
  }

  private func approve(pin: String?, useFaceID: Bool) async {
    guard let routeId = route?.routeId else { return }
    showAuth = false
    await coordinator.sendCrossChain(routeId: routeId, pin: pin, useFaceID: useFaceID)

    switch coordinator.state {
    case .sent:
      // The Monad leg is confirmed; the routed leg is still in flight. Refresh so the screen shows
      // the route's real state rather than implying delivery.
      if let refreshed = try? await PrismAPI.shared.auroraRouteStatus(routeId) { route = refreshed.route }
    case .failed(let message):
      errorMessage = message
      // The quote may have expired while the sheet was open; re-read so the reason is accurate.
      if let refreshed = try? await PrismAPI.shared.auroraRouteStatus(routeId) { route = refreshed.route }
    default:
      break
    }
  }
}

private extension String {
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
