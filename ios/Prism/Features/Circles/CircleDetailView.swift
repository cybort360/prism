import SwiftUI

/// A Circle, opened.
///
/// The order of this screen is an argument about what a shared account is for. The balance is
/// first because it is the question everyone opens the app to answer. **Needs your approval** is
/// second, above everything else, because it is the only thing on the screen that is waiting on
/// this person. Activity is third because it is what makes a shared account trustworthy — everyone
/// sees the same list. Members are last: they change rarely, and changing them is a governed act.
///
/// Nothing here invents a number. The balance, the approval counts and the member authorities are
/// all chain facts read live, and each renders as "unknown" rather than stale when Monad cannot be
/// reached. That is why the header can show a dash: a dash is true, and a remembered balance is not.
struct CircleDetailView: View {
  let summary: CircleSummary
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var circle = CircleDetailModel()

  var body: some View {
    NavigationStack(path: $circle.route) {
      ScrollView(showsIndicators: false) {
        VStack(alignment: .leading, spacing: 0) {
          header
          if let state = circle.blockingState(failureReason: summary.failureReason) {
            // A Circle that is not usable yet says so instead of showing an empty, tappable shell.
            CircleStateView(state: state, action: { Task { await circle.reload() } })
              .padding(.top, 22)
          } else {
            actions.padding(.top, 26)
            pendingSection
            activitySection
            membersSection
          }
          if let error = circle.error {
            ErrorBanner(message: error).padding(.top, 20)
          }
          settingsLink.padding(.top, 26)
        }
        .padding(.horizontal, 22)
        .padding(.top, 8)
        .padding(.bottom, 34)
      }
      .prismScreen()
      .toolbar(.hidden, for: .navigationBar)
      .refreshable { await circle.reload() }
      .navigationDestination(for: CircleDetailRoute.self) { route in
        switch route {
        case .member(let member):
          CircleMemberView(circleId: summary.circleId, circleName: circle.name(fallback: summary.name), member: member, limit: circle.limit(for: member.prismId)) {
            await circle.reload()
          }
        case .settings:
          CircleSettingsView(circleId: summary.circleId, detail: circle.detail, summary: summary) {
            await circle.reload()
          }
        case .close:
          CircleCloseView(circleId: summary.circleId, circleName: circle.name(fallback: summary.name)) {
            await circle.reload()
          }
        case .invite:
          CircleInviteView(circleId: summary.circleId, circleName: circle.name(fallback: summary.name), limitsEnabled: circle.limitsEnabled) {
            await circle.reload()
          }
        }
      }
    }
    // Presented from here rather than from the app shell, because these are all about *this*
    // Circle and presenting them one level up would put a sheet over a sheet.
    .sheet(item: $model.presentCircleAddMoney) { target in CircleAddMoneyView(circle: target) }
    .sheet(item: $model.presentCirclePay) { target in CirclePayView(target: target) }
    .sheet(item: $model.presentCircleWithdraw) { target in CircleWithdrawView(circle: target) }
    .sheet(item: $model.presentCircleApproval) { item in CircleApprovalView(presentation: item) }
    .sheet(item: $circle.governanceUnderReview) { proposal in
      CircleGovernanceApprovalView(proposal: proposal, detail: circle.detail) { await circle.reload() }
    }
    .sheet(isPresented: $circle.payPickerPresented) {
      PersonPickerView(mode: .circlePay(circleId: summary.circleId, circleName: circle.name(fallback: summary.name)))
    }
    .task(id: summary.circleId) {
      // Who "you" are decides which approvals are yours to give, so it is set before the first read.
      circle.setMe(model.identity?.prismId)
      await circle.start(circleId: summary.circleId)
    }
    // Coming back from any of the money sheets refetches, so a balance or an approval count is
    // never left showing the value it had before the thing that just happened.
    .onChange(of: model.presentCircleAddMoney) { old, new in if old != nil && new == nil { Task { await circle.reload() } } }
    .onChange(of: model.presentCirclePay) { old, new in if old != nil && new == nil { Task { await circle.reload() } } }
    .onChange(of: model.presentCircleWithdraw) { old, new in if old != nil && new == nil { Task { await circle.reload() } } }
    .onChange(of: model.presentCircleApproval) { old, new in if old != nil && new == nil { Task { await circle.reload() } } }
  }

  // MARK: header

