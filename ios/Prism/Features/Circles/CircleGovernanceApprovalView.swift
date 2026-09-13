import SwiftUI

/// Approving a change to how a Circle works.
///
/// This is the approval screen for everything that is not a payment: adding or removing an admin,
/// changing how many approvals a payment needs, and setting or revoking a spending limit. It shares
/// the payment screen's discipline exactly — the device rebuilds the transaction from what is on
/// screen and refuses to sign if it disagrees — because these changes decide who can move the money
/// later, which makes them at least as consequential as any single payment.
///
/// The one thing it says that the payment screen does not: **a change is not applied when it is
/// approved.** Approvals are collected, then the change is sent, then Prism reads the Circle back
/// off Monad and only then calls it done. Each of those is a separate line on screen.
struct CircleGovernanceApprovalView: View {
  let proposal: CircleGovernanceProposal
  /// The Circle as this device knows it. Nil when the sheet was opened from somewhere that does not
  /// already hold it — it is then fetched, never inferred from the proposal.
  let detail: CircleDetail?
  let reload: () async -> Void

  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var coordinator = CircleCoordinator()
  @State private var current: CircleGovernanceProposal
  @State private var circle: CircleDetail?
  @State private var network: PrismNetworkConfig?
  @State private var showAuth = false
  @State private var error: String?

  init(proposal: CircleGovernanceProposal, detail: CircleDetail?, reload: @escaping () async -> Void) {
    self.proposal = proposal
    self.detail = detail
    self.reload = reload
    _current = State(initialValue: proposal)
    _circle = State(initialValue: detail)
  }

  private var title: String { CircleVocabulary.governanceTitle(current) }

  var body: some View {
    ZStack {
      ScrollView(showsIndicators: false) {
        VStack(spacing: 0) {
          PrismTopBar(title: "Circle change", back: { dismiss() }).padding(.top, 12)

          ZStack {
            Circle().fill(PrismTheme.mintSoft).frame(width: 64, height: 64)
            Image(systemName: symbol)
              .font(.system(size: 24, weight: .medium))
              .foregroundStyle(PrismTheme.mintDeep)
          }
          .padding(.top, 26)
          .accessibilityHidden(true)

          Text(title)
            .font(PrismTheme.display(27))
            .tracking(-0.5)
            .multilineTextAlignment(.center)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 26)
            .padding(.top, 16)

          Text(explanation)
            .font(PrismTheme.body(13))
            .foregroundStyle(PrismTheme.muted)
            .multilineTextAlignment(.center)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 28)
            .padding(.top, 8)

          facts.padding(.horizontal, 22).padding(.top, 24)

          if let note = CircleVocabulary.remainingStepsNote(current) {
            HStack(alignment: .top, spacing: 10) {
              Image(systemName: "list.number")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PrismTheme.pending)
                .accessibilityHidden(true)
              Text(note)
                .font(PrismTheme.body(12))
                .foregroundStyle(PrismTheme.muted)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PrismTheme.canvas)
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            .padding(.horizontal, 22)
            .padding(.top, 14)
          }

          if let blocking = blockingState {
            CircleNotice(state: blocking).padding(.horizontal, 22).padding(.top, 14)
          }

          if let error {
            ErrorBanner(message: error).padding(.horizontal, 22).padding(.top, 14)
          }

          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.shield.fill")
              .foregroundStyle(PrismTheme.mintDeep)
              .accessibilityHidden(true)
            Text("Before you approve, this device rebuilds this change from what you see here and refuses to sign if it doesn't match.")
              .font(PrismTheme.body(12))
              .foregroundStyle(PrismTheme.muted)
              .lineSpacing(2)
              .fixedSize(horizontal: false, vertical: true)
          }
          .padding(.horizontal, 24)
          .padding(.top, 16)

          Spacer(minLength: 26)

