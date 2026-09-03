import SwiftUI

struct IdentityChangeReviewView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let candidate: IdentityChangeCandidate

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      .padding(.top, 10)

      Spacer().frame(height: 20)

      ZStack {
        Circle().fill(PrismTheme.amber.opacity(0.10)).frame(width: 90, height: 90)
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.system(size: 30, weight: .medium))
          .foregroundStyle(PrismTheme.amber)
      }

      Text("Payment identity\nchanged")
        .font(PrismTheme.display(39))
        .tracking(-0.8)
        .padding(.top, 25)

      Text("The payment identity for \(candidate.contact.name) is different from the one you previously trusted. Prism will never silently redirect money or a payment request.")
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .padding(.top, 13)

      PrismCard(padding: 17) {
        VStack(alignment: .leading, spacing: 10) {
          PrismSectionLabel(text: "New Prism account")
          Text(candidate.resolution.attestation?.recipientAccount ?? "Unavailable")
            .font(PrismTheme.mono(10.8))
            .textSelection(.enabled)
          if let version = candidate.resolution.attestation?.aliasVersion {
            Text("Alias version \(version)")
              .font(PrismTheme.body(11.5))
              .foregroundStyle(PrismTheme.muted)
          }
        }
      }
      .padding(.top, 23)

      HStack(alignment: .top, spacing: 9) {
        Image(systemName: "shield.lefthalf.filled").foregroundStyle(PrismTheme.amber)
        Text("Continue only if you independently expect this person’s payment identity to have changed.")
          .font(PrismTheme.body(12.5))
          .foregroundStyle(PrismTheme.muted)
      }
      .padding(.top, 17)

      Spacer()

      PrismPrimaryButton(
        title: candidate.action == .send ? "Trust and continue" : "Trust and request",
        icon: "checkmark.shield"
      ) {
        IdentityTrustStore.shared.reset(contactId: candidate.contact.id)
        IdentityTrustStore.shared.remember(contact: candidate.contact, resolution: candidate.resolution)
        dismiss()
        let target = SendTarget(contact: candidate.contact, resolution: candidate.resolution)
        switch candidate.action {
        case .send: model.presentSend = target
        case .request: model.presentRequest = target
        }
      }

      Button(candidate.action == .send ? "Cancel payment" : "Cancel request") { dismiss() }
        .font(PrismTheme.body(13.5, weight: .semibold))
        .foregroundStyle(PrismTheme.muted)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 10)
    .prismScreen()
  }
}
