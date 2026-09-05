import SwiftUI

struct RequestMoneyView: View {
  let target: SendTarget
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var amount = ""
  @State private var memo = ""
  @State private var busy = false
  @State private var error: String?
  @State private var sent = false

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        PrismTopBar(title: "Request money", back: { dismiss() })
          .padding(.horizontal, 22)
          .padding(.top, 10)

        Spacer().frame(height: 20)
        PrismAvatar(initials: target.contact.initials, size: 72, highlighted: true)
        Text(target.contact.name)
          .font(PrismTheme.body(17, weight: .semibold))
          .padding(.top, 10)
        if let handle = target.contact.handle {
          Text(handle)
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
            .padding(.top, 2)
        }

        Spacer().frame(height: 24)
        AmountText(dollars: displayAmount, size: 78)

        HStack(spacing: 9) {
          Image(systemName: "pencil").font(.system(size: 13, weight: .medium)).foregroundStyle(PrismTheme.muted)
          TextField("Add a note", text: $memo).font(PrismTheme.body(13.5))
        }
        .padding(.horizontal, 15)
        .frame(height: 48)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
        .frame(maxWidth: 250)
        .padding(.top, 18)

        if let error {
          ErrorBanner(message: error).padding(.horizontal, 24).padding(.top, 10)
        }

        MoneyKeypad(value: $amount)
          .padding(.horizontal, 30)
          .padding(.top, 8)

        Spacer(minLength: 4)

        PrismPrimaryButton(
          title: busy ? "Sending request…" : (atomic == nil ? "Enter an amount" : "Review request"),
          enabled: atomic != nil && !busy,
          icon: "arrow.down.left"
        ) { Task { await submit() } }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
      }
      .prismScreen()

      if sent {
        ZStack {
          Color.black.opacity(0.18).ignoresSafeArea()
          VStack(spacing: 16) {
            Circle().fill(PrismTheme.mintSoft).frame(width: 82, height: 82).overlay(
              Image(systemName: "checkmark").font(.system(size: 29, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
            )
            Text("Request sent").font(PrismTheme.display(34))
            Text("\(displayAmount) requested from \(target.contact.name).")
              .font(PrismTheme.body(14))
              .foregroundStyle(PrismTheme.muted)
              .multilineTextAlignment(.center)
            PrismPrimaryButton(title: "Done") { dismiss() }
          }
          .padding(28)
          .background(PrismTheme.paper)
          .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
          .prismCardShadow()
          .padding(28)
        }
      }
    }
  }

  private var atomic: String? {
    guard let value = Money.atomic(fromDollars: amount), value != "0" else { return nil }
    return value
  }

  private var displayAmount: String {
    amount.isEmpty
      ? "$0.00"
      : (Decimal(string: amount) ?? 0).formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }

  private func submit() async {
    guard let atomic, let payer = target.resolution.attestation?.prismIdentity else { return }
    busy = true
    defer { busy = false }

    do {
      let draft = try await PrismAPI.shared.draftRequest(
        payerPrismId: payer,
        amountAtomic: atomic,
        memo: memo
      )
      _ = try await PrismAPI.shared.commitRequest(draft)
      sent = true
    } catch {
      self.error = error.localizedDescription
    }
  }
}