  private var header: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        PrismHeaderIconButton(icon: "chevron.down") { dismiss() }
          .accessibilityLabel("Close this Circle")
        Spacer()
        NavigationLink(value: CircleDetailRoute.settings) {
          Image(systemName: "gearshape")
            .font(.system(size: 16, weight: .medium))
            .frame(width: 42, height: 42)
            .background(PrismTheme.paper)
            .clipShape(Circle())
            .overlay(Circle().stroke(PrismTheme.line, lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Circle settings")
      }
      .padding(.top, 6)

      HStack(spacing: 12) {
        ZStack {
          Circle().fill(PrismTheme.mintSoft).frame(width: 46, height: 46)
          CircleGlyph(icon: summary.icon, name: summary.name, size: 19)
        }
        .accessibilityHidden(true)
        Text(circle.name(fallback: summary.name).uppercased())
          .font(PrismTheme.body(13, weight: .semibold))
          .tracking(1.5)
          .lineLimit(2)
        Spacer()
      }
      .padding(.top, 24)

      AmountText(dollars: circle.balanceLine, size: 58)
        .padding(.top, 12)
        .accessibilityLabel(circle.balanceAccessibilityLine)

      HStack(spacing: 9) {
        Text(circle.peopleLine)
          .font(PrismTheme.body(13))
          .foregroundStyle(PrismTheme.muted)
        if let status = CircleVocabulary.circleStatus(summary) {
          CircleStatusBadge(text: status.text, tone: status.tone, symbol: status.symbol)
        }
        if circle.balanceUnavailable {
          CircleStatusBadge(text: "Balance unknown", tone: .waiting, symbol: "wifi.exclamationmark")
        }
      }
      .padding(.top, 7)
    }
  }

  private var actions: some View {
    HStack(spacing: 9) {
      CircleAction(icon: "plus", title: "Add money", enabled: circle.canContribute) {
        model.presentCircleAddMoney = summary
      }
      CircleAction(icon: "paperplane", title: "Pay", enabled: circle.canPropose) {
        circle.payPickerPresented = true
      }
      CircleAction(icon: "arrow.up.right", title: "Withdraw", enabled: circle.canWithdraw) {
        model.presentCircleWithdraw = summary
      }
      CircleAction(icon: "person.badge.plus", title: "Invite", enabled: circle.isAdmin) {
        circle.route.append(.invite)
      }
    }
  }

  // MARK: pending

  @ViewBuilder private var pendingSection: some View {
    let mine = circle.awaitingMyApproval
    let others = circle.pendingNotMine

    if !mine.isEmpty {
      VStack(alignment: .leading, spacing: 11) {
        PrismSectionLabel(text: "Needs your approval").padding(.top, 30)
        ForEach(mine) { item in pendingRow(item, needsMe: true) }
      }
    }
    if !others.isEmpty {
      VStack(alignment: .leading, spacing: 11) {
        PrismSectionLabel(text: mine.isEmpty ? "Pending" : "Also pending").padding(.top, 30)
        ForEach(others) { item in pendingRow(item, needsMe: false) }
      }
    }
    if mine.isEmpty && others.isEmpty && circle.isAdmin && circle.loaded {
      VStack(alignment: .leading, spacing: 11) {
        PrismSectionLabel(text: "Approvals").padding(.top, 30)
        PrismCard(padding: 8) { CircleStateView(state: .noPendingApprovals, compact: true) }
      }
    }
  }

  @ViewBuilder private func pendingRow(_ item: CirclePendingItem, needsMe: Bool) -> some View {
    if let payment = item.payment {
      CirclePendingCard(
        title: payment.memo?.isEmpty == false ? payment.memo! : payment.recipientLabel,
        amount: Money.assetAmount(fromAtomic: payment.amount ?? "0"),
        requester: circle.requesterLabel(payment.proposerPrismId, me: model.identity?.prismId),
        progress: payment.approvalProgress,
        state: payment.lifecycle,
        stale: payment.lifecycle == "EXPIRED" || payment.binding?.ok == false,
        actionTitle: needsMe ? "Review" : "View"
      ) {
        guard let detail = circle.detail else { return }
        model.presentCircleApproval = CircleApprovalPresentation(payment: payment, circle: detail)
      }
    } else if let governance = item.governance {
      CirclePendingCard(
        title: CircleVocabulary.governanceTitle(governance),
        amount: nil,
        requester: circle.requesterLabel(governance.proposerPrismId, me: model.identity?.prismId),
        progress: governance.approvalProgress,
        state: governance.state,
        stale: governance.isDead,
        actionTitle: needsMe ? "Review" : "View"
      ) {
        circle.governanceUnderReview = governance
      }
    }
  }

  // MARK: activity

