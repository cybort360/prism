import SwiftUI

/// Presentation handle for the one canonical payment-detail screen.
struct PaymentDetailsPresentation: Identifiable {
  let id = UUID()
  let operationId: String
  var fallback: PrismPayment? = nil
}

/// ONE canonical detail screen that renders any PrismPayment: SUMMARY · LIFECYCLE · RECEIPT ·
/// PAYMENT PROOF · TECHNICAL DETAILS. Premium fintech receipt first; chain evidence stays collapsed.
struct PaymentDetailsView: View {
  let presentation: PaymentDetailsPresentation
  @Environment(\.dismiss) private var dismiss
  @State private var canonical: PrismCanonicalPayment?
  @State private var showTechnical = false
  @State private var loading = true

  private var display: PaymentDisplay? {
    if let c = canonical { return PaymentDisplay(payment: c.payment, events: c.events, receipt: c.receipt) }
    if let f = presentation.fallback { return PaymentDisplay(payment: f) }
    return nil
  }

  var body: some View {
    NavigationStack {
      ScrollView(showsIndicators: false) {
        if let d = display {
          VStack(spacing: 26) {
            summary(d)
            timeline(d)
            sharedAccount(d)
            receipt(d)
            crossChain(d)
            proofRow(d)
            technical(d)
            shareButton(d)
          }
          .padding(.horizontal, 22)
          .padding(.bottom, 36)
        } else if loading {
          ProgressView().padding(.top, 120)
        } else {
          EmptyStateView(icon: "doc.text.magnifyingglass", title: "Details unavailable",
                         bodyText: "We couldn't load this payment right now.").padding(.top, 80)
        }
      }
      .background(PrismTheme.canvas.ignoresSafeArea())
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) { PrismSectionLabel(text: "Payment details") }
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.foregroundStyle(PrismTheme.ink) }
      }
    }
    .task { await load() }
  }

  // MARK: SUMMARY
  private func summary(_ d: PaymentDisplay) -> some View {
    VStack(spacing: 6) {
      PrismAvatar(initials: d.initials, size: 66, highlighted: d.payment.isSettled).padding(.top, 8)
      Text(d.title).font(PrismTheme.body(18, weight: .semibold)).padding(.top, 6)
      if let h = d.handle { Text(h).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted) }
      AmountText(dollars: d.amountLine, size: 52).padding(.top, 10)
      if let memo = d.memo {
        Text(memo).font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted).padding(.top, 2)
      }
      statusPill(d).padding(.top, 12)
      if let attention = d.attentionMessage {
        Text(attention)
          .font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.pending)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 20).padding(.vertical, 10).padding(.top, 12)
          .background(PrismTheme.ice).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      }
      if let date = d.dateLine, let time = d.timeLine {
        Text("\(date) · \(time)").font(PrismTheme.body(12)).foregroundStyle(PrismTheme.faint).padding(.top, 10)
      }
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(d.title), \(d.amountLine), \(d.statusLabel)")
  }

  private func statusPill(_ d: PaymentDisplay) -> some View {
    let tone: PrismStatusTone = {
      switch d.statusTone { case .positive: .positive; case .danger: .danger; case .pending: .pending; case .neutral: .neutral }
    }()
    return PrismStatusPill(text: d.statusLabel, tone: tone)
  }

  // MARK: LIFECYCLE
  private func timeline(_ d: PaymentDisplay) -> some View {
    section("Lifecycle") {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(d.timeline.enumerated()), id: \.offset) { idx, step in
          TimelineRow(step: step, isLast: idx == d.timeline.count - 1)
        }
      }
    }
  }

  // MARK: RECEIPT
  private func receipt(_ d: PaymentDisplay) -> some View {
    section("Receipt") {
      VStack(spacing: 0) {
        ForEach(Array(d.receiptRows.enumerated()), id: \.offset) { idx, r in
          detailRow(r.label, r.value)
          if idx < d.receiptRows.count - 1 { Divider().overlay(PrismTheme.line) }
        }
      }
    }
  }

  // MARK: SHARED ACCOUNT (Circles)
  /// Only renders for a payment that came out of — or went into — a Circle. Its own section rather
  /// than rows folded into the receipt, because "whose money was this, and who agreed to it" is a
  /// different question from "what was paid", and a shared payment is unreadable without it.
  @ViewBuilder
  private func sharedAccount(_ d: PaymentDisplay) -> some View {
    if let circle = d.circle, !d.circleRows.isEmpty {
      section(circle.isIncoming ? "Added to a Circle" : "Paid from a Circle") {
        VStack(spacing: 0) {
          ForEach(Array(d.circleRows.enumerated()), id: \.offset) { idx, r in
            detailRow(r.label, r.value)
            if idx < d.circleRows.count - 1 { Divider().overlay(PrismTheme.line) }
          }
        }
      }
    }
  }

  // MARK: CROSS-CHAIN
  /// Only renders for a cross-chain send. Kept as its own section rather than folded into Receipt,
  /// because the receipt describes money leaving the account on Monad and this describes where it is
  /// going — collapsing them would let a confirmed Monad leg read as a delivery.
  @ViewBuilder
  private func crossChain(_ d: PaymentDisplay) -> some View {
    if !d.crossChainRows.isEmpty {
      section("Cross-chain") {
        VStack(spacing: 0) {
          ForEach(Array(d.crossChainRows.enumerated()), id: \.offset) { idx, r in
            if r.label == "Route status" {
              HStack {
                Text(r.label)
                  .font(PrismTheme.body(13))
                  .foregroundStyle(PrismTheme.muted)
                Spacer()
                PrismStatusPill(text: r.value, tone: d.routeStatusTone)
              }
              .padding(.vertical, 13)
            } else {
              detailRow(r.label, r.value)
            }
            if idx < d.crossChainRows.count - 1 { Divider().overlay(PrismTheme.line) }
          }
        }
      }
    }
  }

  // MARK: PAYMENT PROOF
  private func proofRow(_ d: PaymentDisplay) -> some View {
    NavigationLink { PaymentProofView(paymentId: d.payment.paymentId) } label: {
      HStack(spacing: 13) {
        Circle().fill(PrismTheme.mintSoft).frame(width: 40, height: 40)
          .overlay(Image(systemName: "checkmark.seal").foregroundStyle(PrismTheme.mintDeep))
        VStack(alignment: .leading, spacing: 2) {
          Text("Payment Proof").font(PrismTheme.body(14, weight: .semibold)).foregroundStyle(PrismTheme.ink)
          Text("See how Prism verified this payment").font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
        }
        Spacer()
        Image(systemName: "arrow.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(PrismTheme.faint)
      }
      .padding(15)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
    }
    .buttonStyle(.plainHit)
  }

  // MARK: TECHNICAL DETAILS (collapsed)
  private func technical(_ d: PaymentDisplay) -> some View {
    VStack(spacing: 0) {
      Button { withAnimation(.easeOut(duration: 0.16)) { showTechnical.toggle() } } label: {
        HStack {
          Text("View technical details").font(PrismTheme.body(13, weight: .medium)).foregroundStyle(PrismTheme.ink)
          Spacer()
          Image(systemName: showTechnical ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(PrismTheme.muted)
        }.padding(.vertical, 15).padding(.horizontal, 16)
      }.buttonStyle(.plainHit)
      if showTechnical {
        Divider().overlay(PrismTheme.line)
        VStack(spacing: 0) {
          ForEach(Array(d.technicalRows.enumerated()), id: \.offset) { idx, r in
            if r.label == "Transaction", let tx = d.payment.transactionHash {
              txRow(short: r.value, full: tx)
            } else {
              detailRow(r.label, r.value)
            }
            if idx < d.technicalRows.count - 1 { Divider().overlay(PrismTheme.line) }
          }
        }.padding(.horizontal, 16).padding(.bottom, 6)
      }
    }
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
  }

  private func txRow(short: String, full: String) -> some View {
    HStack(alignment: .top) {
      Text("Transaction").font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      VStack(alignment: .trailing, spacing: 8) {
        Text(short).font(PrismTheme.mono(11)).foregroundStyle(PrismTheme.ink).textSelection(.enabled)
        HStack(spacing: 14) {
          Button { UIPasteboard.general.string = full; PrismHaptics.tap() } label: {
            Label("Copy", systemImage: "doc.on.doc").font(PrismTheme.body(11, weight: .semibold))
          }
          if let url = Self.explorerURL(txHash: full) {
            Link(destination: url) { Label("Explorer", systemImage: "arrow.up.right.square").font(PrismTheme.body(11, weight: .semibold)) }
          }
        }.foregroundStyle(PrismTheme.mintDeep)
      }
    }.frame(minHeight: 46)
  }

  // MARK: SHARE (safe consumer receipt only)
  @ViewBuilder private func shareButton(_ d: PaymentDisplay) -> some View {
    ShareLink(item: Self.consumerReceiptText(d)) {
      Label("Share receipt", systemImage: "square.and.arrow.up")
        .font(PrismTheme.body(14.5, weight: .semibold)).frame(maxWidth: .infinity).frame(height: 50)
    }
    .buttonStyle(.plainHit).foregroundStyle(PrismTheme.mintDeep).background(PrismTheme.mintSoft)
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
  }

  // MARK: shared building blocks
  private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      PrismSectionLabel(text: title)
      VStack(spacing: 0) { content() }
        .padding(.horizontal, 16).padding(.vertical, 4)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private func detailRow(_ label: String, _ value: String) -> some View {
    HStack(alignment: .top) {
      Text(label).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      Text(value).font(PrismTheme.body(12.5, weight: .medium)).foregroundStyle(PrismTheme.ink)
        .multilineTextAlignment(.trailing)
    }.frame(minHeight: 44)
  }

  private func load() async {
    loading = true
    defer { loading = false }
    canonical = try? await PrismAPI.shared.canonicalPayment(presentation.operationId)
  }

  // Explorer link only when a real base URL is configured (Info.plist PRISM_EXPLORER_URL).
  static func explorerURL(txHash: String) -> URL? {
    guard let base = Bundle.main.object(forInfoDictionaryKey: "PRISM_EXPLORER_URL") as? String,
          !base.isEmpty else { return nil }
    return URL(string: "\(base.hasSuffix("/") ? base : base + "/")tx/\(txHash)")
  }

  // Safe shareable receipt — amount, identity, memo, date, status, branding. No address/phone/tx.
  static func consumerReceiptText(_ d: PaymentDisplay) -> String {
    var lines = ["Prism receipt", "", d.amountLine, d.title]
    if let h = d.handle { lines.append(h) }
    if let m = d.memo { lines.append("Note: \(m)") }
    if let date = d.dateLine, let time = d.timeLine { lines.append("\(date) · \(time)") }
    lines.append("Status: \(d.statusLabel)")
    lines.append("")
    lines.append("Sent with Prism")
    return lines.joined(separator: "\n")
  }
}

/// A single premium timeline step: dot + connector, done = filled check, current = pulsing ring.
private struct TimelineRow: View {
  let step: PrismTimelineStep
  let isLast: Bool
  @State private var showTime = false

  var body: some View {
    HStack(alignment: .top, spacing: 13) {
      VStack(spacing: 0) {
        dot
        if !isLast { Rectangle().fill(step.state == .done ? PrismTheme.mint.opacity(0.5) : PrismTheme.line).frame(width: 1.4, height: 26) }
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(step.title)
          .font(PrismTheme.body(13.5, weight: step.state == .upcoming ? .regular : .medium))
          .foregroundStyle(step.state == .upcoming ? PrismTheme.faint : PrismTheme.ink)
        if showTime, let ts = step.timestamp, let d = ISO8601DateFormatter().date(from: ts) {
          Text(d.formatted(date: .omitted, time: .standard)).font(PrismTheme.body(10.5)).foregroundStyle(PrismTheme.muted)
        }
      }
      .padding(.top, 1)
      Spacer()
    }
    .contentShape(Rectangle())
    .onTapGesture { if step.timestamp != nil { withAnimation(.easeOut(duration: 0.15)) { showTime.toggle() } } }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(step.title), \(accLabel)")
  }

  private var accLabel: String {
    switch step.state { case .done: "done"; case .current: "in progress"; case .upcoming: "not yet reached" }
  }

  @ViewBuilder private var dot: some View {
    switch step.state {
    case .done:
      Circle().fill(PrismTheme.mint).frame(width: 20, height: 20)
        .overlay(Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white))
    case .current:
      PulsingDot()
    case .upcoming:
      Circle().stroke(PrismTheme.line, lineWidth: 1.4).frame(width: 20, height: 20)
    }
  }
}

