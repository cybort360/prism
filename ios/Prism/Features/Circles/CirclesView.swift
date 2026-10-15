import SwiftUI

/// The Circles tab — the full shared-money surface.
///
/// Circles earns a top-level place because it is a whole product (create → members → contributions →
/// proposals/approvals → activity → close), not a Home card. Home keeps only a compact summary row
/// (`CirclesSummaryRow`) that taps here, so shared money stays visible next to personal money without
/// the two surfaces duplicating each other.
struct CirclesView: View {
  @EnvironmentObject private var model: AppModel
  @StateObject private var circles = CirclesHomeModel()

  var body: some View {
    VStack(spacing: 0) {
      header
      ScrollView(showsIndicators: false) {
        VStack(alignment: .leading, spacing: 0) {
          if let unavailable = circles.unavailable {
            ErrorBanner(message: unavailable).padding(.top, 14)
          }
          // Reuse the exact list/invitations/empty-state/New-Circle rendering; the screen supplies
          // its own title, so the section hides its inline label.
          CirclesHomeSection(circles: circles, showsHeader: false).padding(.top, 8)
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 28)
      }
      .refreshable { await circles.reload() }
    }
    .task { await circles.reload() }
    // Returning from a Circle (opened or just created) refetches so a balance is never stale.
    .onChange(of: model.presentCircleDetail) { old, new in
      if old != nil && new == nil { Task { await circles.reload() } }
    }
    .onChange(of: model.presentCircleCreate) { old, new in
      if old && !new { Task { await circles.reload() } }
    }
    .prismScreen()
  }

  private var header: some View {
    HStack {
      Text("Circles").font(PrismTheme.display(38)).tracking(-0.7)
      Spacer()
      if circles.loading && !circles.summaries.isEmpty {
        ProgressView().controlSize(.small).tint(PrismTheme.mintDeep)
      }
    }
    .padding(.horizontal, 22)
    .padding(.top, 12)
    .padding(.bottom, 8)
  }
}

/// Home's compact Circles entry. It states the two facts worth glancing at — how many Circles and
/// what they hold — and taps into the Circles tab. It never carries the create flow itself; that lives
/// in the tab, so Home and the tab don't compete.
struct CirclesSummaryRow: View {
  @EnvironmentObject private var model: AppModel
  @ObservedObject var circles: CirclesHomeModel

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrismSectionLabel(text: "Circles")

      Button {
        PrismHaptics.selection()
        model.selectedTab = .circles
      } label: {
        PrismCard(padding: 15) {
          HStack(spacing: 13) {
            ZStack {
              Circle().fill(PrismTheme.mintSoft).frame(width: 44, height: 44)
              Image(systemName: "circlebadge.2")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(PrismTheme.mintDeep)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
              Text(title).font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.ink)
              Text(subtitle).font(PrismTheme.body(11.5)).foregroundStyle(subtitleTone)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 6)

            if let total { Text(total).font(PrismTheme.body(15, weight: .semibold)).monospacedDigit() }
            Image(systemName: "chevron.right")
              .font(.system(size: 10, weight: .semibold)).foregroundStyle(PrismTheme.faint)
          }
        }
      }
      .buttonStyle(.plainHit)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(accessibilityLine)
      .accessibilityHint("Opens Circles")
      .accessibilityAddTraits(.isButton)
    }
  }

  private var hasCircles: Bool { !circles.summaries.isEmpty }
  private var inviteCount: Int { circles.invitations.count }

  private var title: String { hasCircles ? "Circles" : "Start a Circle" }

  private var subtitle: String {
    if inviteCount > 0 {
      return "\(inviteCount) invitation\(inviteCount == 1 ? "" : "s") waiting"
    }
    if hasCircles {
      let n = circles.summaries.count
      return "\(n) \(n == 1 ? "Circle" : "Circles")"
    }
    return "Shared money you look after with people you trust"
  }

  private var subtitleTone: Color { inviteCount > 0 ? PrismTheme.amber : PrismTheme.muted }

  /// The summed balance of the Circles whose balance has been read. A dash, never a stale or partial
  /// number: shown only when every listed Circle's balance is known.
  private var total: String? {
    guard hasCircles else { return nil }
    var sum = 0
    for s in circles.summaries {
      guard let b = circles.details[s.circleId]?.balance, b.isKnown, let atomic = b.amountAtomic,
            let v = Int(atomic) else { return nil }
      sum += v
    }
    return Money.dollars(fromAtomic: String(sum))
  }

  private var accessibilityLine: String {
    if !hasCircles { return "Start a Circle. Shared money you look after with people you trust." }
    var parts = ["Circles", subtitle]
    if let total { parts.append(total) }
    return parts.joined(separator: ", ")
  }
}
