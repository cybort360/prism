import SwiftUI

/// PRISM Continuity Lab — a judge-visible, fixtures-only demonstration of the one invariant PRISM
/// protects: a mutable reachability alias must never silently change WHO gets paid. It runs two paths
/// over the same fixture identities (BASELINE: alias→account; PRISM: alias→PrismIdentity→account) and
/// shows the delta, then four attacks each stated EXPECTED / OBSERVED / PASS / evidence. The detectors
/// are the real product's verifiers; the server creates no payment state producing this report.
struct ContinuityLabView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var report: ContinuityLabReport?
  @State private var loading = true
  @State private var error: String?

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 18) {
        header
        if loading {
          ProgressView().frame(maxWidth: .infinity).padding(.top, 48)
        } else if let error {
          ErrorBanner(message: error)
        } else if let report {
          deltaCard(report.delta)
          scenarioCard(report.scenario)
          attacksCard(report.attacks, allPass: report.allAttacksPass)
          provenance(report)
        }
      }
      .padding(.horizontal, 22).padding(.top, 8).padding(.bottom, 36)
    }
    .background(PrismTheme.canvas.ignoresSafeArea())
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Continuity Lab").font(PrismTheme.display(28)).tracking(-0.4)
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      Text("A reassigned alias would silently redirect a normal payments app. PRISM decouples reachability from identity and blocks it. Fixtures only. No real money, no payment state.")
        .font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted).lineSpacing(2)
    }
    .padding(.top, 6)
  }

  // MARK: - The delta (the load-bearing visual)

  private func deltaCard(_ delta: ContinuityLabDelta) -> some View {
    PrismCard {
      VStack(alignment: .leading, spacing: 14) {
        PrismSectionLabel(text: "User pays the old contact (alias A, now reassigned)")

        pathRow(
          tag: "BASELINE", tagColor: PrismTheme.danger,
          model: delta.baseline.model,
          verdict: delta.baseline.blocked ? "BLOCKED" : "WOULD SEND",
          verdictColor: PrismTheme.danger,
          detail: delta.baseline.result)

        Divider().overlay(PrismTheme.line)

        // PRISM: PREVIOUSLY TRUSTED → CURRENT RESOLUTION → RESULT.
        VStack(alignment: .leading, spacing: 12) {
          HStack {
            Text("PRISM").font(PrismTheme.body(10.5, weight: .bold)).tracking(0.6)
              .foregroundStyle(.white)
              .padding(.horizontal, 8).padding(.vertical, 3)
              .background(PrismTheme.mintDeep).clipShape(Capsule())
            Text(delta.prism.model).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
            Spacer()
          }
          identityBlock(delta.prism.previouslyTrusted, accent: PrismTheme.muted)
          identityBlock(delta.prism.currentResolution, accent: PrismTheme.amber)
          HStack(spacing: 8) {
            Image(systemName: "hand.raised.fill").font(.system(size: 12, weight: .bold))
            Text(delta.prism.blocked ? "PAYMENT BLOCKED" : delta.prism.state)
              .font(PrismTheme.body(13, weight: .bold)).tracking(0.3)
          }
          .foregroundStyle(PrismTheme.danger)
          Text(delta.prism.result).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.ink)
        }

        Text(delta.interpretation)
          .font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted).lineSpacing(1.5)
          .padding(.top, 2)
      }
    }
  }

  private func pathRow(tag: String, tagColor: Color, model: String, verdict: String, verdictColor: Color, detail: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(tag).font(PrismTheme.body(10.5, weight: .bold)).tracking(0.6)
          .foregroundStyle(.white)
          .padding(.horizontal, 8).padding(.vertical, 3)
          .background(tagColor).clipShape(Capsule())
        Text(model).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
        Spacer()
        Text(verdict).font(PrismTheme.body(12, weight: .bold)).foregroundStyle(verdictColor)
      }
      Text(detail).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.ink).lineSpacing(1.5)
    }
  }

  private func identityBlock(_ b: ContinuityLabBinding, accent: Color) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(b.label).font(PrismTheme.body(9.5, weight: .semibold)).tracking(0.5).foregroundStyle(accent)
      Text("Prism Identity: \(b.prismIdentity)").font(PrismTheme.mono(11)).foregroundStyle(PrismTheme.ink)
      Text(b.account).font(PrismTheme.mono(10.5)).foregroundStyle(PrismTheme.muted)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(PrismTheme.line, lineWidth: 0.7))
  }

  // MARK: - Scenario

  private func scenarioCard(_ steps: [ContinuityLabStep]) -> some View {
    PrismCard {
      VStack(alignment: .leading, spacing: 12) {
        PrismSectionLabel(text: "Scenario")
        ForEach(steps) { s in
          HStack(alignment: .top, spacing: 10) {
            Text("\(s.step)").font(PrismTheme.mono(11, weight: .bold)).foregroundStyle(PrismTheme.mintDeep)
              .frame(width: 18, alignment: .trailing)
            VStack(alignment: .leading, spacing: 2) {
              Text(s.title).font(PrismTheme.body(12.5, weight: .semibold)).foregroundStyle(PrismTheme.ink)
              Text(s.detail).font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted).lineSpacing(1.5)
            }
          }
        }
      }
    }
  }

  // MARK: - Attacks

  private func attacksCard(_ attacks: [ContinuityLabAttack], allPass: Bool) -> some View {
    PrismCard {
      VStack(alignment: .leading, spacing: 14) {
        HStack {
          PrismSectionLabel(text: "Attacks")
          Spacer()
          Text(allPass ? "ALL REJECTED" : "REVIEW")
            .font(PrismTheme.body(10, weight: .bold)).tracking(0.5)
            .foregroundStyle(allPass ? PrismTheme.positive : PrismTheme.amber)
        }
        ForEach(attacks) { a in
          VStack(alignment: .leading, spacing: 5) {
            HStack {
              Text(a.name).font(PrismTheme.body(12.5, weight: .semibold)).foregroundStyle(PrismTheme.ink)
              Spacer()
              Text(a.pass ? "PASS" : "FAIL")
                .font(PrismTheme.body(10.5, weight: .bold))
                .foregroundStyle(a.pass ? PrismTheme.positive : PrismTheme.danger)
            }
            labeled("EXPECTED", a.expected)
            labeled("OBSERVED", a.observed)
            labeled("EVIDENCE", a.evidence)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.bottom, 4)
          if a.id != attacks.last?.id { Divider().overlay(PrismTheme.line) }
        }
      }
    }
  }

  private func labeled(_ label: String, _ value: String) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Text(label).font(PrismTheme.body(9, weight: .bold)).tracking(0.4).foregroundStyle(PrismTheme.muted)
        .frame(width: 62, alignment: .leading)
      Text(value).font(PrismTheme.body(11)).foregroundStyle(PrismTheme.ink).lineSpacing(1.4)
    }
  }

  private func provenance(_ report: ContinuityLabReport) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Verifiers (production code)").font(PrismTheme.body(9.5, weight: .bold)).tracking(0.4).foregroundStyle(PrismTheme.muted)
      Text(report.verifiers.continuity).font(PrismTheme.mono(9.5)).foregroundStyle(PrismTheme.muted)
      Text(report.verifiers.envelope).font(PrismTheme.mono(9.5)).foregroundStyle(PrismTheme.muted)
      if report.fixtures && !report.createsProductionState {
        Text("Fixtures only · no production payment state created").font(PrismTheme.body(10)).foregroundStyle(PrismTheme.mintDeep)
      }
    }
    .padding(.horizontal, 4)
  }

  private func load() async {
    do { report = try await PrismAPI.shared.continuityLab(); error = nil }
    catch { self.error = error.localizedDescription }
    loading = false
  }
}
