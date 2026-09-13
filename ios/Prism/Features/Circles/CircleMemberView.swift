import SwiftUI

/// One member of a Circle.
///
/// The screen's job is to answer "what can this person do with our money", and to be exact about
/// where each answer comes from. Two of the rows are Prism facts that an admin can change here and
/// now. Two are chain facts that nobody can change here at all — admin authority and a spending
/// limit both live on Monad, and the only honest control for them is one that starts a change the
/// Circle has to approve. Mixing those together behind identical-looking toggles is how a person
/// ends up believing they revoked something they did not.
struct CircleMemberView: View {
  let circleId: String
  let circleName: String
  let member: CircleMember
  let limit: CircleSpendingLimit?
  let reload: () async -> Void

  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var role: CircleVocabulary.Role
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var confirmingRemoval = false
  @State private var pendingChange: CircleGovernanceProposal?

  init(circleId: String, circleName: String, member: CircleMember, limit: CircleSpendingLimit?, reload: @escaping () async -> Void) {
    self.circleId = circleId
    self.circleName = circleName
    self.member = member
    self.limit = limit
    self.reload = reload
    _role = State(initialValue: CircleVocabulary.Role(wire: member.role))
  }

  private var isMe: Bool { member.prismId == model.identity?.prismId }
  private var displayName: String { member.displayName ?? member.handle ?? "A member" }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        identity
        permissions.padding(.top, 30)
        if let limit, limit.hasSpendingAccess { spendingCard(limit).padding(.top, 22) }
        if let notice { SuccessBanner(message: notice).padding(.top, 18) }
        if let error { ErrorBanner(message: error).padding(.top, 18) }
        adminActions.padding(.top, 30)
      }
      .padding(.horizontal, 22)
      .padding(.top, 10)
      .padding(.bottom, 36)
    }
    .prismScreen()
    .navigationTitle(displayName)
    .navigationBarTitleDisplayMode(.inline)
    .sheet(item: $pendingChange) { proposal in
      CircleGovernanceApprovalView(proposal: proposal, detail: nil) { await reload() }
    }
    .alert("Remove \(displayName)?", isPresented: $confirmingRemoval) {
      Button("Remove", role: .destructive) { Task { await remove() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("They'll lose access to \(circleName) and stop seeing what moves in it. Money they already added stays in the Circle.")
    }
  }

  private var identity: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 14) {
        PrismAvatar(initials: initials, size: 60)
        VStack(alignment: .leading, spacing: 4) {
          Text(isMe ? "\(displayName) (you)" : displayName)
            .font(PrismTheme.body(19, weight: .semibold))
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
          if let handle = member.handle {
            Text(handle).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
          }
          if let joined = joinedLine {
            Text(joined).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
          }
        }
        Spacer()
      }
      let status = CircleVocabulary.memberStatus(member)
      CircleStatusBadge(text: status.text, tone: status.tone, symbol: status.symbol)
    }
  }

  private var joinedLine: String? {
    guard let joined = member.joinedAt.flatMap(Date.prismParse) else { return nil }
    return "Member since \(joined.formatted(.dateTime.month(.abbreviated).day()))"
  }

  private var initials: String {
    let source = member.displayName ?? member.handle?.replacingOccurrences(of: "@", with: "") ?? "?"
    let value = source.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    return value.isEmpty ? "?" : value
  }

  // MARK: permissions

  private var permissions: some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "Permissions")
      VStack(spacing: 0) {
        permissionRow("Can add money", value: canContribute ? "Yes" : "No", tone: canContribute ? .positive : .neutral)
        Divider().overlay(PrismTheme.line)
        permissionRow("Can suggest payments", value: canContribute ? "Yes" : "No", tone: canContribute ? .positive : .neutral)
        Divider().overlay(PrismTheme.line)
        permissionRow("Can spend on their own", value: spendValue, tone: limit?.hasSpendingAccess == true ? .positive : .neutral)
        Divider().overlay(PrismTheme.line)
        permissionRow("Admin", value: adminValue, tone: isConfirmedAdmin ? .positive : .neutral)
      }
      .padding(.horizontal, 15)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
    }
  }

  private var canContribute: Bool { [.admin, .spender, .contributor].contains(role) }
  private var isConfirmedAdmin: Bool { role == .admin && member.authorityConfirmedOnChain == true }

  private var spendValue: String {
    guard let limit, limit.hasSpendingAccess else { return "No" }
    return limit.summary
  }

  private var adminValue: String {
    guard role == .admin else { return "No" }
    return member.authorityConfirmedOnChain == true ? "Yes" : "Waiting on the Circle"
  }

  private func permissionRow(_ label: String, value: String, tone: CircleTone) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label).font(PrismTheme.body(13.5))
      Spacer(minLength: 8)
      Text(value)
        .font(PrismTheme.body(13.5, weight: .semibold))
        .foregroundStyle(tone == .positive ? PrismTheme.mintDeep : PrismTheme.ink)
        .multilineTextAlignment(.trailing)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 14)
    .accessibilityElement(children: .combine)
  }

  /// The three numbers, straight from the module. Never summed from Prism's activity.
  private func spendingCard(_ limit: CircleSpendingLimit) -> some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "Spending limit")
      CircleLimitStrip(limit: limit)
      Text("These come from the Circle's spending contract on Monad, not from Prism's records.")
        .font(PrismTheme.body(11.5))
        .foregroundStyle(PrismTheme.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: admin actions

  @ViewBuilder private var adminActions: some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "Admin actions")

      if role == .admin {
        // Both of an admin's controls are chain changes, so both say so before they are tapped.
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "info.circle.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(PrismTheme.pending)
            .accessibilityHidden(true)
          Text("\(displayName) is an admin, so what they can do is decided by the Circle. Changing it starts a change the other admins approve together — it doesn't take effect straight away.")
            .font(PrismTheme.body(12))
            .foregroundStyle(PrismTheme.muted)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PrismTheme.canvas)
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))

        actionButton("Remove as admin", symbol: "person.badge.minus", destructive: true) {
          Task { await proposeAdminRemoval() }
        }
      } else {
        VStack(alignment: .leading, spacing: 9) {
          Text("Change permissions")
            .font(PrismTheme.body(13.5, weight: .semibold))
          Picker("Permissions for \(displayName)", selection: $role) {
            ForEach(CircleVocabulary.Role.allCases.filter { $0 != .admin }) { option in
              Text(option.title).tag(option)
            }
          }
          .pickerStyle(.segmented)
          .disabled(busy)
          Text(role.consequence)
            .font(PrismTheme.body(12))
            .foregroundStyle(PrismTheme.muted)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
          if role != CircleVocabulary.Role(wire: member.role) {
            PrismPrimaryButton(title: "Save permissions", enabled: !busy) { Task { await saveRole() } }
          }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))

        actionButton("Make an admin", symbol: "person.badge.shield.checkmark", destructive: false) {
          Task { await proposeAdminAddition() }
        }

        if !isMe {
          actionButton("Remove from Circle", symbol: "person.badge.minus", destructive: true) {
            confirmingRemoval = true
          }
        }
      }
    }
    .opacity(busy ? 0.55 : 1)
  }

  private func actionButton(_ title: String, symbol: String, destructive: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: symbol).font(.system(size: 14, weight: .semibold))
        Text(title).font(PrismTheme.body(14, weight: .semibold))
        Spacer()
        if busy { ProgressView().controlSize(.small) }
      }
      .foregroundStyle(destructive ? PrismTheme.danger : PrismTheme.ink)
      .padding(.horizontal, 16)
      .frame(height: 54)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
    }
    .buttonStyle(.plain)
    .disabled(busy)
  }

  // MARK: actions

  private func saveRole() async {
    busy = true
    defer { busy = false }
    error = nil; notice = nil
    do {
      _ = try await PrismAPI.shared.setCircleMemberRole(
        circleId: circleId, prismId: member.prismId, role: role.rawValue)
      notice = "\(displayName) can now \(role.title.lowercased())."
      await reload()
    } catch {
      // The backend refuses a role change that would strand a live spending allowance. That refusal
      // is the useful message, so it is shown as-is rather than replaced with something generic.
      self.error = error.localizedDescription
      role = CircleVocabulary.Role(wire: member.role)
    }
  }

  private func remove() async {
    busy = true
    defer { busy = false }
    error = nil
    do {
      _ = try await PrismAPI.shared.removeCircleMember(circleId: circleId, prismId: member.prismId)
      await reload()
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Admin authority is a chain fact, so this starts a change the Circle approves — it does not
  /// grant anything, and the sheet that follows says so.
  private func proposeAdminAddition() async {
    busy = true
    defer { busy = false }
    error = nil
    do {
      pendingChange = try await PrismAPI.shared.prepareAddCircleAdmin(
        circleId: circleId, prismId: member.prismId, handle: nil, threshold: nil)
    } catch { self.error = error.localizedDescription }
  }

  private func proposeAdminRemoval() async {
    busy = true
    defer { busy = false }
    error = nil
    do {
      pendingChange = try await PrismAPI.shared.prepareRemoveCircleAdmin(
        circleId: circleId, prismId: member.prismId, threshold: nil)
    } catch {
      // Removing an admin can force the approval rule down with it, and the backend refuses to pick
      // a weaker rule on the Circle's behalf. Its message names the number that would be needed.
      self.error = error.localizedDescription
    }
  }
}
