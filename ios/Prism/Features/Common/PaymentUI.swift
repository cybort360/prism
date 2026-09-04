import SwiftUI

struct MoneyKeypad: View {
  @Binding var value: String
  var body: some View { DigitPad(value: $value, maxDigits: 10, allowsDecimal: true) }
}

struct StablecoinPicker: View {
  @Binding var selection: Stablecoin
  var locked = false

  var body: some View {
    Picker("Asset", selection: $selection) {
      ForEach(Stablecoin.allCases) { asset in
        Text(asset.rawValue).tag(asset)
      }
    }
    .pickerStyle(.segmented)
    .disabled(locked)
    .frame(maxWidth: 230)
    .accessibilityHint(locked ? "This payment request fixes the asset" : "Choose AUSD or USDC")
  }
}

struct PaymentAuthorizationSheet: View {
  let amount: String
  let approve: (String?, Bool) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var pin = ""
  @State private var error: String?

  var body: some View {
    VStack(spacing: 0) {
      Capsule().fill(PrismTheme.line).frame(width: 38, height: 5).padding(.top, 10)

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 68, height: 68)
        Image(systemName: "checkmark.shield.fill")
          .font(.system(size: 25, weight: .medium))
          .foregroundStyle(PrismTheme.mintDeep)
      }
      .padding(.top, 28)

      Text("Approve payment")
        .font(PrismTheme.display(31))
        .tracking(-0.5)
        .padding(.top, 18)

      Text(amount)
        .font(PrismTheme.display(48))
        .tracking(-1.2)
        .monospacedDigit()
        .padding(.top, 5)

      if UserDefaults.standard.bool(forKey: "payments.faceID") {
        Button {
          dismiss()
          approve(nil, true)
        } label: {
          Label("Use Face ID", systemImage: "faceid")
            .font(PrismTheme.body(14.5, weight: .semibold))
            .frame(maxWidth: .infinity)
            .frame(height: 52)
        }
        .buttonStyle(.plain)
        .foregroundStyle(PrismTheme.mintDeep)
        .background(PrismTheme.mintSoft)
        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
        .padding(.top, 22)

        HStack(spacing: 12) {
          Rectangle().fill(PrismTheme.line).frame(height: 1)
          Text("or PIN").font(PrismTheme.body(10.5, weight: .medium)).foregroundStyle(PrismTheme.muted)
          Rectangle().fill(PrismTheme.line).frame(height: 1)
        }
        .padding(.vertical, 20)
      } else {
        Spacer().frame(height: 24)
      }

      HStack(spacing: 13) {
        ForEach(0..<6, id: \.self) { index in
          Circle()
            .fill(index < pin.count ? PrismTheme.mintDeep : Color.clear)
            .overlay(Circle().stroke(index < pin.count ? PrismTheme.mintDeep : PrismTheme.faint, lineWidth: 1))
            .frame(width: 11, height: 11)
        }
      }

      DigitPad(value: $pin, maxDigits: 6)
        .padding(.top, 17)

      if let error {
        Text(error)
          .font(PrismTheme.body(11.5))
          .foregroundStyle(PrismTheme.danger)
          .padding(.top, 7)
      }

      Spacer(minLength: 12)

      PrismPrimaryButton(title: "Approve", enabled: pin.count == 6, icon: "checkmark") {
        guard pin.count == 6 else {
          error = "Enter your six-digit payment PIN."
          return
        }
        let entered = pin
        dismiss()
        approve(entered, false)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
    .presentationDetents([.large])
    .presentationDragIndicator(.hidden)
    .prismScreen()
  }
}

struct PINAuthorizationSheet: View {
  @Binding var pin: String
  let title: String
  let approve: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      Capsule().fill(PrismTheme.line).frame(width: 38, height: 5).padding(.top, 10)

      Text(title)
        .font(PrismTheme.display(31))
        .tracking(-0.5)
        .padding(.top, 34)

      HStack(spacing: 13) {
        ForEach(0..<6, id: \.self) { index in
          Circle()
            .fill(index < pin.count ? PrismTheme.mintDeep : Color.clear)
            .overlay(Circle().stroke(index < pin.count ? PrismTheme.mintDeep : PrismTheme.faint, lineWidth: 1))
            .frame(width: 11, height: 11)
        }
      }
      .padding(.vertical, 25)

      DigitPad(value: $pin, maxDigits: 6)
      Spacer()

      PrismPrimaryButton(title: "Approve", enabled: pin.count == 6, icon: "checkmark") {
        dismiss()
        approve()
      }
    }
    .padding(24)
    .presentationDragIndicator(.hidden)
    .prismScreen()
  }
}
