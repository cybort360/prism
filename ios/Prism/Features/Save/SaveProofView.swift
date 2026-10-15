import SwiftUI

/// Save Receipt — the consumer inspectable record. Plain money terms; it never leads with the
/// USDC → AUSD → earnAUSD substrate, which lives under Technical details, and links to the full Save Proof.
struct SaveReceiptView: View {
  @Environment(\.dismiss) private var dismiss
  let operationId: String

  @State private var proof: SaveProofResponse?
  @State private var position: SavePositionResponse?
  @State private var loading = true
  @State private var showTechnical = false

  var body: some View {
    NavigationStack {
      ScrollView(showsIndicators: false) {
        VStack(alignment: .leading, spacing: 0) {
          HStack {
            Text("Save receipt").font(PrismTheme.body(11, weight: .semibold)).tracking(1.2).foregroundStyle(PrismTheme.muted)
            Spacer()
            PrismHeaderIconButton(icon: "xmark") { dismiss() }
          }.padding(.top, 10)

          if loading {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
          } else if let proof {
            Text(dollars(proof.inputAmount)).font(PrismTheme.display(46)).tracking(-1.1).monospacedDigit().padding(.top, 16)
            Text("Saved").font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted).padding(.top, 2)

            PrismCard {
              VStack(spacing: 0) {
                row("From", "Prism balance")
                row("Amount invested", dollars(proof.actualAUSD))
                row("Status", position?.status == "ACTIVE" ? "Active" : (proof.complete ? "Active" : "Pending"))
                row("Current value", dollars(position?.currentAUSDValue))
                row("Created", created, last: true)
              }
            }.padding(.top, 24)

            NavigationLink { SaveProofView(proof: proof) } label: {
              HStack { Image(systemName: "checkmark.seal.fill"); Text("Save Proof").font(PrismTheme.body(15, weight: .semibold)); Spacer(); Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)) }
                .foregroundStyle(PrismTheme.mintDeep).padding(.vertical, 15).padding(.horizontal, 16)
                .background(PrismTheme.mintSoft).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }.padding(.top, 18)

            technicalDisclosure(proof).padding(.top, 16)
          } else {
            Text("This receipt isn't available.").font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted).padding(.top, 40)
          }
        }
        .padding(.horizontal, 24).padding(.bottom, 24)
      }
      .prismScreen()
    }
    .task { await load() }
  }

  private func technicalDisclosure(_ p: SaveProofResponse) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { withAnimation(.easeOut(duration: 0.18)) { showTechnical.toggle() } } label: {
        HStack { Text("Technical details").font(PrismTheme.body(12.5, weight: .semibold)).foregroundStyle(PrismTheme.muted); Spacer(); Image(systemName: showTechnical ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(PrismTheme.faint) }
      }.buttonStyle(.plainHit)
      if showTechnical {
        VStack(spacing: 0) {
          tech("Source asset", "USDC")
          tech("USDC spent", dollarsPlain(p.inputAmount))
          tech("Conversion", "USDC → AUSD")
          tech("AUSD received", dollarsPlain(p.actualAUSD))
          tech("Savings position", "earnAUSD")
          tech("Shares received", shares(p.sharesActual))
          tech("Vault", short(p.vault))
          tech("Network", p.network == 143 ? "Monad" : (p.network.map(String.init) ?? "-"))
          tech("Transaction", short(p.transactionHash), last: true)
        }.padding(.top, 10).transition(.opacity)
      }
    }
    .padding(15).frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.surface).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(PrismTheme.line, lineWidth: 0.6))
  }

  private func row(_ label: String, _ value: String, last: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack { Text(label).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted); Spacer(); Text(value).font(PrismTheme.body(14, weight: .semibold)) }.padding(.vertical, 13)
      if !last { Divider().overlay(PrismTheme.line) }
    }.accessibilityElement(children: .combine)
  }
  private func tech(_ label: String, _ value: String, last: Bool = false) -> some View {
    VStack(spacing: 0) {
      HStack { Text(label).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted); Spacer(); Text(value).font(PrismTheme.mono(11)).foregroundStyle(PrismTheme.ink) }.padding(.vertical, 8)
      if !last { Divider().overlay(PrismTheme.line) }
    }.accessibilityElement(children: .combine)
  }

  private func load() async {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--uitest-save-demo") { proof = .example; position = SaveProofView.demoPosition; loading = false; return }
    #endif
    async let pr = try? await PrismAPI.shared.saveProof(operationId: operationId)
    async let pos = try? await PrismAPI.shared.savePosition()
    proof = await pr; position = await pos; loading = false
  }

  private var created: String {
    guard let iso = position?.createdAt, let d = Date.prismParse(iso) else { return "-" }
    return d.formatted(.dateTime.month(.abbreviated).day().year())
  }
  private func dollars(_ a: String?) -> String { guard let a, !a.isEmpty, a.allSatisfy(\.isNumber) else { return "-" }; return Money.dollars(fromAtomic: a) }
  private func dollarsPlain(_ a: String?) -> String { dollars(a).replacingOccurrences(of: "$", with: "") }
  private func shares(_ a: String?) -> String { guard let a, let v = Double(a) else { return "-" }; return String(format: "%.6f", v / 1_000_000) }
  private func short(_ a: String?) -> String { guard let a, a.count > 12 else { return a ?? "-" }; return "\(a.prefix(6))…\(a.suffix(4))" }
}