  @ViewBuilder private var activitySection: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "Activity").padding(.top, 30)
      if circle.activity.isEmpty {
        if circle.loaded {
          PrismCard(padding: 8) {
            CircleStateView(state: .noBalance(circleName: circle.name(fallback: summary.name)),
                            action: { model.presentCircleAddMoney = summary }, compact: true)
          }
        } else {
          PrismCard(padding: 16) { PrismLoadingRow() }
        }
      } else {
        ForEach(circle.activity.prefix(circle.activityLimit)) { item in
          // A money line opens the ordinary Prism receipt — the same screen a personal payment
          // opens, with the Circle, who asked and who approved on it. A governance line is not a
          // payment and has nothing to open.
          if let paymentId = item.paymentId {
            Button {
              model.presentPaymentDetails = PaymentDetailsPresentation(operationId: paymentId)
            } label: {
              CircleActivityRow(item: item)
            }
            .buttonStyle(.plain)
          } else {
            CircleActivityRow(item: item)
          }
          Divider().overlay(PrismTheme.line)
        }
        if circle.activity.count > circle.activityLimit {
          Button("Show all \(circle.activity.count)") { circle.activityLimit = circle.activity.count }
            .font(PrismTheme.body(13, weight: .semibold))
            .foregroundStyle(PrismTheme.teal)
            .padding(.top, 10)
        }
        if circle.activityUnavailable {
          // Say what is missing rather than letting a money-only list imply nothing else happened.
          Text("Showing money only. Joins, removals and limit changes couldn't be loaded.")
            .font(PrismTheme.body(11.5))
            .foregroundStyle(PrismTheme.muted)
            .padding(.top, 8)
        }
      }
    }
  }

  // MARK: members

  @ViewBuilder private var membersSection: some View {
    VStack(alignment: .leading, spacing: 11) {
      HStack {
        PrismSectionLabel(text: "Members")
        Spacer()
        Text(circle.peopleLine)
          .font(PrismTheme.body(11.5))
          .foregroundStyle(PrismTheme.muted)
      }
      .padding(.top, 30)

      if circle.members.isEmpty {
        let invite: (() -> Void)? = circle.isAdmin ? { circle.route.append(.invite) } : nil
        PrismCard(padding: 8) {
          CircleStateView(state: .noMembers, action: invite, compact: true)
        }
      } else {
        ForEach(circle.members) { member in
          NavigationLink(value: CircleDetailRoute.member(member)) {
            CircleMemberRow(member: member, limit: circle.limit(for: member.prismId), isMe: member.prismId == model.identity?.prismId)
          }
          .buttonStyle(.plain)
          Divider().overlay(PrismTheme.line)
        }
      }
    }
  }

  private var settingsLink: some View {
    NavigationLink(value: CircleDetailRoute.settings) {
      HStack {
        Text("Settings").font(PrismTheme.body(14, weight: .semibold)).foregroundStyle(PrismTheme.ink)
        Spacer()
        Image(systemName: "arrow.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(PrismTheme.faint)
      }
      .padding(16)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
    }
    .buttonStyle(.plain)
  }
}

/// Where the detail screen can push to. Hashable so `navigationDestination(for:)` can route it.
enum CircleDetailRoute: Hashable {
  case member(CircleMember)
  case settings
  case invite
  /// Ending a Circle is its own screen, not a destructive button on Settings: it is a lifecycle
  /// with requirements to check, and one of them is a decision only the members can make.
  case close
}

// MARK: - rows

private struct CircleAction: View {
  let icon: String
  let title: String
  var enabled = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 8) {
        PrismIconTile(icon: icon)
        Text(title)
          .font(PrismTheme.body(11, weight: .medium))
          .foregroundStyle(PrismTheme.ink)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
      }
      .frame(maxWidth: .infinity)
      .opacity(enabled ? 1 : 0.4)
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityLabel(title)
    .accessibilityHint(enabled ? "" : "Not available to you in this Circle")
  }
}

private struct CirclePendingCard: View {
  let title: String
  let amount: String?
  let requester: String
  let progress: String?
  let state: String
  let stale: Bool
  let actionTitle: String
  let open: () -> Void

