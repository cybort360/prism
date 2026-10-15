import SwiftUI

/// Plain button styling (no tint, no system chrome) but with the entire label rect tappable, not just
/// the drawn text/icon. SwiftUI's `.plain` only hit-tests rendered content, so a stretched label (via
/// `frame(maxWidth:.infinity)` or a `Spacer`) leaves its empty area dead. Use `.buttonStyle(.plainHit)`
/// everywhere `.plain` was used so the whole button, row, or field responds to a tap.
struct PlainHitButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.6 : 1)
  }
}
extension ButtonStyle where Self == PlainHitButtonStyle {
  static var plainHit: PlainHitButtonStyle { .init() }
}

struct PrismPrimaryButton: View {
  let title: String
  var enabled = true
  var icon: String? = nil
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 9) {
        if let icon { Image(systemName: icon).font(.system(size: 15, weight: .semibold)) }
        Text(title).font(PrismTheme.body(16, weight: .semibold))
      }
      .frame(maxWidth: .infinity)
      .frame(height: 56)
    }
    .buttonStyle(.plainHit)
    .foregroundStyle(enabled ? .white : PrismTheme.faint)
    .background(enabled ? PrismTheme.mintDeep : PrismTheme.line.opacity(0.75))
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .shadow(color: enabled ? PrismTheme.mintDeep.opacity(0.12) : .clear, radius: 14, y: 7)
    .disabled(!enabled)
  }
}

struct PrismSecondaryButton: View {
  let title: String
  var icon: String? = nil
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if let icon { Image(systemName: icon).font(.system(size: 14, weight: .semibold)) }
        Text(title).font(PrismTheme.body(15, weight: .semibold))
      }
      .frame(maxWidth: .infinity)
      .frame(height: 52)
    }
    .buttonStyle(.plainHit)
    .foregroundStyle(PrismTheme.ink)
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
  }
}

struct PrismCard<Content: View>: View {
  @ViewBuilder var content: Content
  var padding: CGFloat = 18

  init(padding: CGFloat = 18, @ViewBuilder content: () -> Content) {
    self.padding = padding
    self.content = content()
  }

  init(content: Content, padding: CGFloat = 18) {
    self.content = content
    self.padding = padding
  }

  var body: some View {
    content
      .padding(padding)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .stroke(PrismTheme.line.opacity(0.75), lineWidth: 0.6)
      )
      .prismCardShadow()
  }
}

struct PrismAvatar: View {
  let initials: String
  var size: CGFloat = 46
  var highlighted: Bool = false
  var tone: Color? = nil

  private let palette = [PrismTheme.rose, PrismTheme.mintSoft, PrismTheme.sand, PrismTheme.lavender, PrismTheme.sky]

  private var stableToneIndex: Int {
    initials.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % palette.count }
  }

  private var background: Color {
    tone ?? palette[stableToneIndex]
  }

  var body: some View {
    ZStack {
      Circle().fill(background)
      Text(initials)
        .font(PrismTheme.body(size * 0.33, weight: .semibold))
        .foregroundStyle(PrismTheme.ink.opacity(0.82))
    }
    .frame(width: size, height: size)
    .overlay(Circle().stroke(highlighted ? PrismTheme.mint : Color.white.opacity(0.8), lineWidth: highlighted ? 2 : 1))
    .shadow(color: PrismTheme.midnight.opacity(0.035), radius: 7, y: 3)
  }
}

struct PrismSectionLabel: View {
  let text: String
  var body: some View {
    Text(text.uppercased())
      .font(PrismTheme.body(10.5, weight: .semibold))
      .tracking(1.55)
      .foregroundStyle(PrismTheme.muted)
  }
}

struct AmountText: View {
  let dollars: String
  var size: CGFloat = 72
  var body: some View {
    Text(dollars)
      .font(PrismTheme.display(size))
      .tracking(-2.2)
      .monospacedDigit()
      .minimumScaleFactor(0.5)
      .lineLimit(1)
  }
}

struct PrismIconTile: View {
  let icon: String
  var selected = false

  var body: some View {
    Image(systemName: icon)
      .font(.system(size: 19, weight: .medium))
      .foregroundStyle(selected ? .white : PrismTheme.ink)
      .frame(width: 54, height: 54)
      .background(selected ? PrismTheme.mintDeep : PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 18, style: .continuous)
          .stroke(selected ? Color.clear : PrismTheme.line, lineWidth: 0.6)
      )
      .prismCardShadow()
  }
}

struct PrismHeaderIconButton: View {
  let icon: String
  var hasDot = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: icon)
        .font(.system(size: 16, weight: .medium))
        .frame(width: 42, height: 42)
        .background(PrismTheme.paper)
        .clipShape(Circle())
        .overlay(Circle().stroke(PrismTheme.line, lineWidth: 0.6))
        .overlay(alignment: .topTrailing) {
          if hasDot {
            Circle().fill(PrismTheme.mint).frame(width: 7, height: 7).offset(x: -2, y: 3)
          }
        }
    }
    .buttonStyle(.plainHit)
  }
}