private struct PulsingDot: View {
  @State private var animate = false
  var body: some View {
    ZStack {
      Circle().fill(PrismTheme.mint.opacity(0.25)).frame(width: 20, height: 20).scaleEffect(animate ? 1.25 : 0.85)
      Circle().fill(PrismTheme.mintDeep).frame(width: 9, height: 9)
    }
    .frame(width: 20, height: 20)
    .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { animate = true } }
    .accessibilityHidden(true)
  }
}

#if DEBUG
#Preview("Completed direct") {
  PaymentDetailsView(presentation: PaymentDetailsPresentation(operationId: "x", fallback: .fixture()))
    .environmentObject(AppModel())
}
#Preview("Pending") {
  PaymentDetailsView(presentation: PaymentDetailsPresentation(operationId: "x", fallback: .fixture(lifecycleState: .confirming, completedAt: nil)))
    .environmentObject(AppModel())
}
#Preview("Refund incoming") {
  PaymentDetailsView(presentation: PaymentDetailsPresentation(operationId: "x", fallback: .fixture(kind: .refund, direction: .received, entryMethod: .claim, memo: nil, sender: .fx("Prism"), recipient: .fx("You"))))
    .environmentObject(AppModel())
}
#Preview("Claim protected") {
  PaymentDetailsView(presentation: PaymentDetailsPresentation(operationId: "x", fallback: .fixture(kind: .claimFunding, entryMethod: .claim, lifecycleState: .completed, memo: "For David", recipient: .fx("David"), claimId: "0xclaimabc123def456")))
    .environmentObject(AppModel())
}
#endif
