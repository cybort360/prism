import SwiftUI

/// Every state a Circle screen can be in that is *not* "here is your money".
///
/// This exists as one enum, separate from any view, for two reasons. The first is that a Circle has
/// more honest-but-unhappy states than any other part of Prism — it can be waiting on Monad, waiting
/// on a person, or holding a proposal that can never execute — and scattering that copy across six
/// screens guarantees they drift apart. The second is the rule in `CircleStateCopy.action`: **every
/// state names something the person can actually do next.** A state with no next action is a dead
/// end, and a dead end in a shared-money product is where people start guessing.
///
/// `tone` never travels alone. Each carries a symbol, so no status in Circles is distinguishable
/// only by colour — the accessibility requirement that rules out a bare green or red dot.
enum CircleState: Equatable {
  /// The person is in no Circles yet.
  case noCircles
  /// A Circle exists but nobody else is in it.
  case noMembers
  /// Active, verified, and holding nothing.
  case noBalance(circleName: String)
  /// Nothing is waiting on this admin.
  case noPendingApprovals
  /// Created, and still working its way onto Monad.
  case deploymentPending(status: String)
  /// Creation stopped, with the reason the chain gave.
  case setupFailed(reason: String?)
  /// Built against a Circle transaction number that has already been used: it can never execute,
  /// however many approvals it collects.
  case proposalStale
  /// The approvals on this were signed by someone who is no longer an admin.
  case adminRemoved
  /// The Circle holds less than the payment needs.
  case insufficientFunds(available: String?, needed: String)
  /// This payment is past the member's own limit — which is a fork, not a failure.
  case spendingLimitReached(limitLine: String?)
  /// Monad could not be read, so the honest answer is "unknown".
  case networkUnavailable(detail: String?)
  /// This admin has already approved; a second signature cannot raise the count.
  case approvalAlreadyCounted
  /// It already went through. Sending again would be a second payment.
  case alreadyExecuted(transactionHash: String?)
  /// Limits are not available on this deployment at all.
  case limitsUnavailable(reason: String?)

  var copy: CircleStateCopy {
    switch self {
    case .noCircles:
      return .init(
        symbol: "person.2", tone: .neutral,
        title: "No Circles yet",
        detail: "A Circle is money you look after with other people, like a trip, a household or a group fund. Everyone can see it, and you decide together how it gets spent.",
        action: "New Circle")

    case .noMembers:
      return .init(
        symbol: "person.badge.plus", tone: .neutral,
        title: "Just you so far",
        detail: "Invite the people who are sharing this money. They'll see the balance and everything that moves, from the moment they join.",
        action: "Invite people")

    case .noBalance(let circleName):
      return .init(
        symbol: "banknote", tone: .neutral,
        title: "\(circleName) is empty",
        detail: "Nothing has been added yet. Anyone in the Circle can put money in from their own Prism balance.",
        action: "Add money")

    case .noPendingApprovals:
      return .init(
        symbol: "checkmark.circle", tone: .positive,
        title: "Nothing waiting on you",
        detail: "When someone suggests a payment that needs your approval, it'll appear here first.",
        action: nil)

    case .deploymentPending(let status):
      return .init(
        symbol: "clock.arrow.circlepath", tone: .waiting,
        title: "Setting up on Monad",
        detail: Self.deploymentDetail(for: status),
        action: "Check again")

    case .setupFailed(let reason):
      return .init(
        symbol: "exclamationmark.triangle.fill", tone: .attention,
        title: "This Circle didn't finish setting up",
        // Never invented: this is the mismatch the verification step actually found.
        detail: reason ?? "Prism checked the Circle on Monad and it didn't match what was authorized, so it was not activated. No money was involved.",
        action: "Start again")

    case .proposalStale:
      return .init(
        symbol: "arrow.counterclockwise", tone: .attention,
        title: "This needs to be suggested again",
        detail: "Another Circle payment went through first, so this one can no longer be sent, even with every approval. Suggesting it again takes a moment.",
        action: "Suggest it again")

    case .adminRemoved:
      return .init(
        symbol: "person.badge.minus", tone: .attention,
        title: "The approvals no longer count",
        detail: "Someone who approved this is no longer an admin of the Circle, so their approval doesn't count any more. The remaining admins can approve it again.",
        action: "Review it")

    case .insufficientFunds(let available, let needed):
      return .init(
        symbol: "arrow.down.circle", tone: .attention,
        title: "The Circle doesn't hold enough",
        detail: available.map { "This payment is \(needed) and the Circle holds \($0). It can still be topped up before it's sent." }
          ?? "This payment is \(needed), which is more than the Circle holds. It can still be topped up before it's sent.",
        action: "Add money")

    case .spendingLimitReached(let limitLine):
      return .init(
        symbol: "hand.raised.fill", tone: .waiting,
        title: limitLine ?? "This is above your spending limit",
        detail: "You can still make this payment. It just needs the Circle's admins to agree first, rather than only you.",
        action: "Request approval")

    case .networkUnavailable(let detail):
      return .init(
        symbol: "wifi.exclamationmark", tone: .waiting,
        title: "Can't reach Monad right now",
        // Saying "unknown" is the honest answer; showing the last number as current would not be.
        detail: detail ?? "Prism won't show a balance or an approval count it can't confirm, so these are unknown rather than out of date. Nothing has changed.",
        action: "Try again")

    case .approvalAlreadyCounted:
      return .init(
        symbol: "checkmark.seal.fill", tone: .positive,
        title: "You've already approved this",
        detail: "Your approval is counted. Approving a second time wouldn't move it any closer. It's waiting on the other admins now.",
        action: "Done")

    case .alreadyExecuted:
      return .init(
        symbol: "checkmark.circle.fill", tone: .positive,
        title: "This already went through",
        detail: "The payment was sent and confirmed on Monad. Sending it again would be a second, separate payment.",
        action: "View receipt")

    case .limitsUnavailable(let reason):
      return .init(
        symbol: "lock.shield", tone: .neutral,
        title: "Spending limits aren't available yet",
        detail: reason ?? "Every payment from this Circle is approved by its admins. Personal spending limits need a verified spending contract that isn't available on this network yet.",
        action: nil)
    }
  }