          actions.padding(.horizontal, 22).padding(.bottom, 24)
        }
      }
      .prismScreen()

      if coordinator.state != .idle {
        OperationStateOverlay(state: coordinator.state, onDismiss: { coordinator.reset() })
      }
    }
    .sheet(isPresented: $showAuth) {
      CircleAuthorizationSheet(
        title: "Approve change",
        subtitle: title,
        detail: "Your approval counts toward the \(current.requiredApprovals.map(String.init) ?? "required") needed. Nothing changes until enough admins have approved."
      ) { pin, face in
        Task { await approve(pin: pin, face: face) }
      }
    }
    .task {
      network = try? await PrismAPI.shared.config()
      if circle == nil {
        circle = try? await PrismAPI.shared.circle(current.circleId)
      }
      await refresh()
    }
  }

  private var symbol: String {
    switch current.kind {
    case "OWNER_ADD": return "person.badge.plus"
    case "OWNER_REMOVE": return "person.badge.minus"
    case "THRESHOLD_CHANGE": return "slider.horizontal.3"
    case "SPEND_DELEGATE_REMOVE", "SPEND_LIMIT_DELETE": return "hand.raised.fill"
    default: return "creditcard.and.123"
    }
  }

  /// What this change does, in the consequence terms the creation flow used — so the same decision
  /// reads the same way whenever it is made.
  private var explanation: String {
    switch current.kind {
    case "OWNER_ADD":
      return "They'll be able to approve payments out of this Circle, and approve changes like this one."
    case "OWNER_REMOVE":
      return "Their approval will stop counting toward payments. Any approval they already gave stops counting too."
    case "THRESHOLD_CHANGE":
      guard let threshold = current.subject?.threshold, let admins = current.subject?.ownerCountAfter else {
        return "This changes how many admins have to approve each payment."
      }
      return CircleVocabulary.approvalRuleConsequence(threshold: threshold, admins: admins)
    case "MODULE_ENABLE":
      return "This turns on per-person spending limits for the Circle. It doesn't give anyone a limit by itself."
    case "SPEND_DELEGATE_ADD":
      return "This registers them as someone who can be given a spending limit. It doesn't set an amount by itself."
    case "SPEND_LIMIT_SET":
      return "They'll be able to pay out of this Circle on their own, up to this much, without anyone approving each payment."
    case "SPEND_DELEGATE_REMOVE", "SPEND_LIMIT_DELETE":
      return "They'll no longer be able to pay out of this Circle on their own. Every payment they make will need the Circle's approval."
    default:
      return "This changes how this Circle works."
    }
  }

  private var facts: some View {
    VStack(alignment: .leading, spacing: 14) {
      row("Circle", current.circleName ?? circle?.name ?? "this Circle")
      row("Requested by", requesterLabel)
      if let threshold = current.subject?.threshold, current.kind == "THRESHOLD_CHANGE" {
        row("New rule", CircleVocabulary.approvalRule(threshold: threshold, admins: current.subject?.ownerCountAfter))
      }
      if let amount = current.subject?.amount {
        row("Limit", Money.assetAmount(fromAtomic: amount))
      }
      HStack {
        Text("Approval").font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
        Spacer()
        if let progress = current.approvalProgress {
          Text(progress).font(PrismTheme.body(13.5, weight: .semibold)).monospacedDigit()
        } else {
          // The chain could not be read. Unknown is truthful; a remembered count is not.
          Text("Unknown").font(PrismTheme.body(13.5, weight: .semibold)).foregroundStyle(PrismTheme.amber)
        }
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer(minLength: 8)
      Text(value)
        .font(PrismTheme.body(13.5, weight: .semibold))
        .multilineTextAlignment(.trailing)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
  }

  private var requesterLabel: String {
    guard let proposer = current.proposerPrismId else { return "a member" }
    if proposer == model.identity?.prismId { return "you" }
    if let member = circle?.members?.first(where: { $0.prismId == proposer }) {
      return member.displayName ?? member.handle ?? "a member"
    }
    return "a member"
  }

  private var blockingState: CircleState? {
    if current.staleNonce == true { return .proposalStale }
    if let reason = coordinator.blockedReason { return .networkUnavailable(detail: reason) }
    if current.state == "INVALIDATED" || current.state == "FAILED" {
      return .setupFailed(reason: current.failureReason)
    }
    return nil
  }

  @ViewBuilder private var actions: some View {
    if current.isComplete {
      VStack(spacing: 10) {
        SuccessBanner(message: "This change is active on Monad. Prism read it back to confirm.")
        PrismPrimaryButton(title: "Done", icon: "checkmark") { finish() }
      }
    } else if current.isDead {
      PrismSecondaryButton(title: "Close", icon: "xmark") { dismiss() }
    } else if current.isReadyToApply {
      // Enough approvals exist. Applying grants nothing further — the backend re-reads the live
      // admin set, re-verifies every signature and simulates before anything is broadcast.
      PrismPrimaryButton(title: "Apply change", icon: "checkmark.seal.fill") { Task { await apply() } }
    } else {
      PrismPrimaryButton(title: "Approve", enabled: circle != nil) { showAuth = true }
    }
  }

  private func finish() {
    dismiss()
    Task { await reload() }
  }

  private func refresh() async {
    if let fresh = try? await PrismAPI.shared.circleGovernanceStatus(
      circleId: current.circleId, proposalId: current.proposalId) {
      current = fresh
    }
  }

  private func approve(pin: String?, face: Bool) async {
    guard let circle else { return }
    error = nil
    await coordinator.approveGovernance(
      proposal: current, circle: circle, summary: title,
      allowanceModule: network?.allowanceModule, pin: pin, useFaceID: face)
    switch coordinator.state {
    case .failed(let message): error = message
    default:
      if let updated = coordinator.lastGovernance { current = updated }
      await reload()
    }
  }

  private func apply() async {
    error = nil
    await coordinator.applyGovernance(proposal: current)
    if let updated = coordinator.lastGovernance { current = updated }
    switch coordinator.state {
    case .failed(let message): error = message
    case .sent:
      PrismHaptics.success()
      await reload()
    default: break
    }
  }
}