struct PrismMetricPill: View {
  let text: String
  var positive = true

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: positive ? "arrow.up.right" : "arrow.down.right")
        .font(.system(size: 10, weight: .bold))
      Text(text).font(PrismTheme.body(11.5, weight: .semibold))
    }
    .foregroundStyle(positive ? PrismTheme.mintDeep : PrismTheme.danger)
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .background((positive ? PrismTheme.mintSoft : PrismTheme.danger.opacity(0.08)))
    .clipShape(Capsule())
  }
}

struct PrismTabBar: View {
  @Binding var selection: MainTab

  var body: some View {
    HStack(spacing: 0) {
      ForEach(MainTab.barTabs) { tab in
        Button {
          withAnimation(.easeOut(duration: 0.18)) { selection = tab }
        } label: {
          ZStack {
            if selection == tab {
              Circle().fill(PrismTheme.mintSoft).frame(width: 44, height: 44)
            }
            Image(systemName: tab.icon)
              .font(.system(size: 18, weight: selection == tab ? .semibold : .medium))
              .foregroundStyle(selection == tab ? PrismTheme.mintDeep : PrismTheme.muted)
          }
          .frame(maxWidth: .infinity, minHeight: 52)
          .accessibilityLabel(tab.title)
        }
        .buttonStyle(.plainHit)
      }
    }
    .padding(.horizontal, 26)
    .padding(.top, 6)
    .padding(.bottom, 6)
    .background(PrismTheme.paper.opacity(0.97))
    .overlay(alignment: .top) { Rectangle().fill(PrismTheme.line).frame(height: 0.6) }
  }
}

struct PrismLoadingRow: View {
  var body: some View {
    HStack {
      ProgressView().tint(PrismTheme.mintDeep)
      Text("Loading…").font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted)
      Spacer()
    }
  }
}

struct PrismEmptyState: View {
  let icon: String
  let title: String
  let detail: String

  var body: some View {
    VStack(spacing: 14) {
      Circle().fill(PrismTheme.mintSoft).frame(width: 74, height: 74).overlay(
        Image(systemName: icon).font(.system(size: 24, weight: .medium)).foregroundStyle(PrismTheme.mintDeep)
      )
      Text(title).font(PrismTheme.body(18, weight: .semibold))
      Text(detail).font(PrismTheme.body(14)).foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center).frame(maxWidth: 300)
    }.frame(maxWidth: .infinity)
  }
}

struct PrismTopBar: View {
  let title: String
  var back: (() -> Void)? = nil
  var trailing: AnyView? = nil

  var body: some View {
    HStack {
      if let back {
        PrismHeaderIconButton(icon: "chevron.left", action: back)
      } else {
        Color.clear.frame(width: 42, height: 42)
      }
      Spacer()
      Text(title.uppercased())
        .font(PrismTheme.body(10.5, weight: .semibold))
        .tracking(1.9)
      Spacer()
      if let trailing { trailing.frame(width: 42, height: 42) }
      else { Color.clear.frame(width: 42, height: 42) }
    }
  }
}

struct PrismSheetHeader: View {
  let title: String
  let subtitle: String
  let close: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        Text(title)
          .font(PrismTheme.display(34))
          .tracking(-0.7)
          .lineLimit(1)
          .minimumScaleFactor(0.82)
        Text(subtitle)
          .font(PrismTheme.body(13))
          .foregroundStyle(PrismTheme.muted)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      PrismHeaderIconButton(icon: "xmark", action: close)
        .padding(.top, 2)
    }
    .padding(.horizontal, 28)
    .padding(.top, 22)
  }
}

struct ErrorBanner: View {
  let message: String
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.circle.fill").foregroundStyle(PrismTheme.danger)
      Text(message).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(14)
    .background(PrismTheme.danger.opacity(0.065))
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
  }
}

struct SuccessBanner: View {
  let message: String
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "checkmark.circle.fill").foregroundStyle(PrismTheme.positive)
      Text(message).font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(14)
    .background(PrismTheme.positive.opacity(0.09))
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
  }
}

enum PrismStatusTone { case positive, pending, danger, neutral }

struct PrismStatusPill: View {
  let text: String
  var tone: PrismStatusTone = .neutral

  private var color: Color {
    switch tone {
    case .positive: PrismTheme.positive
    case .pending: PrismTheme.amber
    case .danger: PrismTheme.danger
    case .neutral: PrismTheme.pending
    }
  }

  var body: some View {
    Text(text)
      .font(PrismTheme.body(9.5, weight: .semibold))
      .foregroundStyle(color)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(color.opacity(0.075))
      .clipShape(Capsule())
  }
}

