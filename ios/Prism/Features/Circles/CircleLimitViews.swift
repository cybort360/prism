import SwiftUI

/// The three numbers, wherever a member is about to spend.
///
/// ```
/// Daily limit   $100.00
/// Spent today   $42.00
/// Available     $58.00
/// ```
///
/// Every one of them came from the Allowance Module on the read that produced this view — none is
/// summed from Prism's activity, which would drift the moment a period rolled over. The bar shows
/// what the pending amount would consume, so a person watches their headroom shrink as they type
/// rather than discovering the limit at the confirm button.
struct CircleLimitStrip: View {
  let limit: CircleSpendingLimit
  /// The amount being typed, in atomic units, to preview against the remaining headroom.
  var spending: String?

  private var wouldExceed: Bool {
    guard let spending, let available = limit.availableAtomic,
      let want = Decimal(string: spending), let have = Decimal(string: available)
    else { return false }
    return want > have
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text(periodTitle)
          .font(PrismTheme.body(12, weight: .semibold))
          .foregroundStyle(PrismTheme.muted)
        Spacer()
        Text(limit.limitDisplay ?? "-")
          .font(PrismTheme.body(13, weight: .semibold))
          .monospacedDigit()
      }

      meter

      HStack {
        Text("Spent \(spentLabel) \(limit.spentDisplay ?? "-")")
          .font(PrismTheme.body(11.5))
          .foregroundStyle(PrismTheme.muted)
        Spacer()
        Text("\(limit.availableDisplay ?? "-") available")
          .font(PrismTheme.body(11.5, weight: .semibold))
          .foregroundStyle(wouldExceed ? PrismTheme.amber : PrismTheme.mintDeep)
          .monospacedDigit()
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PrismTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 15, style: .continuous)
        .stroke(wouldExceed ? PrismTheme.amber.opacity(0.45) : PrismTheme.line, lineWidth: 0.8))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(periodTitle) \(limit.limitDisplay ?? ""), \(limit.availableDisplay ?? "") available")
  }

  private var meter: some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(PrismTheme.line.opacity(0.7))
        Capsule()
          .fill(wouldExceed ? PrismTheme.amber : PrismTheme.mintDeep)
          .frame(width: max(3, geo.size.width * (limit.usedFraction ?? 0)))
      }
    }
    .frame(height: 6)
  }

  private var periodTitle: String {
    switch limit.period {
    case "DAILY": return "Daily limit"
    case "WEEKLY": return "Weekly limit"
    case "MONTHLY": return "Monthly limit"
    case "TOTAL": return "Total budget"
    default: return "Spending limit"
    }
  }

  private var spentLabel: String {
    switch limit.period {
    case "DAILY": return "today"
    case "WEEKLY": return "this week"
    case "MONTHLY": return "this month"
    default: return "so far"
    }
  }
}

/// What a member sees when their payment is larger than their limit.
///
/// This is deliberately not an error screen. Nothing has gone wrong: they are doing something that
/// needs the Circle's agreement instead of their own, and the useful thing to show is the limit they
/// are past, how many admins would have to agree, and a way to ask them.
struct CircleOverLimitSheet: View {
  let preview: CirclePaymentPreview
  let circleName: String
  let requestApproval: () -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      Capsule().fill(PrismTheme.line).frame(width: 38, height: 5).padding(.top, 10)

      ZStack {
        Circle().fill(PrismTheme.amber.opacity(0.10)).frame(width: 66, height: 66)
        Image(systemName: "hand.raised.fill")
          .font(.system(size: 23, weight: .medium))
          .foregroundStyle(PrismTheme.amber)
      }
      .padding(.top, 26)

      Text(preview.reason ?? "This is above your spending limit.")
        .font(PrismTheme.display(25))
        .tracking(-0.4)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(.horizontal, 28)
        .padding(.top, 18)

      if let limit = preview.limit, limit.hasSpendingAccess {
        CircleLimitStrip(limit: limit, spending: preview.amountAtomic)
          .padding(.horizontal, 24)
          .padding(.top, 20)
      }

      Text(preview.prompt ?? "Request approval from the Circle?")
        .font(PrismTheme.body(14.5, weight: .semibold))
        .padding(.top, 22)

      Text(approvalDetail)
        .font(PrismTheme.body(12.5))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .padding(.horizontal, 30)
        .padding(.top, 6)

      Spacer()

      VStack(spacing: 10) {
        PrismPrimaryButton(title: "Request approval", icon: "person.2.fill") {
          dismiss()
          requestApproval()
        }
        PrismSecondaryButton(title: "Not now", icon: "xmark") { dismiss() }
      }
      .padding(24)
    }
    .prismScreen()
  }

  private var approvalDetail: String {
    guard let required = preview.requiredApprovals else {
      return "\(circleName)'s admins will be asked to approve this payment. Nothing moves until they do."
    }
    return "\(required) admin\(required == 1 ? "" : "s") of \(circleName) will be asked to approve it. Nothing moves until they do."
  }
}
