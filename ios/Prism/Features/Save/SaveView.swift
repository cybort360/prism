import SwiftUI

/// Prism Save — the native experience. Not a DeFi app: the primary screens never mention AUSD, earnAUSD,
/// vaults, or protocols — that substrate lives only in Details. Everything is driven by `SaveDisplay`, so
/// a number is shown only when it is actually known (APY only when fresh; earned only with a cost basis).
///
/// Preview status: the earnAUSD substrate isn't connected on this deployment, so a real position can't be
/// read and the flow lands on an honest terminal. A DEBUG example lets the experience be reviewed.
struct SaveView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var display: SaveDisplay?
  @State private var state: SaveState?
  @State private var balanceAtomic: String?
  @State private var loading = true
  @State private var path: [Step] = []
  @State private var showDisclosure = false
  @State private var showAuth = false
  @State private var pendingAmount = ""
  @State private var terminal: SaveTerminal?

  enum Step: Hashable { case amount, review(String) }

  var body: some View {
    NavigationStack(path: $path) {
      root
        .navigationDestination(for: Step.self) { step in
          switch step {
          case .amount: amountScreen
          case .review(let a): reviewScreen(amountDollars: a)
          }
        }
    }
    .task { await load() }
    .overlay { if let terminal { SaveSuccessTerminal(terminal: terminal) { dismiss() } } }
  }

  // MARK: root — first entry vs save home

  @ViewBuilder private var root: some View {
    Group {
      if loading {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel("Loading your savings")
      } else if let d = display, d.hasPosition {
        SaveHomeContent(display: d, onSaveMore: { path.append(.amount) }, onWithdraw: { openWithdraw() })
      } else if let d = display {
        SaveFirstEntry(display: d, onStart: { path.append(.amount) })
      }
    }
    .prismScreen()
    .toolbar { ToolbarItem(placement: .topBarTrailing) { PrismHeaderIconButton(icon: "xmark") { dismiss() } } }
  }

  // MARK: amount

  private var amountScreen: some View {
    VStack(spacing: 0) {
      Spacer().frame(height: 6)
      if state?.demo == true { demoBanner.padding(.horizontal, 24).padding(.bottom, 14) }
      Text("How much do you want to save?")
        .font(PrismTheme.display(28)).tracking(-0.4).multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 24)
      availableLine.padding(.top, 16)
      AmountText(dollars: displayAmount, size: 68).padding(.top, 14)
      quickChips.padding(.top, 20)
      if overBalance { Text("That's more than you have available").font(PrismTheme.body(12)).foregroundStyle(PrismTheme.danger).padding(.top, 10) }
      MoneyKeypad(value: $pendingAmount).padding(.horizontal, 30).padding(.top, 16)
      Spacer()
      PrismPrimaryButton(title: "Continue", enabled: atomic != nil && !overBalance) {
        path.append(.review(displayAmount))
      }.padding(24)
    }
    .prismScreen().navigationTitle("").navigationBarTitleDisplayMode(.inline)
  }

  private var demoBanner: some View {
    HStack(spacing: 8) {
      Image(systemName: "flask.fill").foregroundStyle(PrismTheme.mintDeep)
      Text("Demo — simulated yield on testnet, not real earnAUSD")
        .font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var availableLine: some View {
    Group {
      if let balanceAtomic {
        Text("Available  \(Money.dollars(fromAtomic: balanceAtomic))")
          .font(PrismTheme.body(12.5, weight: .semibold)).foregroundStyle(PrismTheme.muted)
          .accessibilityLabel("Available to save, \(Money.dollars(fromAtomic: balanceAtomic))")
      } else {
        Text("From your Prism balance").font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      }
    }
  }

  private var quickChips: some View {
    HStack(spacing: 9) {
      ForEach(["100", "250", "500"], id: \.self) { v in chip("$\(v)") { pendingAmount = v } }
      chip("Max") { if let balanceAtomic { pendingAmount = wholeDollars(balanceAtomic) } }
    }
    .padding(.horizontal, 24)
  }
  private func chip(_ label: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(label).font(PrismTheme.body(13, weight: .semibold)).foregroundStyle(PrismTheme.ink)
        .frame(maxWidth: .infinity).frame(height: 40)
        .background(PrismTheme.paper).clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 13).stroke(PrismTheme.line, lineWidth: 0.7))
    }.buttonStyle(.plain)
  }

  // MARK: review

  private func reviewScreen(amountDollars: String) -> some View {
    let d = display ?? SaveDisplay(position: nil, stateRate: nil)
    return ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        Text("Save \(amountDollars)").font(PrismTheme.display(31)).tracking(-0.5).padding(.top, 8)
        PrismCard {
          VStack(spacing: 0) {
            reviewRow("From", "Prism balance")
            reviewRow("Estimated amount saved", estimatedInvested)
            reviewRow("Current rate", d.rateText ?? "Set when Save connects")
            reviewRow("Estimated monthly earnings", monthlyEstimate(d) ?? "-", subtle: true)
            reviewRow("Conversion cost", conversionCost)
            reviewRow("Rate", "Variable", last: true)
          }
        }.padding(.top, 20)
        Text("Based on the current variable APY. Actual returns can change.")
          .font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted).lineSpacing(2).padding(.top, 12).padding(.horizontal, 4)
        Spacer(minLength: 26)
        PrismPrimaryButton(title: "Save \(amountDollars)", icon: "lock.fill") { beginSave() }
      }.padding(.horizontal, 24).padding(.bottom, 16)
    }
    .prismScreen().navigationTitle("").navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $showDisclosure) { FirstSaveDisclosure { showDisclosure = false; showAuth = true } }
    .sheet(isPresented: $showAuth) { PaymentAuthorizationSheet(amount: amountDollars) { pin, face in Task { await confirm(pin: pin, face: face, amountDollars: amountDollars) } } }
  }

  private func reviewRow(_ label: String, _ value: String, subtle: Bool = false, last: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack {
        Text(label).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted)
        Spacer()
        Text(value).font(PrismTheme.body(14, weight: .semibold)).foregroundStyle(subtle ? PrismTheme.muted : PrismTheme.ink)
      }.padding(.vertical, 13)
      if !last { Divider().overlay(PrismTheme.line) }
    }
    .accessibilityElement(children: .combine)
  }

  // MARK: actions

  private func beginSave() {
    if !UserDefaults.standard.bool(forKey: "save.disclosure.ack") { showDisclosure = true }
    else { showAuth = true }
  }

  private func load() async {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--uitest-save-demo") { display = .example; loading = false; return }
    #endif
    async let pos = try? await PrismAPI.shared.savePosition()
    async let st = try? await PrismAPI.shared.saveState()
    async let bal = try? await PrismAPI.shared.balance()
    async let wd = try? await PrismAPI.shared.saveWithdrawals()
    let position = await pos
    let st2 = await st
    state = st2
    display = SaveDisplay(position: position, stateRate: st2?.rate, pending: (await wd)?.pending ?? [])
    balanceAtomic = await bal?.amountAtomic
    loading = false
  }

  private func confirm(pin: String?, face: Bool, amountDollars: String) async {
    UserDefaults.standard.set(true, forKey: "save.disclosure.ack")
    guard let atomic else { return }
    do {
      if face { try await BiometricService().authenticate() }
      else { guard let pin, try PINService.shared.verify(pin) else { throw PaymentError.badPIN } }
      let quote = try await PrismAPI.shared.saveQuote(amountAtomic: atomic)

      if quote.demo == true {
        // Demo Save: a real testnet MockVault deposit. Sign the server-issued EIP-712 authorization on
        // the Mera account (same signer payments use) and relay it — never fabricate success.
        guard let auth = quote.authorization else { throw PaymentError.saveQuoteInvalid }
        let mera = MeraAccountManager.shared
        try await mera.beginSession(.payments)
        let authData = try auth.jsonData()
        let signature = try await mera.signTypedDataHex(authData)
        let result = try await PrismAPI.shared.saveSubmit(quoteId: quote.quoteId, signature: signature)
        PrismHaptics.success()
        terminal = .saved(amount: amountDollars)
        // result.txHash is the on-chain proof; the receipt sheet reads it back from the operation itself.
        model.presentSaveReceipt = SaveReceiptPresentation(operationId: result.operationId)
        await load()
        return
      }

      let account = model.identity?.accountAddress ?? ""
      let ok = quote.transactionPlan.map { SavePlan.verify($0, expectedInputAmount: atomic, account: account).isEmpty } ?? false
      PrismHaptics.warning()
      // Live + verified would show the real success copy; today the substrate is gated, so an honest preview.
      terminal = (quote.live && quote.planExecutable && ok)
        ? .saved(amount: amountDollars)
        : .preview(amount: amountDollars, reason: quote.notLiveReason ?? "Save goes live once your savings connect.")
    } catch { terminal = .failed(message: (error as? PaymentError)?.errorDescription ?? "That didn't work.") }
  }

  private func openWithdraw() { dismiss(); DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { model.withdrawPresented = true } }

  // MARK: derived

  private var atomic: String? { guard let a = Money.atomic(fromDollars: pendingAmount), a != "0" else { return nil }; return a }
  private var displayAmount: String {
    pendingAmount.isEmpty ? "$0.00" : (Decimal(string: pendingAmount) ?? 0).formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }
  private var overBalance: Bool {
    guard let atomic, let balanceAtomic, let a = UInt64(atomic), let b = UInt64(balanceAtomic) else { return false }
    return a > b
  }
  private var estimatedInvested: String { atomic.map { Money.dollars(fromAtomic: $0) } ?? "-" } // preview ≈ 1:1
  private var conversionCost: String { "$0.00" } // preview; a live quote fills the observed cost
  private func monthlyEstimate(_ d: SaveDisplay) -> String? {
    guard d.apyFresh, let atomic, let a = Double(atomic) else { return nil }
    let monthly = pow(1 + (d.rate.percent! / 100), 1.0 / 12) - 1
    return "~" + Money.dollars(fromAtomic: String(Int64((a * monthly).rounded())))
  }
  private func wholeDollars(_ atomic: String) -> String { String((UInt64(atomic) ?? 0) / 1_000_000) }
}

