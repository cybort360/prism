import SwiftUI

/// Take money out of a Circle — your own share only.
///
/// The ceiling on this screen is `withdrawableAtomic`: what the backend computes from chain truth
/// (this member's COMPLETED contributions minus their COMPLETED withdrawals, capped by what the
/// Safe actually holds right now). It is fetched live and never derived on the phone — there is no
/// client-side formula standing in for it, and the amount typed here can never be submitted past it.
///
/// A withdrawal is a Circle payment under the hood — to the member's own account, but otherwise an
/// ordinary threshold `PAYMENT` proposal — so submitting here signs nothing and moves nothing. It
/// ends where `CirclePayView`'s propose path ends: "Waiting for approval", because the Circle's
/// admins still have to agree before this money actually leaves.
struct CircleWithdrawView: View {
  let circle: CircleSummary
  @Environment(\.dismiss) private var dismiss
  @StateObject private var coordinator = CircleCoordinator()
  @State private var amount = ""
  @State private var withdrawable: CircleWithdrawableResponse?
  @State private var loadingCeiling = true
  @State private var error: String?
  @State private var proposed: CirclePayment?

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Withdraw", back: { dismiss() })
          .padding(.horizontal, 22).padding(.top, 10)

        Spacer().frame(height: 18)

        ZStack {
          Circle().fill(PrismTheme.mintSoft).frame(width: 64, height: 64)
          CircleGlyph(icon: circle.icon, name: circle.name, size: 26)
        }
        Text(circle.name)
          .font(PrismTheme.body(17, weight: .semibold))
          .padding(.top, 10)

        Spacer().frame(height: 22)

        AmountText(dollars: displayAmount, size: 76).padding(.horizontal, 22)

        ceilingRow.padding(.horizontal, 24).padding(.top, 18)

        if let error {
          ErrorBanner(message: error).padding(.horizontal, 24).padding(.top, 10)
        }

        MoneyKeypad(value: $amount).padding(.horizontal, 30).padding(.top, 10)

        Spacer()

        PrismPrimaryButton(title: confirmTitle, enabled: canSubmit) {
          Task { await propose() }
        }
        .padding(24)
      }
      .prismScreen()

      if coordinator.state != .idle {
        OperationStateOverlay(state: coordinator.state, onDismiss: { coordinator.reset() })
      }
    }
    .sheet(item: $proposed) { payment in
      CircleWithdrawalProposedSheet(payment: payment, circleName: circle.name) { dismiss() }
    }
    .task { await loadCeiling() }
  }

  /// Stated plainly, the same way `CircleAddMoneyView`'s "From" row states where a contribution
  /// comes from: this is the one number the confirm button is allowed to respect.
  private var ceilingRow: some View {
    HStack(spacing: 12) {
      ZStack {
        Circle().fill(PrismTheme.surface).frame(width: 36, height: 36)
        Image(systemName: "arrow.up.right").font(.system(size: 15, weight: .medium)).foregroundStyle(PrismTheme.muted)
      }
      VStack(alignment: .leading, spacing: 2) {
        PrismSectionLabel(text: "You can withdraw up to")
        Text(loadingCeiling ? "…" : ceilingDisplay).font(PrismTheme.body(14, weight: .semibold))
      }
      Spacer()
      Text("USDC").font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
    }
    .padding(15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
  }

  private var ceilingDisplay: String {
    guard let withdrawable else { return "—" }
    return Money.assetAmount(fromAtomic: withdrawable.withdrawableAtomic)
  }

  private var confirmTitle: String {
    amount.isEmpty ? "Withdraw" : "Withdraw \(displayAmount)"
  }

  private var atomic: String? {
    guard let value = Money.atomic(fromDollars: amount), value != "0" else { return nil }
    return value
  }

  /// The backend's `withdrawableAtomic` is the only ceiling this screen knows — this never computes
  /// one of its own, it only refuses to submit past the number the backend already gave it.
  private var exceedsCeiling: Bool {
    guard let atomic, let withdrawable,
      let want = Decimal(string: atomic), let have = Decimal(string: withdrawable.withdrawableAtomic)
    else { return false }
    return want > have
  }

  private var canSubmit: Bool {
    atomic != nil && !exceedsCeiling && !loadingCeiling && withdrawable != nil
  }

  private var displayAmount: String {
    amount.isEmpty
      ? "$0.00"
      : (Decimal(string: amount) ?? 0).formatted(
        .currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }

  private func loadCeiling() async {
    loadingCeiling = true
    defer { loadingCeiling = false }
    do {
      withdrawable = try await PrismAPI.shared.circleWithdrawable(circle.circleId)
    } catch {
      self.error = "Prism couldn't read what you can withdraw just now. Pull down to try again."
    }
  }

  private func propose() async {
    guard let atomic else { return }
    error = nil
    if exceedsCeiling {
      error = "That's more than you can withdraw right now."
      return
    }
    await coordinator.proposeWithdrawal(circleId: circle.circleId, amountAtomic: atomic)
    switch coordinator.state {
    case .failed(let message):
      error = message
    default:
      if let payment = coordinator.lastPayment {
        proposed = payment
      }
    }
  }
}

/// What happens after a withdrawal is proposed: nothing yet. A withdrawal IS a Circle payment — to
/// the member's own account, but a threshold payment all the same — so this is the same honest
/// stopping point `CirclePayView`'s "Waiting for approval" sheet uses.
private struct CircleWithdrawalProposedSheet: View {
  let payment: CirclePayment
  let circleName: String
  let done: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      Capsule().fill(PrismTheme.line).frame(width: 38, height: 5).padding(.top, 10)

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 68, height: 68)
        Image(systemName: "arrow.up.right.circle.fill")
          .font(.system(size: 24, weight: .medium)).foregroundStyle(PrismTheme.mintDeep)
      }
      .padding(.top, 28)

      Text("Waiting for approval").font(PrismTheme.display(29)).tracking(-0.5).padding(.top, 18)

      Text(Money.dollars(fromAtomic: payment.amount ?? "0"))
        .font(PrismTheme.display(46)).tracking(-1.2).monospacedDigit().padding(.top, 4)

      Text("to your account")
        .font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted).padding(.top, 4)

      VStack(alignment: .leading, spacing: 12) {
        row("From", circleName)
        if let progress = payment.approvalProgress { row("Approval", progress) }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(PrismTheme.surface)
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .padding(.horizontal, 24).padding(.top, 22)

      Text("Nothing has moved yet. The Circle's admins each approve on their own device, and the withdrawal is sent once enough of them have.")
        .font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center).lineSpacing(2)
        .padding(.horizontal, 30).padding(.top, 16)

      Spacer()

      PrismPrimaryButton(title: "Done", icon: "checkmark") { dismiss(); done() }
        .padding(24)
    }
    .prismScreen()
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack {
      Text(label).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      Text(value).font(PrismTheme.body(13.5, weight: .semibold))
    }
  }
}