  var body: some View {
    PrismCard(padding: 15) {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 12) {
          VStack(alignment: .leading, spacing: 4) {
            Text(title)
              .font(PrismTheme.body(15, weight: .semibold))
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
            Text("Requested by \(requester)")
              .font(PrismTheme.body(11.5))
              .foregroundStyle(PrismTheme.muted)
          }
          Spacer(minLength: 8)
          if let amount {
            Text(amount)
              .font(PrismTheme.body(17, weight: .semibold))
              .monospacedDigit()
              .lineLimit(1)
              .minimumScaleFactor(0.8)
          }
        }

        HStack(spacing: 8) {
          let status = CircleVocabulary.paymentStatus(state)
          if stale {
            CircleStatusBadge(text: "Needs suggesting again", tone: .attention, symbol: "arrow.counterclockwise")
          } else if let progress {
            CircleStatusBadge(text: "\(progress) approvals", tone: .waiting, symbol: "clock.fill")
          } else {
            // The chain could not be read. Unknown is the honest answer; a remembered count is not.
            CircleStatusBadge(text: "Approvals unknown", tone: .waiting, symbol: "wifi.exclamationmark")
          }
          if !stale && status.text != "Waiting for approval" {
            CircleStatusBadge(text: status.text, tone: status.tone, symbol: status.symbol)
          }
          Spacer()
          Button(actionTitle, action: open)
            .font(PrismTheme.body(13, weight: .semibold))
            .foregroundStyle(PrismTheme.mintDeep)
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(accessibilityLine)
  }

  private var accessibilityLine: String {
    var parts = [title]
    if let amount { parts.append(amount) }
    parts.append("requested by \(requester)")
    if stale { parts.append("needs suggesting again") }
    else if let progress { parts.append("\(progress) approvals") }
    else { parts.append("approvals unknown") }
    return parts.joined(separator: ", ")
  }
}

struct CircleActivityRow: View {
  let item: CircleActivityItem

  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        Circle().fill(item.tone.wash).frame(width: 38, height: 38)
        Image(systemName: symbol)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(item.tone.color)
      }
      .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 3) {
        Text(item.title)
          .font(PrismTheme.body(14, weight: .medium))
          .lineLimit(1)
        Text(item.subtitle ?? item.status)
          .font(PrismTheme.body(11))
          .foregroundStyle(PrismTheme.muted)
          .lineLimit(1)
      }

      Spacer(minLength: 6)

      VStack(alignment: .trailing, spacing: 3) {
        // A governance line moves no money, so there is no amount — not a zero, which would read as
        // a payment of nothing.
        if item.movesMoney {
          Text(item.signedAmount)
            .font(PrismTheme.body(13.5, weight: .medium))
            .monospacedDigit()
            .foregroundStyle(item.incoming ? PrismTheme.positive : PrismTheme.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
        }
        // Status is text, never a bare coloured dot.
        Text(item.status)
          .font(PrismTheme.body(9.5))
          .foregroundStyle(PrismTheme.muted)
      }
    }
    .padding(.vertical, 11)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(item.movesMoney
      ? "\(item.title), \(item.incoming ? "received" : "paid") \(Money.assetAmount(fromAtomic: item.amountAtomic)), \(item.status)"
      : "\(item.title), \(item.status)")
  }

  private var symbol: String {
    switch item.kind {
    case .contribution: return "arrow.down"
    case .payment: return "arrow.up"
    case .spend: return "creditcard"
    // A governance line carries the symbol the feed chose for what changed.
    case .governance: return item.symbol
    }
  }
}

struct CircleMemberRow: View {
  let member: CircleMember
  let limit: CircleSpendingLimit?
  var isMe = false

  var body: some View {
    HStack(spacing: 12) {
      PrismAvatar(initials: initials, size: 42)
      VStack(alignment: .leading, spacing: 3) {
        Text(isMe ? "\(displayName) (you)" : displayName)
          .font(PrismTheme.body(14.5, weight: .semibold))
          .lineLimit(1)
        Text(secondary)
          .font(PrismTheme.body(11.5))
          .foregroundStyle(PrismTheme.muted)
          .lineLimit(1)
      }
      Spacer(minLength: 6)
      let status = CircleVocabulary.memberStatus(member)
      if status.text != "Active" {
        CircleStatusBadge(text: status.text, tone: status.tone, symbol: status.symbol)
      }
      Image(systemName: "chevron.right")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(PrismTheme.faint)
    }
    .padding(.vertical, 11)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(displayName)\(isMe ? ", you" : ""), \(secondary), \(CircleVocabulary.memberStatus(member).text)")
    .accessibilityHint("Opens this member")
    .accessibilityAddTraits(.isButton)
  }

  private var displayName: String {
    member.displayName ?? member.handle ?? "A member"
  }
  private var initials: String {
    let source = member.displayName ?? member.handle?.replacingOccurrences(of: "@", with: "") ?? "?"
    let value = source.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    return value.isEmpty ? "?" : value
  }
  private var secondary: String {
    if let limit, limit.hasSpendingAccess { return limit.summary }
    return CircleVocabulary.Role(wire: member.role).title
  }
}
