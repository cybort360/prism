import SwiftUI

struct RequestDetailView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let request: PaymentRequestRecord
  @State private var error: String?
  @State private var busy = false

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

      Text(request.tokenSymbol ?? Stablecoin.resolve(symbol: nil, address: request.token).rawValue)
        .font(PrismTheme.body(12, weight: .semibold))
        .foregroundStyle(PrismTheme.mintDeep)
        .padding(.top, 6)

      Text(request.memo.isEmpty ? "Payment request" : request.memo)
        .font(PrismTheme.body(14))
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 8)

      PrismStatusPill(text: request.status.capitalized, tone: request.status == "OPEN" ? .pending : .positive)
        .padding(.top, 16)

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
  }

  private func pay() async {
    do {
      let resolution = try await PrismAPI.shared.resolve(prismId: request.requesterPrismId)
      guard resolution.found else { throw APIError.server("Requester is unavailable.") }
      let contact = ContactPerson(
        id: "request:\(request.requestId)",
        name: "Prism requester",
        phone: nil,
        initials: "PR",
        prismState: .onPrism(resolution)
      )
      dismiss()
      model.presentSend = SendTarget(
        contact: contact,
        resolution: resolution,
        requestId: request.requestId,
        requestedAsset: Stablecoin.resolve(symbol: request.tokenSymbol, address: request.token)
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
