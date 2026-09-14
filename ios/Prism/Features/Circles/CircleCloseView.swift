import SwiftUI

/// Closing a Circle.
///
/// The screen exists to hold one refusal honestly: **Prism does not decide where a shared balance
/// goes.** A Circle holding money cannot be closed at all — it can only be emptied first, by the
/// same approvals it has always used, to someone its members choose. There is no "split it evenly"
/// button here and there never will be, because an even split is a guess about an agreement Prism
/// was not party to.
///
/// Everything shown is a live read, re-fetched each time this opens: what is still open, who can
/// still spend, what is still in the account, and whether the Safe could be read at all. A blocker
/// Prism could not check is still a blocker — "we couldn't tell" is never treated as "it's fine".
struct CircleCloseView: View {
  let circleId: String
  let circleName: String
  let reload: () async -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var state: CircleCloseState?
  @State private var reason = ""
  @State private var loading = true
  @State private var busy = false
  @State private var error: String?
  @State private var confirmingFinal = false

  private var isClosing: Bool { state?.status == "CLOSING" }
  private var isClosed: Bool { state?.status == "CLOSED" }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        if loading && state == nil {
          PrismLoadingRow().padding(.top, 40)
        } else if let state {
          headline(state)
          if isClosed {
            closedSummary(state)
          } else {
            checklist(state)
            if !isClosing { reasonField.padding(.top, 26) }
            actions(state).padding(.top, 26)
          }
        } else {
          EmptyStateView(icon: "wifi.exclamationmark", title: "Couldn't check this Circle",
                         bodyText: "Prism has to read Monad before it can close a Circle. Try again in a moment.")
            .padding(.top, 40)
        }
        if let error { ErrorBanner(message: error).padding(.top, 18) }
        keepsHistory.padding(.top, 30)
      }
      .padding(.horizontal, 22)
      .padding(.top, 10)
      .padding(.bottom, 40)
    }
    .prismScreen()
    .navigationTitle("Close this Circle")
    .navigationBarTitleDisplayMode(.inline)
    .task { await refresh() }
    .refreshable { await refresh() }
    .alert("Close \(circleName)?", isPresented: $confirmingFinal) {
      Button("Cancel", role: .cancel) {}
      Button("Close it", role: .destructive) { Task { await finalize() } }
    } message: {
      Text("The Circle stops being usable. Everything that happened in it stays readable afterwards: every payment, receipt and approval.")
    }
  }

  // MARK: what is true right now

  private func headline(_ state: CircleCloseState) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(headlineTitle(state))
        .font(PrismTheme.display(26))
        .fixedSize(horizontal: false, vertical: true)
      Text(headlineBody(state))
        .font(PrismTheme.body(13.5))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.top, 8)
  }

  private func headlineTitle(_ state: CircleCloseState) -> String {
    if isClosed { return "This Circle is closed" }
    if state.canClose { return "Ready to close" }
    return "Not ready to close"
  }

  private func headlineBody(_ state: CircleCloseState) -> String {
    if isClosed { return "Its history stays here. Nothing else can be added, paid or approved." }
    if state.canClose {
      return isClosing
        ? "Everything is settled. Closing ends the Circle in Prism, but the record stays."
        : "Nothing is left open. Start closing when you're ready."
    }
    return "These have to be settled first. Prism won't close a Circle while something is still unresolved."
  }

  /// Each requirement, said as a person would say it, with the blockers' own words underneath.
  private func checklist(_ state: CircleCloseState) -> some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "Before it can close").padding(.top, 26)
      VStack(spacing: 0) {
        ForEach(Array(state.requirements.enumerated()), id: \.offset) { idx, code in
          let blocker = state.blockers.first { $0.code == code }
          let ok = state.checks.first { $0.code == code }?.ok ?? (blocker == nil)
          CircleCloseRow(
            title: blocker?.title ?? satisfiedTitle(code, state: state),
            detail: blocker?.detail,
            done: ok && blocker == nil)
          if idx < state.requirements.count - 1 { Divider().overlay(PrismTheme.line) }
        }
      }
      .padding(.horizontal, 16)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))

      // The one blocker that is a decision rather than a task.
      if let funds = state.fundsBlocker, funds.requiresExplicitDecision == true {
        VStack(alignment: .leading, spacing: 8) {
          Text("Where does the \(funds.balanceDisplay ?? "money") go?")
            .font(PrismTheme.body(14, weight: .semibold))
          Text("That's the Circle's decision, not Prism's. Send it out the way you send anything else, with the admins approving together, then come back here.")
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(15)
        .background(PrismTheme.ice)
        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
      }
    }
  }

  private func satisfiedTitle(_ code: String, state: CircleCloseState) -> String {
    switch code {
    case "OPEN_PROPOSALS": "Nothing is waiting for approval"
    case "SPENDING_ACCESS": "Nobody can still spend from it"
    case "REMAINING_FUNDS": "The account is empty"
    case "CHAIN_RECONCILED": "Checked against Monad"
    default: code
    }
  }

  private var reasonField: some View {
    VStack(alignment: .leading, spacing: 8) {
      PrismSectionLabel(text: "Why (optional)")
      TextField("The trip is over", text: $reason, axis: .vertical)
        .font(PrismTheme.body(14))
        .padding(14)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
      Text("Kept with the Circle's record, so the reason is still there later.")
        .font(PrismTheme.body(11.5))
        .foregroundStyle(PrismTheme.muted)
    }
  }

  private func actions(_ state: CircleCloseState) -> some View {
    VStack(spacing: 12) {
      if isClosing {
        PrismPrimaryButton(title: "Close \(circleName)", icon: "archivebox") { confirmingFinal = true }
          .disabled(!state.canClose || busy)
          .opacity(state.canClose && !busy ? 1 : 0.5)
        Button("Keep it open") { Task { await cancelClosing() } }
          .font(PrismTheme.body(14, weight: .semibold))
          .foregroundStyle(PrismTheme.ink)
          .disabled(busy)
      } else {
        PrismPrimaryButton(title: "Start closing", icon: "arrow.down.circle") { Task { await begin() } }
          .disabled(busy)
          .opacity(busy ? 0.5 : 1)
        Text("Money can still be paid out while a Circle is closing. That's how the balance leaves, and nothing more can be added to it.")
          .font(PrismTheme.body(11.5))
          .foregroundStyle(PrismTheme.muted)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func closedSummary(_ state: CircleCloseState) -> some View {
    VStack(alignment: .leading, spacing: 11) {
      PrismSectionLabel(text: "Closed").padding(.top, 26)
      if let at = state.closing?.finalizedAt, let date = Date.prismParse(at) {
        Text(date.formatted(date: .long, time: .shortened))
          .font(PrismTheme.body(13.5))
      }
      if let reason = state.closing?.reason {
        Text(reason).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted)
      }
    }
  }

  private var keepsHistory: some View {
    VStack(alignment: .leading, spacing: 9) {
      PrismSectionLabel(text: "What closing does")
      Text("Closing ends the Circle, not its record. Every payment, every receipt and every approval stays exactly where it is, and the account on Monad keeps its own history whatever Prism shows. Prism never deletes a Circle's past, and never decides on its own where shared money goes.")
        .font(PrismTheme.body(12))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: actions

  private func refresh() async {
    loading = true
    defer { loading = false }
    do { state = try await PrismAPI.shared.circleCloseState(circleId); error = nil }
    catch { self.error = error.localizedDescription }
  }

  private func begin() async {
    busy = true
    defer { busy = false }
    do {
      state = try await PrismAPI.shared.beginCircleClose(circleId, reason: reason.isEmpty ? nil : reason)
      error = nil
      await reload()
    } catch { self.error = error.localizedDescription }
  }

  private func cancelClosing() async {
    busy = true
    defer { busy = false }
    do {
      _ = try await PrismAPI.shared.cancelCircleClose(circleId)
      await refresh()
      await reload()
    } catch { self.error = error.localizedDescription }
  }

  /// The balance the user was shown goes back with the request. If Monad now says something else,
  /// the backend refuses — and it is right to: the screen they agreed to is not this Circle.
  private func finalize() async {
    guard let balance = state?.balance?.amountAtomic else {
      error = "Prism couldn't read the balance just now, so it won't close this Circle yet."
      return
    }
    busy = true
    defer { busy = false }
    do {
      state = try await PrismAPI.shared.finalizeCircleClose(circleId, balanceAtomic: balance)
      error = nil
      await reload()
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

private struct CircleCloseRow: View {
  let title: String
  let detail: String?
  let done: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: done ? "checkmark.circle.fill" : "circle")
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(done ? PrismTheme.positive : PrismTheme.muted)
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(PrismTheme.body(13.5, weight: done ? .regular : .medium))
          .fixedSize(horizontal: false, vertical: true)
        if let detail {
          Text(detail)
            .font(PrismTheme.body(12))
            .foregroundStyle(PrismTheme.muted)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 13)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(done ? "Done" : "Still to do"): \(title). \(detail ?? "")")
  }
}
