import SwiftUI
import UIKit

/// A Circle's icon. Renders the stored SF Symbol when it names a real symbol; otherwise the first
/// letter of the Circle's name. (A legacy emoji value therefore falls back to the initial rather than
/// rendering as a broken glyph.)
struct CircleGlyph: View {
  let icon: String?
  let name: String
  var size: CGFloat = 18
  var color: Color = PrismTheme.mintDeep

  var body: some View {
    if let icon, !icon.isEmpty, UIImage(systemName: icon) != nil {
      Image(systemName: icon).font(.system(size: size, weight: .medium)).foregroundStyle(color)
    } else {
      Text(String(name.prefix(1)).uppercased()).font(PrismTheme.body(size, weight: .semibold)).foregroundStyle(color)
    }
  }
}

/// Circles on Home.
///
/// Circles deliberately do not get their own tab. A Circle is money, and money lives on Home
/// alongside the person's own balance — putting it behind a fifth tab would file shared money as a
/// separate product rather than another place their money sits.
///
/// Each row shows the two facts that make a Circle recognizable at a glance: what it holds and how
/// many people are in it. Both come from a live read, so a row whose chain read failed shows an
/// honest dash rather than a number it cannot stand behind.
struct CirclesHomeSection: View {
  @EnvironmentObject private var model: AppModel
  @ObservedObject var circles: CirclesHomeModel
  /// The Circles tab supplies its own screen title, so it hides this inline "Circles" label to avoid
  /// showing the word twice.
  var showsHeader = true

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if showsHeader {
        HStack {
          PrismSectionLabel(text: "Circles")
          Spacer()
          if circles.loading && !circles.summaries.isEmpty {
            ProgressView().controlSize(.small).tint(PrismTheme.mintDeep)
          }
        }
      }

      if !circles.invitations.isEmpty {
        VStack(spacing: 9) {
          ForEach(circles.invitations) { invitation in
            CircleInvitationCard(invitation: invitation) { await circles.reload() }
          }
        }
      }

      if circles.summaries.isEmpty {
        if circles.loading {
          PrismCard(padding: 16) { PrismLoadingRow() }
        } else {
          PrismCard(padding: 6) {
            CircleStateView(state: .noCircles, action: { model.presentCircleCreate = true }, compact: true)
          }
        }
      } else {
        VStack(spacing: 9) {
          ForEach(circles.summaries) { summary in
            Button {
              model.presentCircleDetail = summary
            } label: {
              CircleRow(summary: summary, detail: circles.details[summary.circleId])
            }
            .buttonStyle(.plain)
          }
        }
      }

      // The persistent "New Circle" button is the create affordance only when a list is shown; the
      // empty state carries its own CTA, so showing both would be a duplicate call to action.
      if !circles.summaries.isEmpty {
        Button {
          model.presentCircleCreate = true
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "plus").font(.system(size: 13, weight: .semibold))
            Text("New Circle").font(PrismTheme.body(14, weight: .semibold))
          }
          .foregroundStyle(PrismTheme.mintDeep)
          .frame(maxWidth: .infinity)
          .frame(height: 48)
          .background(PrismTheme.mintSoft)
          .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Create a new Circle")
      }
    }
  }
}

/// One Circle in the Home list.
private struct CircleRow: View {
  let summary: CircleSummary
  let detail: CircleDetail?
  @ScaledMetric(relativeTo: .body) private var avatar: CGFloat = 44

  var body: some View {
    PrismCard(padding: 14) {
      HStack(spacing: 13) {
        ZStack {
          Circle().fill(PrismTheme.mintSoft).frame(width: avatar, height: avatar)
          CircleGlyph(icon: summary.icon, name: summary.name, size: avatar * 0.42)
        }
        .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 7) {
            Text(summary.name)
              .font(PrismTheme.body(15, weight: .semibold))
              .lineLimit(1)
            if let status = CircleVocabulary.circleStatus(summary) {
              CircleStatusBadge(text: status.text, tone: status.tone, symbol: status.symbol)
            }
          }
          Text(peopleLine)
            .font(PrismTheme.body(11.5))
            .foregroundStyle(PrismTheme.muted)
        }

        Spacer(minLength: 6)

        VStack(alignment: .trailing, spacing: 3) {
          Text(balanceLine)
            .font(PrismTheme.body(15, weight: .semibold))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.8)
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(PrismTheme.faint)
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLine)
    .accessibilityHint("Opens this Circle")
    .accessibilityAddTraits(.isButton)
  }

  /// A dash, never a stale number: the balance is a chain fact and an unread one is unknown.
  private var balanceLine: String {
    guard let balance = detail?.balance else { return "-" }
    guard balance.isKnown, let atomic = balance.amountAtomic else { return "-" }
    return Money.assetAmount(fromAtomic: atomic, decimals: balance.decimals ?? 6)
  }

  private var peopleCount: Int? {
    detail?.members?.filter { $0.status != "REMOVED" && $0.status != "LEFT" }.count
  }

  private var peopleLine: String {
    guard let count = peopleCount else { return "…" }
    return "\(count) \(count == 1 ? "person" : "people")"
  }

  private var accessibilityLine: String {
    var parts = [summary.name]
    if let status = CircleVocabulary.circleStatus(summary) { parts.append(status.text) }
    parts.append(balanceLine == "-" ? "balance unavailable" : balanceLine)
    if let count = peopleCount { parts.append("\(count) \(count == 1 ? "person" : "people")") }
    return parts.joined(separator: ", ")
  }
}

