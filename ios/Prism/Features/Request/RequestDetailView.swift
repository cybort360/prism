import SwiftUI

struct RequestDetailView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let request: PaymentRequestRecord
  @State private var error: String?
  @State private var busy = false
  @State private var sweepStatus: RequestStatusResponse?

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Request")
          .font(PrismTheme.display(35))
          .tracking(-0.5)
        Spacer()
        PrismHeaderIconButton(icon: "xmark") { dismiss() }
      }
      .padding(.top, 10)

      Spacer()

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 88, height: 88)
        Image(systemName: "arrow.down.left")
          .font(.system(size: 30, weight: .medium))
          .foregroundStyle(PrismTheme.mintDeep)
      }

      AmountText(dollars: Money.dollars(fromAtomic: request.amountAtomic), size: 67)
        .padding(.top, 22)


      Text(request.memo.isEmpty ? "Payment request" : request.memo)
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 8)

      PrismStatusPill(text: request.status.capitalized, tone: request.status == "OPEN" ? .pending : .positive)
        .padding(.top, 16)

      if let destination = sweepStatus?.destination,
         destination == "CIRCLE" || destination == "SAVINGS",
         let sweep = sweepStatus?.sweep {
        SweepIntentCard(destination: destination, sweep: sweep)
          .padding(.top, 14)
      }

      Spacer()

      if request.status == "OPEN", let me = model.identity?.prismId {
        if request.payerPrismId == me {
          PrismPrimaryButton(title: "Pay request", icon: "arrow.up.right") {
            Task { await pay() }
          }
          Button("Decline") { Task { await status("DECLINED") } }
            .font(PrismTheme.body(13.5, weight: .semibold))
            .foregroundStyle(PrismTheme.danger)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
        } else if request.requesterPrismId == me {
          PrismSecondaryButton(title: busy ? "Cancelling…" : "Cancel request", icon: "xmark") {
            Task { await status("CANCELLED") }
          }
        }
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 24)
    .prismScreen()
    .alert("Prism", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") { error = nil }
    } message: {
      Text(error ?? "")
    }
    .task { await loadSweepStatus() }
  }

  /// Loads the requester's sweep view once, then polls a few times while a sweep is in flight —
  /// each read also nudges the backend to retry a stuck PENDING sweep, so this both reflects and
  /// helps drive the request toward SWEPT/FAILED.
  private func loadSweepStatus() async {
    sweepStatus = try? await PrismAPI.shared.requestStatus(request.requestId)
    var attempts = 0
    while attempts < 5,
          let state = sweepStatus?.sweep?.state,
          state == "PENDING" || state == "SUBMITTED" {
      attempts += 1
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      if let updated = try? await PrismAPI.shared.requestStatus(request.requestId) {
        sweepStatus = updated
      }
    }
  }

  private func pay() async {
    do {
      let resolution = try await PrismAPI.shared.resolve(prismId: request.requesterPrismId)
      guard resolution.found else { throw APIError.server("Requester is unavailable.") }
      let label = request.requesterLabel
      let seed = request.requesterHandle ?? request.requesterDisplayName ?? "PR"
      let contact = ContactPerson(
        id: "request:\(request.requestId)",
        name: label,
        phone: nil,
        initials: String(seed.prefix(2)).uppercased(),
        handle: request.requesterHandle.map { "@\($0)" },
        prismState: .onPrism(resolution)
      )
      dismiss()
      model.presentSend = SendTarget(
        contact: contact,
        resolution: resolution,
        requestId: request.requestId
      )
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func status(_ value: String) async {
    busy = true
    defer { busy = false }

    do {
      _ = try await PrismAPI.shared.setRequestStatus(request.requestId, status: value)
      dismiss()
      model.notify(value == "DECLINED" ? "Request declined" : "Request cancelled")
    } catch {
      self.error = error.localizedDescription
    }
  }
}

/// Honest sweep state for a CIRCLE/SAVINGS request. Never claims "deposited" outside SWEPT —
/// a FAILED sweep still means the money is safe (received into the balance), just not moved yet.
private struct SweepIntentCard: View {
  let destination: String
  let sweep: RequestSweepState

  private var destinationLabel: String { destination == "SAVINGS" ? "Savings" : "your Circle" }

  private var icon: String {
    switch sweep.state {
    case "SWEPT": "checkmark.circle.fill"
    case "FAILED": "exclamationmark.circle.fill"
    case "SUBMITTED": "arrow.triangle.2.circlepath"
    default: "clock.fill"
    }
  }

  private var tint: Color {
    switch sweep.state {
    case "SWEPT": PrismTheme.positive
    case "FAILED": PrismTheme.amber
    default: PrismTheme.muted
    }
  }

  private var message: String {
    switch sweep.state {
    case "PREPARING", "PENDING":
      "Auto-deposits into \(destinationLabel) when it's paid."
    case "SUBMITTED":
      "Depositing into \(destinationLabel)…"
    case "SWEPT":
      "Deposited into \(destinationLabel)."
    case "FAILED":
      "Received in your balance — couldn't auto-move to \(destinationLabel)."
    default:
      "Auto-deposits into \(destinationLabel) when it's paid."
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: icon)
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(tint)
      Text(message)
        .font(PrismTheme.body(12))
        .foregroundStyle(PrismTheme.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
      if destination == "SAVINGS" {
        Text("DEMO")
          .font(PrismTheme.body(9, weight: .bold))
          .tracking(0.6)
          .foregroundStyle(PrismTheme.amber)
          .padding(.horizontal, 7)
          .padding(.vertical, 3)
          .background(PrismTheme.amber.opacity(0.12))
          .clipShape(Capsule())
      }
    }
    .padding(12)
    .background(tint.opacity(0.07))
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}