// MARK: - First entry

private struct SaveFirstEntry: View {
  let display: SaveDisplay
  let onStart: () -> Void

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        Text("Save").font(PrismTheme.display(40)).tracking(-0.8).padding(.top, 8)
        Text("Put your dollars to work.").font(PrismTheme.display(24)).tracking(-0.3).foregroundStyle(PrismTheme.ink).padding(.top, 12)
        Text("Save from the USDC already in Prism and earn a variable return.")
          .font(PrismTheme.body(14.5)).foregroundStyle(PrismTheme.muted).lineSpacing(3).padding(.top, 10)

        PrismCard {
          VStack(alignment: .leading, spacing: 6) {
            PrismSectionLabel(text: "Current rate")
            if let rate = display.rateText {
              Text(rate).font(PrismTheme.display(30)).tracking(-0.4)
              if let w = display.rateWindowText { Text(w).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted) }
            } else {
              Text("Set when Save connects").font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.muted)
            }
          }
        }.padding(.top, 24)

        infoRow("Withdrawals", "Available subject to vault liquidity; standard withdrawals may take time.").padding(.top, 16)

        Spacer(minLength: 28)
        PrismPrimaryButton(title: "Start saving", icon: "arrow.right") { onStart() }
        Text("Rates are variable. Your balance can be exposed to stablecoin, smart-contract and underlying strategy risk.")
          .font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted).lineSpacing(2).padding(.top, 12).padding(.horizontal, 2)
      }.padding(.horizontal, 24).padding(.bottom, 16)
    }
  }
  private func infoRow(_ label: String, _ text: String) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      PrismSectionLabel(text: label)
      Text(text).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.ink).lineSpacing(2)
    }
  }
}