struct EmptyStateView: View {
  let icon: String
  let title: String
  let bodyText: String

  var body: some View {
    VStack(spacing: 12) {
      Circle().fill(PrismTheme.mintSoft).frame(width: 66, height: 66).overlay(
        Image(systemName: icon).foregroundStyle(PrismTheme.mintDeep)
      )
      Text(title).font(PrismTheme.body(17, weight: .semibold))
      Text(bodyText).font(PrismTheme.body(13)).foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
    }.frame(maxWidth: .infinity).padding(.vertical, 48)
  }
}

struct OperationStateOverlay: View {
  let state: PaymentCoordinator.State
  /// Recovery: dismiss a terminal non-success state so the payer can try again (wrong PIN, Face ID
  /// cancelled, a transient failure). Nil keeps the overlay non-dismissible (in-progress states).
  var onDismiss: (() -> Void)? = nil
  /// A pending payment routes the payer to Activity, which reconciles from chain truth.
  var onViewActivity: (() -> Void)? = nil

  private var isFailed: Bool { if case .failed = state { return true }; return false }
  private var isPending: Bool { if case .pendingReview = state { return true }; return false }

  var body: some View {
    if state != .idle {
      ZStack {
        Color.black.opacity(0.20).ignoresSafeArea()
        VStack(spacing: 16) {
          icon
          Text(label)
            .font(PrismTheme.display(isFailed || isPending ? 21 : 26))
            .multilineTextAlignment(.center)
            .lineSpacing(isFailed || isPending ? 2 : 0)
          actions
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 28)
        .frame(maxWidth: 320)
        .background(PrismTheme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .prismCardShadow()
      }
      .transition(.opacity)
    }
  }

  @ViewBuilder private var icon: some View {
    if case .sent = state {
      Circle().fill(PrismTheme.mintSoft).frame(width: 72, height: 72).overlay(
        Image(systemName: "checkmark").font(.system(size: 27, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep))
    } else if isPending {
      Circle().fill(PrismTheme.amber.opacity(0.10)).frame(width: 72, height: 72).overlay(
        Image(systemName: "clock.badge.checkmark").font(.system(size: 26, weight: .medium)).foregroundStyle(PrismTheme.amber))
    } else if isFailed {
      Circle().fill(PrismTheme.danger.opacity(0.08)).frame(width: 72, height: 72).overlay(
        Image(systemName: "exclamationmark").font(.system(size: 27, weight: .semibold)).foregroundStyle(PrismTheme.danger))
    } else {
      ProgressView().tint(PrismTheme.mintDeep).scaleEffect(1.15)
    }
  }

  @ViewBuilder private var actions: some View {
    if isPending {
      VStack(spacing: 8) {
        if let onViewActivity {
          PrismPrimaryButton(title: "View in Activity", icon: "chart.bar.xaxis") { onViewActivity() }
        }
        if let onDismiss {
          Button("Done") { onDismiss() }
            .font(PrismTheme.body(14, weight: .semibold)).foregroundStyle(PrismTheme.muted)
        }
      }
      .padding(.top, 4)
    } else if isFailed, let onDismiss {
      Button {
        onDismiss()
      } label: {
        Text("Try again").font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
          .frame(maxWidth: .infinity).frame(height: 50)
          .background(PrismTheme.mintSoft).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      }
      .buttonStyle(.plainHit)
      .padding(.top, 4)
    }
  }

  private var label: String {
    switch state {
    case .idle: ""
    case .preparing: "Preparing…"
    case .awaitingAuthorization: "Awaiting approval…"
    case .sending: "Sending…"
    case .settling: "Confirming your payment…"
    case .sent: "Sent"
    case .pendingReview(let message): message
    case .failed(let message): message
    }
  }
}

extension PaymentCoordinator.State {
  /// A Circle action's lifecycle mirrors a personal payment's, so `OperationStateOverlay` renders both
  /// with the same vocabulary. This maps the sibling coordinator's state onto the one the overlay reads.
  init(_ circle: CircleCoordinator.State) {
    switch circle {
    case .idle: self = .idle
    case .preparing: self = .preparing
    case .awaitingAuthorization: self = .awaitingAuthorization
    case .sending: self = .sending
    case .settling: self = .settling
    case .sent(let tx): self = .sent(tx)
    case .pendingReview(let message): self = .pendingReview(message)
    case .failed(let message): self = .failed(message)
    }
  }
}

extension OperationStateOverlay {
  /// Drive the overlay directly from a `CircleCoordinator.State` (Circle add-money / pay / approve).
  init(state: CircleCoordinator.State, onDismiss: (() -> Void)? = nil, onViewActivity: (() -> Void)? = nil) {
    self.init(state: PaymentCoordinator.State(state), onDismiss: onDismiss, onViewActivity: onViewActivity)
  }
}
