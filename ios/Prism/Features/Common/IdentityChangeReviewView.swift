import SwiftUI
import CryptoKit

/// The continuity safety surface. When paying a known contact would reach a DIFFERENT Prism payment
/// identity than the payer last trusted (or an unconfirmable one), PRISM stops and brings the payer
/// here — never a generic error toast, and never a one-tap "send anyway".
///
/// It is deliberately two steps:
///   1. Warning  — states plainly that the identity changed. Only "Review change" / "Cancel".
///   2. Review   — human-readable continuity context, and only here the deliberate, explicit
///                 re-establishment of trust. Raw account details stay behind an opt-in disclosure.
struct IdentityChangeReviewView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let candidate: IdentityChangeCandidate

  var body: some View {
    NavigationStack {
      warningScreen
        .navigationDestination(isPresented: $showReview) { reviewScreen }
    }
  }

  @State private var showReview = false

  private var isSend: Bool { candidate.action == .send }
  private var name: String { candidate.contact.name }
  private var ambiguous: Bool { candidate.state == .resolverUnavailableOrAmbiguous }
  /// The resolution still names the SAME PrismIdentity the payer trusted, but something else (the
  /// account) changed in a way the resolver couldn't verify. The frame is "same person, unverified
  /// change", NOT "different human" — so the review copy must not imply two different identities.
  private var sameIdentity: Bool {
    guard let prev = candidate.previous, let now = candidate.resolution.attestation else { return false }
    return prev.prismId.lowercased() == now.prismIdentity.lowercased()
  }
  /// A darker amber that meets WCAG AA (~5.7:1 on white) for small caution labels; the bright
  /// PrismTheme.amber stays for icons/fills only.
  private let amberText = Color(red: 0.58, green: 0.35, blue: 0.02)

  // MARK: 1 — Warning

  private var warningScreen: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      .padding(.top, 10)

      Spacer().frame(height: 24)

      ZStack {
        Circle().fill(PrismTheme.amber.opacity(0.10)).frame(width: 88, height: 88)
        Image(systemName: "person.crop.circle.badge.exclamationmark.fill")
          .font(.system(size: 34, weight: .medium))
          .foregroundStyle(PrismTheme.amber)
      }

      Text(warningTitle)
        .font(PrismTheme.display(37))
        .tracking(-0.7)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 24)

      Text(warningBody)
        .font(PrismTheme.body(15))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(3)
        .padding(.top, 14)

      Spacer()

      PrismPrimaryButton(title: "Review change", icon: "arrow.right") {
        PrismHaptics.selection()
        showReview = true
      }

      Button(isSend ? "Cancel payment" : "Cancel request") { dismiss() }
        .font(PrismTheme.body(14, weight: .semibold))
        .foregroundStyle(PrismTheme.muted)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 17)
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 10)
    .prismScreen()
    .navigationBarBackButtonHidden(true)
    .onAppear { PrismHaptics.warning() }
  }

  private var warningTitle: String {
    if sameIdentity { return "\(name)’s account\nchanged" }
    if ambiguous { return "We couldn’t confirm\n\(name)’s identity" }
    return "\(name)’s payment\nidentity changed"
  }
  private var warningBody: String {
    let act = isSend ? "payment" : "request"
    if sameIdentity {
      return "The account \(name) receives money at changed, and Prism couldn’t verify the change. It stopped the \(act) so you can confirm it’s really them."
    }
    if ambiguous {
      return "Prism couldn’t confirm this is the same payment identity you trusted before. It stopped the \(act) so you can verify who you’re paying."
    }
    return "You previously paid a different Prism identity through this contact. Prism stopped the \(act) so you can verify who you’re paying."
  }

  // MARK: 2 — Review change (human-readable; raw details opt-in only)

  @State private var showTechnical = false

  private var reviewScreen: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        Text("Review the change")
          .font(PrismTheme.display(31))
          .tracking(-0.5)
          .padding(.top, 8)

        Text("A person is found by their phone or @handle — but that’s just how they’re reached, not who they are. That route now points to a different Prism identity.")
          .font(PrismTheme.body(13.5))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2.5)
          .padding(.top, 12)

        comparisonSection.padding(.top, 22)

        guidanceCard.padding(.top, 16)

        technicalDisclosure.padding(.top, 16)

        Spacer(minLength: 26)

        PrismPrimaryButton(
          title: isSend ? "I’ve verified — trust and continue" : "I’ve verified — trust and request",
          icon: "checkmark.shield.fill"
        ) { trustAndProceed() }

        Button(isSend ? "Cancel payment" : "Cancel request") { dismiss() }
          .font(PrismTheme.body(14, weight: .semibold))
          .foregroundStyle(PrismTheme.muted)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 17)
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 10)
    }
    .prismScreen()
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder private var comparisonSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      if sameIdentity {
        // Same person, an unverified account change — never framed as a "different human".
        PrismCard(padding: 0) {
          VStack(spacing: 0) {
            identityRow(
              label: "SAME PRISM IDENTITY",
              code: candidate.resolution.attestation.map { identityCode($0.prismIdentity) } ?? "—",
              sub: candidate.previous.map { "Trusted since \(dateText($0.establishedAt))" } ?? nil,
              icon: "person.fill", tint: PrismTheme.muted, labelColor: PrismTheme.muted)
            Rectangle().fill(PrismTheme.line).frame(height: 0.7).padding(.horizontal, 17)
            noticeRow(
              label: "ACCOUNT CHANGED",
              detail: "The account it points to changed without a verified update.",
              tint: PrismTheme.amber, labelColor: amberText)
          }
        }
        verdict("Same person — but the account changed without a verified update. Confirm it with \(name) before paying.")
      } else if let prev = candidate.previous, candidate.resolution.attestation != nil {
        // A different PrismIdentity — a different human.
        PrismCard(padding: 0) {
          VStack(spacing: 0) {
            identityRow(
              label: "PREVIOUSLY TRUSTED", code: identityCode(prev.prismId),
              sub: "Trusted since \(dateText(prev.establishedAt))",
              icon: "checkmark.seal.fill", tint: PrismTheme.muted, labelColor: PrismTheme.muted)
            HStack(spacing: 8) {
              Image(systemName: "arrow.down").font(.system(size: 11, weight: .bold)).foregroundStyle(PrismTheme.faint)
              Rectangle().fill(PrismTheme.line).frame(height: 0.7)
            }
            .padding(.horizontal, 17)
            identityRow(
              label: "NOW RESOLVES TO",
              code: candidate.resolution.attestation.map { identityCode($0.prismIdentity) } ?? "—",
              sub: "A different Prism identity",
              icon: "person.fill.questionmark", tint: PrismTheme.amber, labelColor: amberText)
          }
        }
        verdict("These are two different Prism identities. The person you reach at this contact isn’t the one you paid before.")
      } else {
        // Nothing to confirm against — fail closed.
        PrismCard {
          HStack(spacing: 12) {
            Image(systemName: "questionmark.circle.fill").font(.system(size: 20)).foregroundStyle(PrismTheme.amber)
            Text("Prism couldn’t confirm who this contact resolves to right now.")
              .font(PrismTheme.body(13)).foregroundStyle(PrismTheme.ink)
          }
        }
      }
    }
  }

  private func verdict(_ text: String) -> some View {
    Text(text)
      .font(PrismTheme.body(12.5, weight: .semibold))
      .foregroundStyle(PrismTheme.ink)
      .lineSpacing(2)
      .padding(.horizontal, 4)
  }

  private func identityRow(label: String, code: String, sub: String?, icon: String, tint: Color, labelColor: Color) -> some View {
    HStack(spacing: 13) {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous).fill(tint.opacity(0.14)).frame(width: 44, height: 44)
        Image(systemName: icon).font(.system(size: 18)).foregroundStyle(tint)
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(label).font(PrismTheme.body(9.5, weight: .bold)).tracking(0.5).foregroundStyle(labelColor)
        Text(code).font(PrismTheme.mono(14, weight: .medium)).foregroundStyle(PrismTheme.ink)
        if let sub { Text(sub).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted) }
      }
      Spacer()
    }
    .padding(17)
    .accessibilityElement(children: .combine)
  }

  private func noticeRow(label: String, detail: String, tint: Color, labelColor: Color) -> some View {
    HStack(spacing: 13) {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous).fill(tint.opacity(0.14)).frame(width: 44, height: 44)
        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 17)).foregroundStyle(tint)
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(label).font(PrismTheme.body(9.5, weight: .bold)).tracking(0.5).foregroundStyle(labelColor)
        Text(detail).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted).lineSpacing(1.5)
      }
      Spacer()
    }
    .padding(17)
    .accessibilityElement(children: .combine)
  }

  private var guidanceCard: some View {
    HStack(alignment: .top, spacing: 11) {
      Image(systemName: "shield.lefthalf.filled").foregroundStyle(PrismTheme.mintDeep)
        .font(.system(size: 16))
      Text(sameIdentity
        ? "Reach \(name) somewhere you already trust and confirm they moved to a new account. Continue only if you expect it — this can’t be undone once the money moves."
        : "Reach \(name) somewhere you already trust and confirm their Prism identity changed. Continue only if you expect it — this can’t be undone once the money moves.")
        .font(PrismTheme.body(12.5))
        .foregroundStyle(PrismTheme.ink)
        .lineSpacing(2)
    }
    .padding(15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.mintSoft.opacity(0.5))
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
  }

  private var technicalDisclosure: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeOut(duration: 0.18)) { showTechnical.toggle() }
      } label: {
        HStack {
          Text("Technical details").font(PrismTheme.body(12.5, weight: .semibold)).foregroundStyle(PrismTheme.muted)
          Spacer()
          Image(systemName: showTechnical ? "chevron.up" : "chevron.down")
            .font(.system(size: 11, weight: .semibold)).foregroundStyle(PrismTheme.faint)
        }
      }
      .buttonStyle(.plain)

      if showTechnical, let a = candidate.resolution.attestation {
        VStack(alignment: .leading, spacing: 6) {
          Text("New account").font(PrismTheme.body(10, weight: .semibold)).foregroundStyle(PrismTheme.muted)
          Text(a.recipientAccount).font(PrismTheme.mono(10.5)).textSelection(.enabled).foregroundStyle(PrismTheme.ink)
          Text("Resolution version \(a.aliasVersion)").font(PrismTheme.body(10.5)).foregroundStyle(PrismTheme.muted)
        }
        .padding(.top, 10)
        .transition(.opacity)
      }
    }
    .padding(15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(PrismTheme.line, lineWidth: 0.6))
  }

  // MARK: proceed

  private func trustAndProceed() {
    IdentityTrustStore.shared.reset(contactId: candidate.contact.id)
    IdentityTrustStore.shared.remember(contact: candidate.contact, resolution: candidate.resolution)
    dismiss()
    let target = SendTarget(contact: candidate.contact, resolution: candidate.resolution)
    switch candidate.action {
    case .send: model.presentSend = target
    case .request: model.presentRequest = target
    }
  }

  // MARK: human-readable helpers (no raw blockchain infrastructure)

  /// A short, stable, collision-resistant, human-comparable code for an opaque Prism identity id. It is
  /// a hash of the WHOLE id (not a truncated suffix), so two DIFFERENT identities never render the same
  /// code on the screen whose whole job is to show they differ. Not an address, RPC, or chain
  /// infrastructure — just a fingerprint the payer can compare.
  private func identityCode(_ prismId: String) -> String {
    let digest = SHA256.hash(data: Data(prismId.utf8))
    let hex = digest.prefix(4).map { String(format: "%02X", $0) }.joined() // 4 bytes → 8 hex chars
    let mid = hex.index(hex.startIndex, offsetBy: 4)
    return "ID·\(hex[hex.startIndex..<mid])·\(hex[mid...])"
  }

  private func dateText(_ date: Date) -> String {
    date.formatted(.dateTime.month(.abbreviated).day().year())
  }
}