// MARK: - Save home (has a position)

private struct SaveHomeContent: View {
  @EnvironmentObject private var model: AppModel
  let display: SaveDisplay
  let onSaveMore: () -> Void
  let onWithdraw: () -> Void

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        HStack { Text("Save").font(PrismTheme.display(34)).tracking(-0.6); Spacer(); if display.isExample { examplePill } }.padding(.top, 8)
        Text(display.balanceText).font(PrismTheme.display(58)).tracking(-1.4).monospacedDigit()
          .padding(.top, 10).accessibilityLabel("Total savings \(display.balanceText)")

        HStack(spacing: 26) {
          stat("Saved", display.savedText, nil)
          if let earned = display.earnedText { stat("Earned", earned, display.earnedIsPositive == true ? PrismTheme.positive : PrismTheme.ink) }
        }.padding(.top, 18)

        rateCard.padding(.top, 22)

        HStack(spacing: 10) {
          PrismPrimaryButton(title: "Save more", icon: "plus") { onSaveMore() }
          PrismSecondaryButton(title: "Withdraw", icon: "arrow.down") { onWithdraw() }
        }.padding(.top, 22)

        if display.hasPending { pendingSection.padding(.top, 26) }

        earningsCard.padding(.top, 26)

        Button { model.savePresented = false; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { model.saveDetailsPresented = true } } label: {
          HStack { Text("How it works").font(PrismTheme.body(13.5, weight: .semibold)); Spacer(); Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)) }
            .foregroundStyle(PrismTheme.mintDeep)
        }.buttonStyle(.plain).padding(.top, 22)
      }.padding(.horizontal, 24).padding(.bottom, 20)
    }
  }

  private var examplePill: some View {
    Text("EXAMPLE").font(PrismTheme.body(9.5, weight: .bold)).tracking(0.6).foregroundStyle(PrismTheme.amber)
      .padding(.horizontal, 8).padding(.vertical, 3).background(PrismTheme.amber.opacity(0.12)).clipShape(Capsule())
  }
  private func stat(_ label: String, _ value: String, _ color: Color?) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label.uppercased()).font(PrismTheme.body(9.5, weight: .semibold)).tracking(0.5).foregroundStyle(PrismTheme.muted)
      Text(value).font(PrismTheme.body(17, weight: .semibold)).monospacedDigit().foregroundStyle(color ?? PrismTheme.ink)
    }.accessibilityElement(children: .combine)
  }
  private var rateCard: some View {
    PrismCard {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          PrismSectionLabel(text: "Current rate")
          if let rate = display.rateText {
            Text(rate).font(PrismTheme.body(16, weight: .semibold))
            if let w = display.rateWindowText { Text(w).font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted) }
          } else {
            Text("Rate unavailable").font(PrismTheme.body(14, weight: .semibold)).foregroundStyle(PrismTheme.muted)
          }
        }
        Spacer()
        Image(systemName: "chart.line.uptrend.xyaxis").foregroundStyle(PrismTheme.mintDeep)
      }
    }
  }
  private var earningsCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrismSectionLabel(text: "Earnings")
      HStack(spacing: 26) {
        stat("This month (est.)", display.monthlyEstimateText ?? "-", PrismTheme.ink)
        stat("All time", display.allTimeEarnedText ?? "-", PrismTheme.ink)
      }
    }
  }

  // Pending withdrawals stay visible — never removed from view until the money lands.
  private var pendingSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: display.pending.count > 1 ? "Withdrawals" : "Withdrawal")
      ForEach(display.pending) { w in
        PrismCard(padding: 15) {
          HStack(spacing: 13) {
            ZStack { Circle().fill(PrismTheme.amber.opacity(0.12)).frame(width: 40, height: 40); Image(systemName: "clock.arrow.circlepath").foregroundStyle(PrismTheme.amber) }
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
              Text(display.pendingAmountText(w) ?? "Withdrawal").font(PrismTheme.body(16, weight: .semibold)).monospacedDigit()
              Text(pendingLine(w)).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted).lineSpacing(1.5)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Text(w.status).font(PrismTheme.body(10.5, weight: .semibold)).foregroundStyle(PrismTheme.amber)
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Withdrawal \(display.pendingAmountText(w) ?? ""), \(w.status)")
      }
    }
  }
  private func pendingLine(_ w: SavePendingWithdrawal) -> String {
    var parts: [String] = []
    if let r = w.requestedAt, let d = Date.prismParse(r) { parts.append("Requested \(d.formatted(.dateTime.month(.abbreviated).day()))") }
    if let win = w.expectedWindow { parts.append("Expected within \(win.lowercased())") }
    return parts.joined(separator: " · ")
  }
}

