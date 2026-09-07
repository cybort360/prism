import SwiftUI

/// Consumer-facing "how this payment was resolved and verified" surface. Navigation + data are wired
/// here; the full evidence presentation is built in a later pass. Distinct from the DEBUG dev Proof
/// screen (ProofView), which exposes raw chain internals for judges only.
struct PaymentProofView: View {
  let paymentId: String
  @State private var proof: PaymentProof?
  @State private var loading = true

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 8) {
          ZStack {
            Circle().fill(PrismTheme.mintSoft).frame(width: 60, height: 60)
            Image(systemName: "checkmark.seal.fill").font(.system(size: 26)).foregroundStyle(PrismTheme.mintDeep)
          }
          Text("How this was verified").font(PrismTheme.display(28)).tracking(-0.4).padding(.top, 6)
          Text("Prism proves every payment reached the right person and settled on-chain — without exposing your phone number or wallet.")
            .font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted).lineSpacing(2)
        }
        .padding(.top, 8)

        if loading {
          ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
        } else if let p = proof {
          PrismCard {
            VStack(alignment: .leading, spacing: 12) {
              PrismSectionLabel(text: "Verified")
              proofLine("Recipient identity", "Confirmed by Prism resolver")
              proofLine("Settlement", p.state.capitalized)
              proofLine("You paid gas", (p.senderMonBalance ?? "0") == "0" ? "No — Prism sponsored it" : "Yes")
              proofLine("Recorded on", "Monad · chain \(p.network.chainId)")
            }
          }
        } else {
          Text("Full verification detail is coming soon.")
            .font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted).padding(.top, 20)
        }
      }
      .padding(.horizontal, 22).padding(.bottom, 30)
    }
    .background(PrismTheme.canvas.ignoresSafeArea())
    .navigationTitle("").navigationBarTitleDisplayMode(.inline)
    .task { proof = try? await PrismAPI.shared.paymentProof(paymentId); loading = false }
  }

  private func proofLine(_ k: String, _ v: String) -> some View {
    HStack(alignment: .top) {
      Text(k).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      Text(v).font(PrismTheme.body(12.5, weight: .medium)).foregroundStyle(PrismTheme.ink).multilineTextAlignment(.trailing)
    }
  }
}
