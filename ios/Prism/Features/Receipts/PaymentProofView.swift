import SwiftUI

/// Makes Prism's invisible architecture INSPECTABLE for one payment. A skeptical reviewer can answer:
/// did real value move, did Prism resolve a human, was the phone identifier exposed on-chain, did the
/// user need MON, was it confirmed on Monad, can I inspect the tx, and was the data independently
/// read/indexed. A secondary evidence surface — reached from Payment Details, not the Home flow.
struct PaymentProofView: View {
  let paymentId: String
  private let injected: PrismPaymentProof?
  @State private var proof: PrismPaymentProof?
  @State private var loading = true
  @State private var showTechnical = false

  init(paymentId: String) { self.paymentId = paymentId; self.injected = nil }
  /// Preview/demo entry — renders a fixture with the DEMO DATA marker, no network.
  init(demo: PrismPaymentProof) { self.paymentId = demo.paymentId; self.injected = demo }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 16) {
        if let p = proof {
          header(p)
          if p.demo { demoBanner }
          humanRecipient(p)
          identifierPrivacy(p)
          authorization(p)
          networkCost(p)
          settlement(p)
          verification(p)
          if let r = p.request { requestSection(r) }
          if let c = p.claim { claimSection(c) }
          technical(p)
          shareButton(p)
        } else if loading {
          ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
        } else {
          Text("This proof isn't available.").font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted).padding(.top, 40)
        }
      }
      .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 34)
    }
    .background(PrismTheme.canvas.ignoresSafeArea())
    .navigationTitle("").navigationBarTitleDisplayMode(.inline)
    .task {
      if let injected { proof = injected; loading = false; return }
      proof = try? await PrismAPI.shared.canonicalProof(paymentId)
      loading = false
    }
  }

  // MARK: TOP

  private func header(_ p: PrismPaymentProof) -> some View {
    let badge = ProofBadge.status(p.proofStatus, demo: p.demo)
    return VStack(alignment: .leading, spacing: 10) {
      Text("PAYMENT PROOF").font(PrismTheme.body(11, weight: .semibold)).tracking(1.6).foregroundStyle(PrismTheme.muted)
      if let a = p.amountAtomic {
        Text(Money.dollars(fromAtomic: a)).font(PrismTheme.display(46)).tracking(-1)
      }
      Text(recipientLine(p)).font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted)
      HStack(spacing: 8) {
        Circle().fill(badge.tone.color).frame(width: 9, height: 9)
        Text(badge.text).font(PrismTheme.body(13, weight: .bold)).tracking(0.6).foregroundStyle(badge.tone.color)
      }
      .padding(.horizontal, 13).padding(.vertical, 8)
      .background(badge.tone.color.opacity(0.10))
      .clipShape(Capsule())
      .padding(.top, 2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 6)
  }

  private func recipientLine(_ p: PrismPaymentProof) -> String {
    let who = p.recipient.displayName ?? p.recipient.handle ?? "recipient"
    return p.direction == "received" ? "received · \(p.settlement.asset)" : "to \(who)"
  }

  private var demoBanner: some View {
    HStack(spacing: 9) {
      Image(systemName: "theatermasks.fill").font(.system(size: 13))
      Text("DEMO DATA — not a live on-chain payment").font(PrismTheme.body(12, weight: .semibold))
    }
    .foregroundStyle(PrismTheme.amber)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(13)
    .background(PrismTheme.amber.opacity(0.10))
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
  }

  // MARK: HUMAN RECIPIENT

  private func humanRecipient(_ p: PrismPaymentProof) -> some View {
    section("HUMAN RECIPIENT") {
      if let name = p.recipient.displayName {
        row("Name", value: name)
      }
      if let handle = p.recipient.handle { row("Handle", value: handle) }
      row("Entry method", value: entryMethodLabel(p.recipient.entryMethod))
      row("Resolution", badge: .init(text: "Verified privately", tone: .positive))
      if let ref = p.recipient.resolutionReference { row("Resolution reference", value: shortRef(ref), mono: true) }
      if let v = p.recipient.resolutionVersion { row("Resolution version", value: "\(v)") }
    }
  }

  // MARK: IDENTIFIER PRIVACY

  private func identifierPrivacy(_ p: PrismPaymentProof) -> some View {
    section("IDENTIFIER PRIVACY") {
      row("Sensitive identifier on-chain", badge: ProofBadge.exposure(p.privacy.sensitiveOnchain))
      Divider().overlay(PrismTheme.line).padding(.vertical, 2)
      row("Raw phone in calldata", badge: ProofBadge.exposure(p.privacy.rawPhoneInCalldata))
      row("Raw phone in events", badge: ProofBadge.exposure(p.privacy.rawPhoneInEvents))
      row("Phone-derived hash on-chain", badge: ProofBadge.exposure(p.privacy.phoneDerivedHashOnchain))
      Divider().overlay(PrismTheme.line).padding(.vertical, 2)
      row("Calldata scan", badge: ProofBadge.check(p.privacy.calldataCheck, passText: "Pass", failText: "Fail"))
      row("Event scan", badge: ProofBadge.check(p.privacy.eventCheck, passText: "Pass", failText: "Fail"))
      row("Contract schema", badge: ProofBadge.check(p.privacy.schemaCheck, passText: "Pass", failText: "Fail"))
    }
  }

  // MARK: AUTHORIZATION

  private func authorization(_ p: PrismPaymentProof) -> some View {
    section("AUTHORIZATION") {
      row("Method", value: p.authorization.method)
      row("Local approval", value: localApprovalLabel(p.authorization.localApproval))
      row("OTP used for spending", badge: ProofBadge.check(p.authorization.otpForSpending))
    }
  }

  // MARK: NETWORK COST

  private func networkCost(_ p: PrismPaymentProof) -> some View {
    section("NETWORK COST") {
      row("Gas paid by you", value: "$\(p.gas.userPaidDollars)")
      row("MON required from you", value: p.gas.monRequiredFromSender)
      row("Sponsored", badge: ProofBadge.check(p.gas.sponsored, passText: "Yes", failText: "No"))
    }
  }

  // MARK: SETTLEMENT

  private func settlement(_ p: PrismPaymentProof) -> some View {
    let s = p.settlement
    return section("SETTLEMENT") {
      row("Network", value: s.network)
      row("Asset", value: s.asset)
      row("Status", badge: ProofBadge.check(s.status, passText: s.status.capitalized))
      if let b = s.blockNumber { row("Block", value: formattedBlock(b), mono: true) }
      if let tx = s.txHash { row("Transaction", value: shortRef(tx), mono: true) }
      timeRow("Created", s.createdAt)
      timeRow("Submitted", s.submittedAt)
      timeRow("Confirmed", s.confirmedAt)
      if let urlString = s.explorerUrl, let url = URL(string: urlString) {
        Link(destination: url) {
          HStack(spacing: 7) {
            Image(systemName: "arrow.up.right.square").font(.system(size: 13, weight: .semibold))
            Text("View on explorer").font(PrismTheme.body(14, weight: .semibold))
          }
          .foregroundStyle(PrismTheme.mintDeep)
          .frame(maxWidth: .infinity).frame(height: 46)
          .background(PrismTheme.mintSoft)
          .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .padding(.top, 4)
      }
    }
  }

  // MARK: VERIFICATION (independent readback)

  private func verification(_ p: PrismPaymentProof) -> some View {
    let v = p.verification
    return section("INDEPENDENT VERIFICATION") {
      row("Monad receipt", badge: ProofBadge.check(v.monadReceipt))
      row("Alchemy readback", badge: ProofBadge.check(v.alchemyReadback))
      row("Envio indexing", badge: ProofBadge.check(v.envioIndex, passText: "Indexed"))
      row("Recipient balance delta", badge: ProofBadge.check(v.balanceDelta))
    }
  }

  // MARK: REQUEST

  private func requestSection(_ r: PrismPaymentProof.RequestBinding) -> some View {
    section("REQUEST") {
      if let label = r.label { row("Request", value: label) }
      if let id = r.requestId { row("Request ID", value: shortRef(id), mono: true) }
      row("Bound to payment", badge: ProofBadge.check(r.boundToPayment))
    }
  }

  // MARK: CLAIM

  private func claimSection(_ c: PrismPaymentProof.ClaimProof) -> some View {
    section("CLAIM") {
      row("Funds protected", badge: ProofBadge.check(c.fundsProtected))
      if let id = c.claimId { row("Claim", value: shortRef(id), mono: true) }
      row("Recipient eligibility", badge: ProofBadge.check(c.recipientEligibility))
      if let claimed = c.claimedAt { row("Claimed", value: shortDate(claimed)) }
      if let expired = c.expiredAt { row("Expired", value: shortDate(expired)) }
      if let refund = c.refund { row("Refund", badge: ProofBadge.check(refund)) }
      if let restored = c.senderRestored { row("Original sender restored", badge: ProofBadge.check(restored)) }
    }
  }

  // MARK: technical — evidence level + typed evidence items

  private func technical(_ p: PrismPaymentProof) -> some View {
    VStack(spacing: 0) {
      Button { withAnimation(.easeOut(duration: 0.16)) { showTechnical.toggle() } } label: {
        HStack {
          Text("Technical evidence").font(PrismTheme.body(13, weight: .semibold)).foregroundStyle(PrismTheme.ink)
          Spacer()
          Text(p.evidenceLevel).font(PrismTheme.mono(11)).foregroundStyle(PrismTheme.mintDeep)
            .padding(.horizontal, 8).padding(.vertical, 3).background(PrismTheme.mintSoft).clipShape(Capsule())
          Image(systemName: showTechnical ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(PrismTheme.muted)
        }
        .padding(.vertical, 14)
      }
      .buttonStyle(.plain)

      if showTechnical {
        VStack(alignment: .leading, spacing: 12) {
          Text(evidenceLevelBlurb(p.evidenceLevel)).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted).lineSpacing(2)
          ForEach(p.evidence) { item in evidenceRow(item) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 12)
      }
    }
    .padding(.horizontal, 15)
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
  }

  private func evidenceRow(_ item: PrismEvidenceItem) -> some View {
    let badge = ProofBadge.check(item.status, passText: item.status.capitalized, failText: "Fail")
    return VStack(alignment: .leading, spacing: 3) {
      HStack {
        Text(item.type.title).font(PrismTheme.body(12.5, weight: .semibold)).foregroundStyle(PrismTheme.ink)
        Spacer()
        HStack(spacing: 5) {
          Circle().fill(badge.tone.color).frame(width: 6, height: 6)
          Text(badge.text).font(PrismTheme.body(11, weight: .semibold)).foregroundStyle(badge.tone.color)
        }
      }
      if let detail = item.detail { Text(detail).font(PrismTheme.body(10.5)).foregroundStyle(PrismTheme.muted).lineSpacing(1.5) }
      if let source = item.source { Text("source: \(source)").font(PrismTheme.mono(9.5)).foregroundStyle(PrismTheme.faint) }
    }
    .padding(.vertical, 6)
    .overlay(alignment: .bottom, content: { Divider().overlay(PrismTheme.line) })
  }

  private func shareButton(_ p: PrismPaymentProof) -> some View {
    ShareLink(item: PaymentProofShare.text(p)) {
      HStack(spacing: 8) {
        Image(systemName: "square.and.arrow.up").font(.system(size: 14, weight: .semibold))
        Text("Share proof").font(PrismTheme.body(15, weight: .semibold))
      }
      .foregroundStyle(PrismTheme.ink)
      .frame(maxWidth: .infinity).frame(height: 52)
      .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(PrismTheme.line, lineWidth: 1))
    }
    .padding(.top, 2)
  }

  // MARK: building blocks

  @ViewBuilder private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 11) {
      Text(title).font(PrismTheme.body(10.5, weight: .semibold)).tracking(1.3).foregroundStyle(PrismTheme.muted)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
  }

  private func row(_ key: String, value: String, mono: Bool = false) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Text(key).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      Text(value)
        .font(mono ? PrismTheme.mono(11.5) : PrismTheme.body(12.5, weight: .medium))
        .foregroundStyle(PrismTheme.ink).multilineTextAlignment(.trailing)
        .textSelection(.enabled)
    }
  }

  private func row(_ key: String, badge: ProofBadge) -> some View {
    HStack(spacing: 12) {
      Text(key).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      HStack(spacing: 6) {
        Circle().fill(badge.tone.color).frame(width: 7, height: 7)
        Text(badge.text).font(PrismTheme.body(12.5, weight: .semibold)).foregroundStyle(badge.tone.color)
      }
    }
  }

  @ViewBuilder private func timeRow(_ key: String, _ iso: String?) -> some View {
    if let iso, let t = Self.timeOnly(iso) { row(key, value: t, mono: true) }
  }

  // MARK: formatting

  private func entryMethodLabel(_ raw: String?) -> String {
    switch raw {
    case "contacts": "Contacts"
    case "qr": "QR code"
    case "paymentLink", "link": "Payment link"
    case "claim": "Claim link"
    default: (raw ?? "—").capitalized
    }
  }
  private func localApprovalLabel(_ raw: String?) -> String {
    // The backend doesn't observe which local gate the user used; reflect the device setting honestly.
    if let raw, !raw.isEmpty { return raw }
    return UserDefaults.standard.bool(forKey: "payments.faceID") ? "Face ID" : "Payment PIN"
  }
  private func shortRef(_ s: String) -> String {
    guard s.count > 14 else { return s }
    return "\(s.prefix(8))…\(s.suffix(4))"
  }
  private func formattedBlock(_ b: String) -> String {
    guard let n = Int(b) else { return b }
    return n.formatted(.number.grouping(.automatic))
  }
  private func shortDate(_ iso: String) -> String {
    guard let d = ISO8601DateFormatter().date(from: iso) else { return iso }
    return d.formatted(date: .abbreviated, time: .omitted)
  }
  private func evidenceLevelBlurb(_ level: String) -> String {
    switch level {
    case "E0": "E0 — Unverified claim."
    case "E1": "E1 — UI / demo fixture, not live."
    case "E2": "E2 — Local reproducible test."
    case "E3": "E3 — Testnet transaction with independent readback."
    case "E4": "E4 — Independently reproduced."
    case "E5": "E5 — Production / mainnet independent verification."
    default: level
    }
  }
  static func timeOnly(_ iso: String) -> String? {
    guard let d = ISO8601DateFormatter().date(from: iso) else { return nil }
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f.string(from: d)
  }
}
