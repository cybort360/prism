import SwiftUI

/// Prism Save — withdrawal. Saving isn't complete until money returns to spendable USDC:
/// earnAUSD → AUSD → USDC → the user's normal balance. The consumer picks Instant or Standard; a normal
/// user is never left holding AUSD unless they intentionally choose an advanced option.
///
/// Preview status: the earnAUSD withdrawal ABI is unverified and mainnet-only, so both modes report
/// unavailable and the flow lands on an honest terminal — no fabricated fee, no invented "free", and the
/// no-stranded-funds recovery state is modeled for when it goes live.
struct WithdrawView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss

  @State private var amount = ""
  @State private var quote: WithdrawQuote?
  @State private var savingsAtomic: String?
  @State private var loading = true
  @State private var error: String?
  @State private var terminal: WithdrawTerminal?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Withdraw", back: { dismiss() }).padding(.horizontal, 22).padding(.top, 10)
        ScrollView(showsIndicators: false) {
          VStack(alignment: .leading, spacing: 0) {
            Spacer().frame(height: 14)
            if let savingsAtomic {
              PrismCard(padding: 14) {
                HStack {
                  VStack(alignment: .leading, spacing: 2) {
                    Text("Current savings").font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted)
                    Text(Money.dollars(fromAtomic: savingsAtomic)).font(PrismTheme.body(18, weight: .semibold)).monospacedDigit()
                  }
                  Spacer()
                }
              }
              .accessibilityElement(children: .combine)
              .padding(.bottom, 18)
            }
            PrismSectionLabel(text: "Amount to withdraw")
            AmountText(dollars: displayAmount, size: 60).padding(.top, 6)
            Text("Returns to your USDC balance").font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted).padding(.top, 8)

            if let error { ErrorBanner(message: error).padding(.top, 14) }

            if loading {
              ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
            } else if let quote {
              instantCard(quote).padding(.top, 20)
              standardCard(quote).padding(.top, 12)
              if !quote.live, let reason = quote.notLiveReason {
                Text(reason).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
                  .lineSpacing(2).padding(.top, 14)
              }
            }
            MoneyKeypad(value: $amount).padding(.top, 20)
          }
          .padding(.horizontal, 22).padding(.bottom, 28)
        }
      }
      .prismScreen()
      if let terminal { WithdrawTerminalView(terminal: terminal) { dismiss() } }
    }
    .task { await load() }
  }

  // MARK: mode cards

  private func instantCard(_ q: WithdrawQuote) -> some View {
    modeCard(
      title: "Instant", tag: q.modes.instant.available ? "Available now" : nil,
      available: q.modes.instant.available, reason: q.modes.instant.reason,
      rows: [
        ("Estimated USDC", q.modes.instant.estimatedUSDCAtomic.map(usd)),
        // Fee shown only when observed — never "free" unless the vault says so.
        ("Vault fee", q.modes.instant.vaultFeeAtomic.map(usd) ?? (q.modes.instant.available ? "—" : nil)),
        ("Conversion cost", q.modes.instant.conversionCostAtomic.map(usd) ?? (q.modes.instant.available ? "—" : nil))
      ],
      cta: "Withdraw now"
    ) { Task { await choose(.instant) } }
  }

  private func standardCard(_ q: WithdrawQuote) -> some View {
    modeCard(
      title: "Standard", tag: nil, available: q.modes.standard.available, reason: q.modes.standard.reason,
      rows: [
        ("Expected processing", q.modes.standard.processingWindow ?? (q.modes.standard.available ? "Up to 72 hours" : nil)),
        ("Estimated USDC", q.modes.standard.estimatedUSDCAtomic.map(usd))
      ],
      cta: "Request withdrawal"
    ) { Task { await choose(.standard) } }
  }

  private func modeCard(title: String, tag: String?, available: Bool, reason: String?, rows: [(String, String?)], cta: String, action: @escaping () -> Void) -> some View {
    PrismCard {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text(title).font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.ink)
          if let tag { Text(tag).font(PrismTheme.body(10, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
              .padding(.horizontal, 8).padding(.vertical, 3).background(PrismTheme.mintSoft).clipShape(Capsule()) }
          Spacer()
        }
        if available {
          ForEach(rows.filter { $0.1 != nil }, id: \.0) { row in
            HStack { Text(row.0).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted); Spacer(); Text(row.1 ?? "").font(PrismTheme.body(12.5, weight: .semibold)) }
          }
          PrismPrimaryButton(title: cta, enabled: atomic != nil, icon: "arrow.down.circle") { action() }.padding(.top, 2)
        } else {
          Text(reason ?? "Not available on this deployment").font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted).lineSpacing(2)
        }
      }
    }
  }

  // MARK: logic

  private var atomic: String? { guard let a = Money.atomic(fromDollars: amount), a != "0" else { return nil }; return a }
  private var displayAmount: String {
    amount.isEmpty ? "$0.00" : (Decimal(string: amount) ?? 0).formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }
  private func usd(_ atomic: String) -> String { Money.dollars(fromAtomic: atomic) }

  private func load() async {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--uitest-save-demo") {
      savingsAtomic = "1508420000"
      quote = WithdrawQuote(quoteId: "demo", live: false, notLiveReason: nil, returnsTo: "USDC",
        modes: WithdrawModes(live: false, sharesAtomic: "0",
          instant: WithdrawModeInstant(available: true, estimatedUSDCAtomic: "199000000", vaultFeeAtomic: "500000", conversionCostAtomic: "500000", note: "Available now"),
          standard: WithdrawModeStandard(available: true, estimatedUSDCAtomic: "199500000", processingWindow: "Up to 72 hours")))
      loading = false
      return
    }
    #endif
    // The share amount to quote would come from the position; in preview the vault is unreadable, so we
    // quote with the entered amount's atomic (illustrative) and both modes return unavailable.
    async let q = try? await PrismAPI.shared.withdrawQuote(sharesAtomic: atomic ?? "0")
    async let pos = try? await PrismAPI.shared.savePosition()
    quote = await q
    if savingsAtomic == nil { savingsAtomic = (await pos)?.currentAUSDValue }
    if quote == nil { error = "Couldn't load withdrawal options." }
    loading = false
  }

  private func choose(_ mode: WithdrawMode) async {
    // A live path would build + sign a WithdrawIntent (verified by WithdrawIntentGuard) and reconcile from
    // evidence. Today the substrate isn't connected, so we land on an honest preview terminal.
    guard let quote else { return }
    PrismHaptics.warning()
    terminal = .preview(reason: quote.notLiveReason ?? "Withdrawals go live once earnAUSD is connected.")
  }

  enum WithdrawMode { case instant, standard }
}

