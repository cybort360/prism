import SwiftUI

/// Developer/judge Proof surface. Not part of the normal consumer UX — shown only from the DEBUG
/// "Developer" section in Profile. Reads live Alchemy chain state + the Envio index via the backend
/// proof/metrics endpoints.
struct ProofView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var metrics: MetricsSnapshot?
  @State private var paymentId = ""
  @State private var proof: PaymentProof?
  @State private var error: String?
  @State private var loading = false

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 18) {
        PrismTopBar(title: "Payment proof", back: { dismiss() }).padding(.top, 10)

        Text("Developer / judge tools")
          .font(PrismTheme.display(30)).tracking(-0.5)

        if let m = metrics { metricsCard(m) }

        lookupCard

        if let p = proof { proofCard(p) }
        if let error { ErrorBanner(message: error) }
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 28)
    }
    .task { metrics = try? await PrismAPI.shared.metrics() }
    .prismScreen()
  }

  private func metricsCard(_ m: MetricsSnapshot) -> some View {
    PrismCard {
      VStack(alignment: .leading, spacing: 12) {
        PrismSectionLabel(text: "Infrastructure")
        kv("RPC provider", m.chain.provider)
        kv("RPC host", m.chain.rpcHost)
        kv("Envio indexer", (m.envio?.available == true) ? "connected" : "not configured")
        Divider().overlay(PrismTheme.line)
        PrismSectionLabel(text: "Latency P50 / P95 (ms)")
        ForEach(["payment_prepare_ms", "signing_wait_ms", "relay_submit_ms", "chain_confirmation_ms", "envio_index_ms", "end_to_end_payment_ms"], id: \.self) { key in
          if let l = m.latencies[key] {
            kv(key.replacingOccurrences(of: "_ms", with: ""), "\(fmt(l.p50)) / \(fmt(l.p95))  (n=\(l.count))")
          }
        }
        if let op = m.operations["payment"] {
          Divider().overlay(PrismTheme.line)
          kv("Payments ok / fail", "\(op.success) / \(op.failure)")
          kv("Failure rate", String(format: "%.1f%%", op.failureRate * 100))
        }
      }
    }
  }

  private var lookupCard: some View {
    PrismCard {
      VStack(alignment: .leading, spacing: 12) {
        PrismSectionLabel(text: "Payment proof by id")
        TextField("0x… paymentId", text: $paymentId)
          .font(PrismTheme.mono(11))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .padding(12)
          .background(PrismTheme.canvas)
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        PrismSecondaryButton(title: loading ? "Loading…" : "Fetch proof", icon: "magnifyingglass") {
          Task { await fetch() }
        }
      }
    }
  }

  private func proofCard(_ p: PaymentProof) -> some View {
    PrismCard {
      VStack(alignment: .leading, spacing: 10) {
        PrismSectionLabel(text: "On-chain proof")
        kv("Network", "\(p.network.provider) · chain \(p.network.chainId)")
        kv("AUSD", short(p.ausd))
        kv("Mera account", short(p.meraAccount))
        kv("Recipient", short(p.recipient))
        kv("Sender MON", p.senderMonBalance ?? "—")
        kv("Sender AUSD", p.senderAusdBalance ?? "—")
        kv("Recipient AUSD before→after", "\(p.recipientAusdBefore ?? "—") → \(p.recipientAusdAfter ?? "—")")
        Divider().overlay(PrismTheme.line)
        kv("State", p.state)
        kv("Tx hash", short(p.txHash))
        kv("Block", p.blockNumber ?? "—")
        kv("Submitted", timeOnly(p.submittedAt))
        kv("Confirmed", timeOnly(p.confirmedAt))
        kv("Indexed", p.indexed ? timeOnly(p.indexedAt) : "indexing…")
        if let rid = p.requestId { kv("Request binding", short(rid)) }
      }
    }
  }

  private func fetch() async {
    error = nil; proof = nil; loading = true
    defer { loading = false }
    do { proof = try await PrismAPI.shared.paymentProof(paymentId.trimmingCharacters(in: .whitespacesAndNewlines)) }
    catch { self.error = error.localizedDescription }
  }

  private func kv(_ k: String, _ v: String) -> some View {
    HStack(alignment: .top) {
      Text(k).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
      Spacer()
      Text(v).font(PrismTheme.mono(11)).foregroundStyle(PrismTheme.ink)
        .multilineTextAlignment(.trailing).textSelection(.enabled)
    }
  }
  private func fmt(_ v: Double?) -> String { v == nil ? "—" : String(format: "%.0f", v!) }
  private func short(_ v: String?) -> String {
    guard let v, v.count > 14 else { return v ?? "—" }
    return "\(v.prefix(6))…\(v.suffix(6))"
  }
  private func timeOnly(_ iso: String?) -> String {
    guard let iso, let d = ISO8601DateFormatter().date(from: iso) else { return "—" }
    return d.formatted(date: .omitted, time: .standard)
  }
}