// MARK: - First-save disclosure

private struct FirstSaveDisclosure: View {
  let onAcknowledge: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Capsule().fill(PrismTheme.line).frame(width: 38, height: 5).frame(maxWidth: .infinity).padding(.top, 10)
      Text("Before you save").font(PrismTheme.display(30)).tracking(-0.5).padding(.top, 26)
      VStack(alignment: .leading, spacing: 16) {
        point("Your money is converted from USDC into a yield-bearing on-chain savings position.")
        point("Your savings are automatically managed across approved yield strategies by the underlying earnAUSD vault.")
        point("The rate is variable.")
        point("Withdrawals may not always be instant.")
        point("Savings involve stablecoin, smart-contract and underlying strategy risk.")
      }.padding(.top, 22)
      Spacer()
      PrismPrimaryButton(title: "I understand", icon: "checkmark") { dismiss(); onAcknowledge() }
    }
    .padding(.horizontal, 24).padding(.bottom, 18).prismScreen()
    .presentationDetents([.medium, .large])
  }
  private func point(_ text: String) -> some View {
    HStack(alignment: .top, spacing: 11) {
      Circle().fill(PrismTheme.mintDeep).frame(width: 6, height: 6).padding(.top, 7)
      Text(text).font(PrismTheme.body(14)).foregroundStyle(PrismTheme.ink).lineSpacing(2.5)
    }
  }
}

// MARK: - Terminal

enum SaveTerminal: Equatable {
  case saved(amount: String)                    // live success
  case preview(amount: String, reason: String)  // gated preview
  case failed(message: String)
}

