import SwiftUI

/// How this Circle works, and the two controls that change it.
///
/// Everything on this screen is either a fact read off Monad or a change the Circle has to approve.
/// There is no third category, and the layout says so: the top half states what is true, the bottom
/// half starts changes. Nothing here takes effect on tap, and each control that starts a change
/// leads to the same approval screen an admin would see from anyone else — so the person making the
/// change sees exactly what the others will be asked to agree to.
struct CircleSettingsView: View {
  let circleId: String
  let detail: CircleDetail?
  let summary: CircleSummary
  let reload: () async -> Void

  @EnvironmentObject private var model: AppModel
  @State private var changingRule = false
  @State private var pendingChange: CircleGovernanceProposal?
  @State private var limitsStatus: CircleLimitsStatus?
  @State private var busy = false
  @State private var error: String?

  private var authority: CircleAuthority? { detail?.authority }
  private var admins: [CircleMember] {
    (detail?.members ?? []).filter {
      CircleVocabulary.Role(wire: $0.role) == .admin && $0.status != "REMOVED" && $0.status != "LEFT"
    }
  }
  private var isClosing: Bool { detail?.status == "CLOSING" }
  private var isAdmin: Bool {
    guard let me = detail?.members?.first(where: { $0.prismId == model.identity?.prismId }) else { return false }
    return CircleVocabulary.Role(wire: me.role) == .admin && me.authorityConfirmedOnChain == true
  }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        howItWorks
        adminList.padding(.top, 30)
        spendingLimits.padding(.top, 30)
        if isAdmin { changes.padding(.top, 30) }
        if let error { ErrorBanner(message: error).padding(.top, 18) }
        provenance.padding(.top, 30)
      }
      .padding(.horizontal, 22)
      .padding(.top, 10)
      .padding(.bottom, 40)
    }
    .prismScreen()
    .navigationTitle("Settings")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(item: $pendingChange) { proposal in
      CircleGovernanceApprovalView(proposal: proposal, detail: detail) { await reload() }
    }
    .sheet(isPresented: $changingRule) {
      CircleApprovalRuleSheet(
        currentThreshold: authority?.threshold,
        adminCount: authority?.adminCount ?? admins.count
      ) { threshold in
        Task { await proposeRule(threshold) }
      }
    }
    .task { limitsStatus = try? await PrismAPI.shared.circleLimitsStatus() }
  }

  // MARK: what is true

  private var howItWorks: some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "How this Circle works")
      VStack(spacing: 0) {
        fact("Name", summary.name)
        Divider().overlay(PrismTheme.line)
        fact("Payments require", CircleVocabulary.approvalRule(threshold: authority?.threshold, admins: authority?.adminCount))
        Divider().overlay(PrismTheme.line)
        fact("Money held as", "US dollars")
        Divider().overlay(PrismTheme.line)
        fact("Spare approvals", spareLine)
      }
      .padding(.horizontal, 15)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))

      if let spare = authority?.spare, spare == 0, let admins = authority?.adminCount, admins >= 2 {
        // The one configuration with no repair path. Said here every time, not only at creation,
        // because a Circle can arrive at it later by removing an admin.
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(PrismTheme.amber)
            .accessibilityHidden(true)
          Text("Every admin has to approve every payment. If any one of them loses access and can't recover it, this Circle's money can't be moved by anyone, including Prism. Adding a spare admin now is the only way to prevent that.")
            .font(PrismTheme.body(12))
            .foregroundStyle(PrismTheme.ink)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PrismTheme.amber.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
      }
    }
  }

  private var spareLine: String {
    guard let spare = authority?.spare else { return "Unknown" }
    if spare == 0 { return "None" }
    return "\(spare) admin\(spare == 1 ? "" : "s")"
  }

  private func fact(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label).font(PrismTheme.body(13.5)).foregroundStyle(PrismTheme.muted)
      Spacer(minLength: 8)
      Text(value)
        .font(PrismTheme.body(13.5, weight: .semibold))
        .multilineTextAlignment(.trailing)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 14)
    .accessibilityElement(children: .combine)
  }

  private var adminList: some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "Admins")
      if admins.isEmpty {
        Text(detail == nil
          ? "Prism couldn't read this Circle's admins from Monad just now, so they're unknown rather than out of date."
          : "This Circle has no confirmed admins on Monad.")
          .font(PrismTheme.body(12.5))
          .foregroundStyle(PrismTheme.muted)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        ForEach(admins) { admin in
          HStack(spacing: 12) {
            PrismAvatar(initials: initials(admin), size: 40)
            VStack(alignment: .leading, spacing: 2) {
              Text(admin.prismId == model.identity?.prismId
                   ? "\(admin.displayName ?? admin.handle ?? "You") (you)"
                   : (admin.displayName ?? admin.handle ?? "An admin"))
                .font(PrismTheme.body(14, weight: .semibold))
                .lineLimit(1)
              Text(admin.authorityConfirmedOnChain == true ? "Approval counts" : "Not yet active on Monad")
                .font(PrismTheme.body(11.5))
                .foregroundStyle(PrismTheme.muted)
            }
            Spacer()
            let status = CircleVocabulary.memberStatus(admin)
            if status.text != "Active" {
              CircleStatusBadge(text: status.text, tone: status.tone, symbol: status.symbol)
            }
          }
          .padding(.vertical, 10)
          .accessibilityElement(children: .combine)
        }
      }
    }
  }

  private func initials(_ member: CircleMember) -> String {
    let source = member.displayName ?? member.handle?.replacingOccurrences(of: "@", with: "") ?? "?"
    let value = source.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    return value.isEmpty ? "?" : value
  }

  private var spendingLimits: some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "Spending limits")
      if limitsStatus?.enabled == true {
        Text("People in this Circle can be given a limit they can spend within on their own. Set one from their member page. Each limit is a change the Circle's admins approve together.")
          .font(PrismTheme.body(12.5))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        // Not a fault and not hidden: every payment being approved by the admins is a complete way
        // for a Circle to work, and this says so instead of showing a control that cannot work.
        CircleStateView(state: .limitsUnavailable(reason: limitsStatus?.reason), compact: true)
      }
    }
  }

  // MARK: what can change

  private var changes: some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "Change how it works")
      Text("These are decided by the Circle. Choosing one starts a change the admins approve together, so nothing takes effect when you tap.")
        .font(PrismTheme.body(12))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)

      settingsButton("Change how many approvals are needed", symbol: "slider.horizontal.3") {
        changingRule = true
      }
      settingsButton("Add an admin", symbol: "person.badge.plus") {
        // Adding an admin starts from a person, so it belongs on the member page — and it is only
        // reachable for someone already in the Circle, which is the safe order.
        error = "Open the person from the Circle's Members list and choose \"Make an admin\". Anyone who isn't in the Circle yet needs an invitation first."
      }

      // Closing is a lifecycle, not a delete, and it gets its own screen for that reason: what is
      // still open, who can still spend, and what is still in the account are all live reads, and
      // the remaining balance is a decision the Circle has to make for itself.
      NavigationLink(value: CircleDetailRoute.close) {
        HStack(spacing: 12) {
          Image(systemName: "archivebox")
            .font(.system(size: 14, weight: .medium))
            .frame(width: 34, height: 34)
            .background(PrismTheme.paper)
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
          VStack(alignment: .leading, spacing: 2) {
            Text(isClosing ? "Finish closing this Circle" : "Close this Circle")
              .font(PrismTheme.body(14, weight: .medium))
            Text("Its history stays. Money in it has to go somewhere first.")
              .font(PrismTheme.body(11.5))
              .foregroundStyle(PrismTheme.muted)
          }
          Spacer(minLength: 6)
          Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PrismTheme.faint)
        }
        .padding(.vertical, 12)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
    }
    .opacity(busy ? 0.55 : 1)
    .disabled(busy)
  }

  private func settingsButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 11) {
        Image(systemName: symbol).font(.system(size: 14, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
        Text(title)
          .font(PrismTheme.body(14, weight: .semibold))
          .foregroundStyle(PrismTheme.ink)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 6)
        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(PrismTheme.faint)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 17)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
    }
    .buttonStyle(.plain)
  }

  /// Where this Circle's facts come from. Shown last and plainly, because "Prism cannot move this
  /// money" is a claim that should be inspectable rather than asserted.
  private var provenance: some View {
    VStack(alignment: .leading, spacing: 9) {
      PrismSectionLabel(text: "Where this comes from")
      Text("The balance, the admins and the approval rule on this screen are read from Monad every time you open it. Prism stores the Circle's name and who was invited, and nothing else about it. A payment out of this Circle needs the approvals above. Prism cannot add one, and cannot move this money without them.")
        .font(PrismTheme.body(12))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
      if summary.verifiedOnChain == true {
        CircleStatusBadge(text: "Verified on Monad", tone: .positive, symbol: "checkmark.seal.fill")
      } else {
        CircleStatusBadge(text: "Not verified yet", tone: .waiting, symbol: "clock.fill")
      }
    }
  }

  private func proposeRule(_ threshold: Int) async {
    busy = true
    defer { busy = false }
    error = nil
    do {
      pendingChange = try await PrismAPI.shared.prepareCircleThresholdChange(
        circleId: circleId, threshold: threshold)
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// Choosing a new approval rule, with the consequence of each option beside it — the same copy the
/// creation flow uses, so the decision reads identically wherever it is made.
private struct CircleApprovalRuleSheet: View {
  let currentThreshold: Int?
  let adminCount: Int
  let propose: (Int) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var selection: Int

  init(currentThreshold: Int?, adminCount: Int, propose: @escaping (Int) -> Void) {
    self.currentThreshold = currentThreshold
    self.adminCount = adminCount
    self.propose = propose
    _selection = State(initialValue: currentThreshold ?? 1)
  }

  var body: some View {
    VStack(spacing: 0) {
      Capsule().fill(PrismTheme.line).frame(width: 38, height: 5).padding(.top, 10)

      Text("How many admins are needed?")
        .font(PrismTheme.display(26))
        .tracking(-0.4)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 26)
        .padding(.top, 22)

      ScrollView(showsIndicators: false) {
        VStack(spacing: 9) {
          ForEach(1...max(1, adminCount), id: \.self) { threshold in
            Button {
              selection = threshold
            } label: {
              VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 9) {
                  Image(systemName: selection == threshold ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(selection == threshold ? PrismTheme.mintDeep : PrismTheme.faint)
                  Text("\(threshold) of \(adminCount)")
                    .font(PrismTheme.body(15.5, weight: .semibold))
                    .foregroundStyle(PrismTheme.ink)
                  if threshold == currentThreshold {
                    CircleStatusBadge(text: "Current", tone: .neutral, symbol: "checkmark")
                  }
                  Spacer()
                }
                Text(CircleVocabulary.approvalRuleConsequence(threshold: threshold, admins: adminCount))
                  .font(PrismTheme.body(12.5))
                  .foregroundStyle(PrismTheme.muted)
                  .lineSpacing(2)
                  .multilineTextAlignment(.leading)
                  .fixedSize(horizontal: false, vertical: true)
                  .padding(.leading, 27)
              }
              .padding(15)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(PrismTheme.paper)
              .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 17, style: .continuous)
                  .stroke(selection == threshold ? PrismTheme.mintDeep : PrismTheme.line,
                          lineWidth: selection == threshold ? 1.4 : 0.7))
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(threshold) of \(adminCount). \(CircleVocabulary.approvalRuleConsequence(threshold: threshold, admins: adminCount))")
            .accessibilityValue(selection == threshold ? "Selected" : "Not selected")
            .accessibilityAddTraits(.isButton)
          }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 20)
      }

      PrismPrimaryButton(
        title: "Suggest this change",
        enabled: selection != currentThreshold,
        icon: "person.2.fill"
      ) {
        dismiss()
        propose(selection)
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 20)
    }
    .prismScreen()
  }
}