/// Save Proof — the evidence-backed truth surface. Mirrors the payment proof: source, conversion,
/// position, settlement, and per-fact verification. Nothing reads "Verified" without evidence.
struct SaveProofView: View {
  let proof: SaveProofResponse

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 22) {
        Text("Save Proof").font(PrismTheme.display(30)).tracking(-0.5).padding(.top, 6)

        section("Source") { line("", dollars(proof.inputAmount) + " USDC", strong: true) }

        section("Conversion") {
          line("Route", proof.conversionProvider ?? "-")
          line("AUSD received", dollars(proof.actualAUSD))
        }

        section("Savings position") {
          line("", "earnAUSD", strong: true)
          line("Shares received", shares(proof.sharesActual))
          line("Owned by", "Your Prism account")
        }

        section("Settlement") {
          line("Network", proof.network == 143 ? "Monad" : (proof.network.map(String.init) ?? "-"))
          line("Transaction", short(proof.transactionHash))
          line("Status", proof.complete ? "Confirmed" : (proof.txCorrelates ? "Pending" : "Not matched"))
        }

        verificationSection
      }
      .padding(.horizontal, 24).padding(.bottom, 28)
    }
    .prismScreen().navigationTitle("").navigationBarTitleDisplayMode(.inline)
  }

  private var verificationSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: "Verification")
      ForEach(proof.verification) { v in
        HStack {
          Text(label(v.check)).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.ink)
          Spacer()
          HStack(spacing: 5) {
            Image(systemName: icon(v.status)).font(.system(size: 12, weight: .semibold)).foregroundStyle(tint(v.status))
            Text(word(v.status)).font(PrismTheme.body(12, weight: .semibold)).foregroundStyle(tint(v.status))
          }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label(v.check)): \(word(v.status))")
      }
    }
  }

  private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      PrismSectionLabel(text: title)
      PrismCard { VStack(spacing: 10) { content() } }
    }
  }
  private func line(_ label: String, _ value: String, strong: Bool = false) -> some View {
    HStack {
      if !label.isEmpty { Text(label).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted) }
      Spacer()
      Text(value).font(strong ? PrismTheme.body(16, weight: .semibold) : PrismTheme.body(13.5, weight: .semibold))
        .foregroundStyle(PrismTheme.ink).frame(maxWidth: label.isEmpty ? .infinity : nil, alignment: label.isEmpty ? .leading : .trailing)
    }
  }

  private func label(_ c: String) -> String {
    switch c {
    case "usdc_debit": return "USDC debit"
    case "ausd_conversion": return "AUSD conversion"
    case "earnausd_shares": return "earnAUSD shares"
    case "share_ownership": return "Share ownership"
    case "independent_readback": return "Independent readback"
    default: return c
    }
  }
  private func word(_ s: String) -> String { s == "verified" ? "Verified" : (s == "failed" ? "Failed" : "Unavailable") }
  private func icon(_ s: String) -> String { s == "verified" ? "checkmark.circle.fill" : (s == "failed" ? "xmark.circle.fill" : "minus.circle") }
  private func tint(_ s: String) -> Color { s == "verified" ? PrismTheme.positive : (s == "failed" ? PrismTheme.danger : PrismTheme.muted) }
  private func dollars(_ a: String?) -> String { guard let a, !a.isEmpty, a.allSatisfy(\.isNumber) else { return "-" }; return Money.dollars(fromAtomic: a) }
  private func shares(_ a: String?) -> String { guard let a, let v = Double(a) else { return "-" }; return String(format: "%.6f", v / 1_000_000) }
  private func short(_ a: String?) -> String { guard let a, a.count > 12 else { return a ?? "-" }; return "\(a.prefix(6))…\(a.suffix(4))" }

  #if DEBUG
  static let demoPosition = SavePositionResponse(status: "ACTIVE", currentAUSDValue: "500120000", createdAt: "2026-09-10T00:00:00Z")
  #endif
}

#if DEBUG
extension SaveProofResponse {
  static let example = SaveProofResponse(
    operationId: "so_demo", positionId: "save_demo", network: 143, ownerAccount: "0xabc",
    inputAmount: "500000000", conversionProvider: "Kuru", quotedAUSD: "499000000", actualAUSD: "498500000",
    minimumAUSD: "495000000", vault: "0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA", shareToken: "0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA",
    sharesQuoted: "493000000", sharesActual: "492000000", minimumShares: "490000000", sharePriceAtDeposit: "1010000",
    transactionHash: "0xfc277f341cb6db59389fcc21269decefc7708fccd979a7e5ae508b3754c41f19", blockNumber: "60877492",
    gasSponsored: true, stateReadback: SaveProofReadback(available: true, shares: "492000000", valueAtomic: "500120000"),
    txCorrelates: true,
    verification: [
      SaveProofCheck(check: "usdc_debit", status: "verified"), SaveProofCheck(check: "ausd_conversion", status: "verified"),
      SaveProofCheck(check: "earnausd_shares", status: "verified"), SaveProofCheck(check: "share_ownership", status: "verified"),
      SaveProofCheck(check: "independent_readback", status: "verified")
    ], complete: true)
}
#endif
