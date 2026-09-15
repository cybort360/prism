import SwiftUI

/// Prism Save — put USDC already in your Prism account to work.
///
/// Consumer flow: USDC balance → amount → review the rate → Face ID/PIN → done. The substrate
/// (AUSD/earnAUSD) is hidden. Right now Save is an ANNOUNCED preview: the earnAUSD deposit isn't
/// connected on this deployment (see docs/SAVE_DEPENDENCY_AUDIT.md), so the flow runs end-to-end but
/// lands on an honest preview terminal — no money is moved, and no rate is invented. The client
/// independently verifies the backend's plan before it would ever execute.
struct SaveView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss

  @State private var amount = ""
  @State private var balanceAtomic: String?
  @State private var state: SaveState?
  @State private var showAuth = false
  @State private var quoting = false
  @State private var error: String?
  @State private var preview: PreviewResult?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Save", back: { dismiss() }).padding(.horizontal, 22).padding(.top, 10)

        Spacer().frame(height: 18)
        PrismSectionLabel(text: "Amount to save")
        AmountText(dollars: displayAmount, size: 72).padding(.top, 6)
        availableLine.padding(.top, 10)

        rateCard.padding(.horizontal, 24).padding(.top, 22)

        if let error {
          ErrorBanner(message: error).padding(.horizontal, 24).padding(.top, 14)
        }

        MoneyKeypad(value: $amount).padding(.horizontal, 30).padding(.top, 18)
        Spacer()

        VStack(spacing: 4) {
          PrismPrimaryButton(
            title: quoting ? "Checking…" : "Review & Save",
            enabled: atomic != nil && !quoting && overBalance == false,
            icon: "lock.fill"
          ) { Task { await review() } }
          // Withdraw returns saved money to spendable USDC. Presented from the shell so it isn't nested.
          Button("Withdraw from Save") {
            dismiss()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { model.withdrawPresented = true }
          }
          .font(PrismTheme.body(13.5, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
          .padding(.vertical, 10)
        }
        .padding(24)
      }
      .prismScreen()

      if let preview { SavePreviewTerminal(result: preview) { dismiss() } }
    }
    .task { await load() }
    .sheet(isPresented: $showAuth) {
      PaymentAuthorizationSheet(amount: displayAmount) { pin, face in
        Task { await confirm(pin: pin, face: face) }
      }
    }
  }

  // MARK: pieces

  private var availableLine: some View {
    Group {
      if let balanceAtomic {
        Text("\(Money.dollars(fromAtomic: balanceAtomic)) available to save")
          .font(PrismTheme.body(12.5)).foregroundStyle(overBalance == true ? PrismTheme.danger : PrismTheme.muted)
      } else {
        Text("USDC in your Prism account").font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      }
    }
  }

  /// The rate surface. When Save isn't connected yet we never show a fabricated %, only an honest note.
  private var rateCard: some View {
    PrismCard {
      HStack(spacing: 13) {
        ZStack {
          Circle().fill(PrismTheme.mintSoft).frame(width: 42, height: 42)
          Image(systemName: "chart.line.uptrend.xyaxis").foregroundStyle(PrismTheme.mintDeep)
        }
        VStack(alignment: .leading, spacing: 3) {
          if let rate = state?.rate, rate.available, let bps = rate.apyBps {
            Text("\(String(format: "%.1f", Double(bps) / 100)) % / year").font(PrismTheme.body(15, weight: .semibold))
            Text("Variable rate").font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
          } else {
            Text("Variable rate").font(PrismTheme.body(15, weight: .semibold))
            Text(state?.rate.reason ?? "Shown when Save connects to earnAUSD")
              .font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer()
      }
    }
  }

  // MARK: logic

  private var atomic: String? {
    guard let a = Money.atomic(fromDollars: amount), a != "0" else { return nil }
    return a
  }
  private var displayAmount: String {
    amount.isEmpty ? "$0.00"
      : (Decimal(string: amount) ?? 0).formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }
  private var overBalance: Bool? {
    guard let atomic, let balanceAtomic, let a = UInt64(atomic), let b = UInt64(balanceAtomic) else { return nil }
    return a > b
  }

  private func load() async {
    async let s = try? await PrismAPI.shared.saveState()
    async let b = try? await PrismAPI.shared.balance()
    state = await s
    balanceAtomic = await b?.amountAtomic
  }

  private func review() async {
    guard let atomic else { return }
    quoting = true; error = nil
    defer { quoting = false }
    do {
      _ = try await PrismAPI.shared.saveQuote(amountAtomic: atomic)   // fetch a fresh quote before approval
      showAuth = true
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func confirm(pin: String?, face: Bool) async {
    guard let atomic else { return }
    do {
      // Local approval gate (same as a payment): Face ID or the payment PIN.
      if face { try await BiometricService().authenticate() }
      else { guard let pin, try PINService.shared.verify(pin) else { throw PaymentError.badPIN } }

      // Re-fetch the quote, then INDEPENDENTLY verify the plan the backend returned against the app's own
      // known substrate + the amount the user entered. The backend can never make us execute an
      // unverified or arbitrary plan.
      let quote = try await PrismAPI.shared.saveQuote(amountAtomic: atomic)
      let account = model.identity?.accountAddress ?? ""
      let violations = SavePlan.verify(quote.transactionPlan, expectedInputAmount: atomic, account: account)

      if quote.planExecutable && violations.isEmpty && quote.live {
        // Real execution path — not built yet; the substrate is unverified, so we never reach here today.
        preview = PreviewResult(amount: displayAmount, reason: quote.notLiveReason ?? "Save execution is not enabled yet.")
      } else {
        // Honest preview terminal: nothing was moved, no yield claimed.
        PrismHaptics.warning()
        preview = PreviewResult(amount: displayAmount,
          reason: quote.notLiveReason ?? "Save goes live once earnAUSD is connected.")
      }
    } catch {
      self.error = Self.friendly(error)
    }
  }

  private static func friendly(_ error: Error) -> String {
    if let e = error as? PaymentError { return e.errorDescription ?? "That didn't work." }
    return error.localizedDescription
  }
}

private struct PreviewResult: Identifiable { let id = UUID(); let amount: String; let reason: String }

/// The honest terminal: the flow completed, but Save isn't live — say so plainly, and never imply money
/// moved or yield began.
private struct SavePreviewTerminal: View {
  let result: PreviewResult
  let done: () -> Void

  var body: some View {
    ZStack {
      Color.black.opacity(0.22).ignoresSafeArea()
      VStack(spacing: 16) {
        ZStack {
          Circle().fill(PrismTheme.amber.opacity(0.12)).frame(width: 72, height: 72)
          Image(systemName: "clock.badge.checkmark").font(.system(size: 26, weight: .medium)).foregroundStyle(PrismTheme.amber)
        }
        Text("Save is almost ready").font(PrismTheme.display(24)).multilineTextAlignment(.center)
        Text("This is a preview — \(result.reason) Your \(result.amount) wasn't moved.")
          .font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted)
          .multilineTextAlignment(.center).lineSpacing(2).padding(.horizontal, 6)
        Button {
          done()
        } label: {
          Text("Got it").font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
            .frame(maxWidth: .infinity).frame(height: 50)
            .background(PrismTheme.mintSoft).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain).padding(.top, 4)
      }
      .padding(.horizontal, 26).padding(.vertical, 28)
      .frame(maxWidth: 320)
      .background(PrismTheme.paper).clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
      .prismCardShadow()
    }
    .transition(.opacity)
  }
}

/// Home entry for Save. A quiet card, not a DeFi dashboard: put your USDC to work in one tap.
struct SaveHomeCard: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrismSectionLabel(text: "Save")
      Button {
        PrismHaptics.selection()
        model.savePresented = true
      } label: {
        PrismCard(padding: 15) {
          HStack(spacing: 13) {
            ZStack {
              Circle().fill(PrismTheme.mintSoft).frame(width: 44, height: 44)
              Image(systemName: "lock.fill").font(.system(size: 17, weight: .medium)).foregroundStyle(PrismTheme.mintDeep)
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
              Text("Put your USDC to work").font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.ink)
              Text("Earn a variable rate on the balance you save").font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(PrismTheme.faint)
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Save. Put your USDC to work, earn a variable rate.")
      .accessibilityHint("Opens Save")
      .accessibilityAddTraits(.isButton)
    }
  }
}