enum WithdrawTerminal: Equatable {
  case available(amount: String)                  // USDC back in the user's balance (instant success)
  case preview(reason: String)
  case requested(amount: String)                  // queued
  case recovery(ausd: String)                     // AUSD safe with the user, USDC conversion pending
}

/// Terminal states. The recovery state is the critical one: if AUSD was withdrawn but the AUSD→USDC
/// conversion couldn't finish, we NEVER say failed and NEVER strand funds.
private struct WithdrawTerminalView: View {
  let terminal: WithdrawTerminal
  let done: () -> Void

  var body: some View {
    ZStack {
      Color.black.opacity(0.22).ignoresSafeArea()
      VStack(spacing: 15) {
        icon
        Text(title).font(PrismTheme.display(23)).multilineTextAlignment(.center)
        Text(message).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted).multilineTextAlignment(.center).lineSpacing(2).padding(.horizontal, 6)
        Button { done() } label: {
          Text(cta).font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
            .frame(maxWidth: .infinity).frame(height: 50).background(PrismTheme.mintSoft).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }.buttonStyle(.plain).padding(.top, 4)
      }
      .padding(.horizontal, 26).padding(.vertical, 28).frame(maxWidth: 330)
      .background(PrismTheme.paper).clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous)).prismCardShadow()
    }
    .transition(.opacity)
  }

  private var icon: some View {
    let (symbol, tint): (String, Color) = {
      switch terminal {
      case .available: return ("checkmark", PrismTheme.mintDeep)
      case .recovery: return ("shield.fill", PrismTheme.amber)
      case .requested: return ("clock.badge.checkmark", PrismTheme.amber)
      case .preview: return ("clock.badge.checkmark", PrismTheme.amber)
      }
    }()
    return ZStack { Circle().fill(tint.opacity(0.12)).frame(width: 72, height: 72); Image(systemName: symbol).font(.system(size: 26, weight: .medium)).foregroundStyle(tint) }
  }
  private var title: String {
    switch terminal {
    case .available(let amount): return "\(amount) available"
    case .preview: return "Withdrawals are almost ready"
    case .requested: return "Withdrawal requested"
    case .recovery: return "Your savings were withdrawn"
    }
  }
  private var message: String {
    switch terminal {
    case .available: return "Your withdrawal is back in your Prism balance."
    case .preview(let reason): return "This is a preview — \(reason)"
    case .requested(let amount): return "\(amount) is on the way to your USDC balance. Processing can take up to 72 hours; we'll tell you when it's ready."
    case .recovery(let ausd): return "\(ausd) AUSD is safe in your Prism account. We're having trouble converting it to your available USDC balance."
    }
  }
  private var cta: String {
    switch terminal {
    case .recovery: return "Try conversion again"
    default: return "Got it"
    }
  }
}