private struct SaveSuccessTerminal: View {
  let terminal: SaveTerminal
  let done: () -> Void

  var body: some View {
    ZStack {
      Color.black.opacity(0.22).ignoresSafeArea()
      VStack(spacing: 15) {
        icon
        Text(title).font(PrismTheme.display(24)).multilineTextAlignment(.center)
        Text(message).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted).multilineTextAlignment(.center).lineSpacing(2).padding(.horizontal, 6)
        Button { done() } label: {
          Text("Done").font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
            .frame(maxWidth: .infinity).frame(height: 50).background(PrismTheme.mintSoft).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }.buttonStyle(.plain).padding(.top, 4)
      }
      .padding(.horizontal, 26).padding(.vertical, 28).frame(maxWidth: 330)
      .background(PrismTheme.paper).clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous)).prismCardShadow()
    }
  }
  private var icon: some View {
    let (s, t): (String, Color) = {
      switch terminal {
      case .saved: return ("checkmark", PrismTheme.mintDeep)
      case .preview: return ("clock.badge.checkmark", PrismTheme.amber)
      case .failed: return ("exclamationmark", PrismTheme.danger)
      }
    }()
    return ZStack { Circle().fill(t.opacity(0.12)).frame(width: 72, height: 72); Image(systemName: s).font(.system(size: 26, weight: .semibold)).foregroundStyle(t) }
  }
  private var title: String {
    switch terminal {
    case .saved(let a): return "\(a) saved"
    case .preview: return "Save is almost ready"
    case .failed: return "That didn't go through"
    }
  }
  private var message: String {
    switch terminal {
    case .saved: return "Your savings are now earning at the current variable rate."
    case .preview(let a, let reason): return "This is a preview. \(reason) Your \(a) wasn't moved."
    case .failed(let m): return m
    }
  }
}

/// Home entry for Save. A quiet card that reflects the real position (or invites a first save) — never a
/// DeFi dashboard. Substrate stays hidden; APY shows only when fresh.
struct SaveHomeCard: View {
  @EnvironmentObject private var model: AppModel
  @State private var display: SaveDisplay?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrismSectionLabel(text: "Save")
      Button { PrismHaptics.selection(); model.savePresented = true } label: {
        PrismCard(padding: 16) { content }
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isButton)
      .accessibilityHint("Opens Save")
    }
    .task { await load() }
  }

  @ViewBuilder private var content: some View {
    if let d = display, d.hasPosition {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 10) {
          glyph
          VStack(alignment: .leading, spacing: 2) {
            Text(d.balanceText).font(PrismTheme.body(19, weight: .semibold)).monospacedDigit()
            Text("Saved").font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted)
          }
          Spacer()
          Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PrismTheme.faint)
        }
        HStack(spacing: 14) {
          if let earned = d.earnedText { Text("\(earned) earned").font(PrismTheme.body(11.5, weight: .semibold)).foregroundStyle(d.earnedIsPositive == true ? PrismTheme.positive : PrismTheme.muted) }
          if let rate = d.rateText { Text("Current rate  \(rate)").font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted) }
        }
        if d.hasPending {
          HStack(spacing: 6) {
            Image(systemName: "clock.arrow.circlepath").font(.system(size: 10, weight: .semibold)).foregroundStyle(PrismTheme.amber)
            Text("\(d.pending.count) withdrawal\(d.pending.count == 1 ? "" : "s") processing").font(PrismTheme.body(11, weight: .semibold)).foregroundStyle(PrismTheme.amber)
          }
        }
      }
    } else {
      HStack(spacing: 13) {
        glyph
        VStack(alignment: .leading, spacing: 3) {
          Text("Put your dollars to work").font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.ink)
          if let rate = display?.rateText {
            Text("Earn \(rate)")
              .font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 6)
        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(PrismTheme.faint)
      }
    }
  }
  private var glyph: some View {
    ZStack { Circle().fill(PrismTheme.mintSoft).frame(width: 44, height: 44); Image(systemName: "banknote").font(.system(size: 17, weight: .medium)).foregroundStyle(PrismTheme.mintDeep) }
      .accessibilityHidden(true)
  }
  private func load() async {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--uitest-save-demo") { display = .example; return }
    #endif
    async let pos = try? await PrismAPI.shared.savePosition()
    async let st = try? await PrismAPI.shared.saveState()
    async let wd = try? await PrismAPI.shared.saveWithdrawals()
    display = SaveDisplay(position: await pos, stateRate: (await st)?.rate, pending: (await wd)?.pending ?? [])
  }
}