  private static func deploymentDetail(for status: String) -> String {
    switch status {
    case "DEPLOYING": return "The Circle is being created on Monad. This usually takes a few seconds."
    case "CONFIRMING": return "The Circle was created and Prism is waiting for Monad to confirm it."
    case "RECONCILING": return "Prism is checking the Circle on Monad matches exactly what you authorized. It becomes usable once it does."
    default: return "The Circle is being set up. It becomes usable once Monad confirms it, and you don't need to do anything."
    }
  }
}

/// What a state looks like and what it offers. `action` is nil only where there is genuinely
/// nothing to do because nothing is wrong — never because a next step was hard to name.
struct CircleStateCopy: Equatable {
  let symbol: String
  let tone: CircleTone
  let title: String
  let detail: String
  let action: String?
}

/// Status colour, always paired with a symbol.
///
/// Colour alone is not a status in Circles: `CircleStatusBadge` renders the symbol next to the
/// label, so the same information survives a colour-blind reader, a greyscale screenshot and
/// VoiceOver. That is why this type has no raw colour accessor without a `symbol` beside it.
enum CircleTone: Equatable {
  case positive, waiting, attention, neutral

  var color: Color {
    switch self {
    case .positive: return PrismTheme.mintDeep
    case .waiting: return PrismTheme.amber
    case .attention: return PrismTheme.danger
    case .neutral: return PrismTheme.pending
    }
  }

  var wash: Color { color.opacity(self == .positive ? 0.09 : 0.085) }
}

// MARK: - views

/// The standard "nothing here, and here is what to do about it" panel.
struct CircleStateView: View {
  let state: CircleState
  var action: (() -> Void)? = nil
  /// Compact drops the illustration for use inside a card rather than a whole screen.
  var compact = false

  private var copy: CircleStateCopy { state.copy }

  var body: some View {
    VStack(spacing: compact ? 9 : 13) {
      if !compact {
        ZStack {
          Circle().fill(copy.tone.wash).frame(width: 68, height: 68)
          Image(systemName: copy.symbol)
            .font(.system(size: 24, weight: .medium))
            .foregroundStyle(copy.tone.color)
        }
        .accessibilityHidden(true)
      }

      Text(copy.title)
        .font(PrismTheme.body(compact ? 15 : 17, weight: .semibold))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)

      Text(copy.detail)
        .font(PrismTheme.body(compact ? 12.5 : 13.5))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 320)

      if let label = copy.action, let action {
        Button(action: action) {
          Text(label)
            .font(PrismTheme.body(14, weight: .semibold))
            .foregroundStyle(PrismTheme.mintDeep)
            .padding(.horizontal, 20)
            .frame(height: 46)
            .background(PrismTheme.mintSoft)
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, compact ? 18 : 34)
    .padding(.horizontal, 18)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(copy.title)
    .accessibilityHint(copy.detail)
  }
}

/// A status, rendered as symbol + word. Never as colour alone.
struct CircleStatusBadge: View {
  let text: String
  let tone: CircleTone
  var symbol: String

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: symbol)
        .font(.system(size: 9.5, weight: .bold))
      Text(text)
        .font(PrismTheme.body(10, weight: .semibold))
    }
    .foregroundStyle(tone.color)
    .padding(.horizontal, 9)
    .padding(.vertical, 5)
    .background(tone.wash)
    .clipShape(Capsule())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(text)
  }
}

/// A row of a Circle's inline notice — used where a whole `CircleStateView` would be too much, such
/// as above a button that is about to be disabled.
struct CircleNotice: View {
  let state: CircleState
  var action: (() -> Void)? = nil

  var body: some View {
    let copy = state.copy
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: copy.symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(copy.tone.color)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(copy.title).font(PrismTheme.body(13, weight: .semibold))
        Text(copy.detail)
          .font(PrismTheme.body(12))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
        if let label = copy.action, let action {
          Button(label, action: action)
            .font(PrismTheme.body(12.5, weight: .semibold))
            .foregroundStyle(PrismTheme.mintDeep)
            .padding(.top, 2)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(13)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(copy.tone.wash)
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    .accessibilityElement(children: .contain)
  }
}