/// An invitation waiting on Home.
///
/// Accepting is not a neutral act — it can be the first step toward holding financial authority —
/// so the card names who is asking and what the role means before either button.
private struct CircleInvitationCard: View {
  let invitation: CircleInvitation
  let reload: () async -> Void
  @EnvironmentObject private var model: AppModel
  @State private var busy = false
  @State private var error: String?

  private var role: CircleVocabulary.Role { .init(wire: invitation.role) }

  var body: some View {
    PrismCard(padding: 15) {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 11) {
          ZStack {
            Circle().fill(PrismTheme.mintSoft).frame(width: 38, height: 38)
            Image(systemName: "envelope.fill")
              .font(.system(size: 14, weight: .medium))
              .foregroundStyle(PrismTheme.mintDeep)
          }
          .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 3) {
            Text(headline)
              .font(PrismTheme.body(14, weight: .semibold))
              .fixedSize(horizontal: false, vertical: true)
            Text(role.consequence)
              .font(PrismTheme.body(11.5))
              .foregroundStyle(PrismTheme.muted)
              .lineSpacing(2)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 0)
        }

        if let error { ErrorBanner(message: error) }

        HStack(spacing: 9) {
          Button("Decline") { Task { await respond(accept: false) } }
            .font(PrismTheme.body(13.5, weight: .semibold))
            .foregroundStyle(PrismTheme.muted)
            .frame(maxWidth: .infinity).frame(height: 44)
            .background(PrismTheme.canvas)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          Button("Join") { Task { await respond(accept: true) } }
            .font(PrismTheme.body(13.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity).frame(height: 44)
            .background(PrismTheme.mintDeep)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .opacity(busy ? 0.5 : 1)
      }
    }
    .accessibilityElement(children: .contain)
  }

  private var headline: String {
    let who = invitation.invitedBy ?? "Someone"
    let what = invitation.circleName ?? "a Circle"
    return "\(who) invited you to \(what)"
  }

  private func respond(accept: Bool) async {
    busy = true
    defer { busy = false }
    do {
      if accept {
        let result = try await PrismAPI.shared.acceptCircleInvitation(
          circleId: invitation.circleId, inviteId: invitation.inviteId)
        // An admin invitation makes someone a member now and an admin later. `note` is the backend's
        // own sentence saying so, and it is shown rather than smoothed over.
        model.notify(result.note ?? "You've joined \(invitation.circleName ?? "the Circle")")
      } else {
        _ = try await PrismAPI.shared.declineCircleInvitation(
          circleId: invitation.circleId, inviteId: invitation.inviteId)
      }
      await reload()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// Home's Circle data, held outside the view so a refresh survives the section being rebuilt.
///
/// The list call is cheap and reads no chain state. The balance and the member count do, so they
/// arrive per-Circle afterwards and the row renders honestly while they are missing. A Circle still
/// being created is refreshed by the same call that reads it — `circle(_:)` advances creation — so
/// simply looking at Home is enough to move a pending Circle along.
@MainActor
final class CirclesHomeModel: ObservableObject {
  @Published private(set) var summaries: [CircleSummary] = []
  @Published private(set) var details: [String: CircleDetail] = [:]
  @Published private(set) var invitations: [CircleInvitation] = []
  @Published private(set) var loading = false
  @Published private(set) var unavailable: String?

  /// How many Circles get a live chain read on a Home refresh. Beyond this the rows still appear —
  /// with an honest dash — and fill in when the Circle is opened.
  private let liveReadLimit = 6

  func reload() async {
    loading = true
    defer { loading = false }
    do {
      async let list = PrismAPI.shared.circles()
      async let invites = PrismAPI.shared.myCircleInvitations()
      summaries = try await list
      invitations = (try? await invites) ?? []
      unavailable = nil
    } catch {
      unavailable = error.localizedDescription
      return
    }

    await withTaskGroup(of: (String, CircleDetail?).self) { group in
      for summary in summaries.prefix(liveReadLimit) {
        group.addTask {
          (summary.circleId, try? await PrismAPI.shared.circle(summary.circleId))
        }
      }
      for await (id, detail) in group where detail != nil {
        details[id] = detail
      }
    }
  }

  /// Whether anything in Circles wants the person's attention — feeds Home's notification dot.
  var needsAttention: Bool { !invitations.isEmpty }
}
