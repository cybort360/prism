import Foundation

// Pure, testable presentation logic for PaymentDetailsView. Maps a canonical PrismPayment (+ events
// + receipt) into consumer-facing display — human language, dollar amounts, no chain vocabulary in
// the summary. Kept free of SwiftUI so it can be unit-tested across every payment state.

enum PrismStepState: Equatable { case done, current, upcoming }

struct PrismTimelineStep: Equatable {
  let title: String
  let state: PrismStepState
  let timestamp: String?   // ISO8601, revealed on tap
}

struct PrismDetailRow: Equatable {
  let label: String
  let value: String
}

struct PaymentDisplay {
  let payment: PrismPayment
  let events: [PrismLifecycleEvent]
  let receipt: PrismReceipt?

  init(payment: PrismPayment, events: [PrismLifecycleEvent] = [], receipt: PrismReceipt? = nil) {
    self.payment = payment
    self.events = events
    self.receipt = receipt
  }

  // MARK: summary

  private var counterparty: PrismParty { payment.direction == .sent ? payment.recipient : payment.sender }

  /// Headline name. Refunds read as "Refund"; otherwise the counterparty display identity.
  var title: String {
    if payment.kind == .refund { return "Refund" }
    return counterparty.displayName
  }
  var handle: String? { payment.kind == .refund ? nil : counterparty.handle }

  var initials: String {
    let source = payment.kind == .refund ? "Refund" : counterparty.displayName
    let parts = source.split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init)
    let v = parts.joined().uppercased()
    return v.isEmpty ? "•" : v
  }

  /// Dollar amount phrased by direction/kind. Never uses token or blockchain words.
  var amountLine: String {
    let dollars = payment.dollars
    switch payment.kind {
    case .refund: return "+\(dollars) returned"
    case .claimSettlement: return payment.direction == .received ? "\(dollars) received" : dollars
    default: return payment.direction == .received ? "+\(dollars)" : dollars
    }
  }

  var memo: String? {
    guard let m = payment.memo, !m.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    return m
  }

  /// Consumer status label — human language only, never the internal enum. Green "settled" wording
  /// only when the lifecycle actually reached completed; in-flight uses progressive verbs; attention
  /// states get calm, specific recovery guidance.
  var statusLabel: String {
    // Attention / reconciliation get specific language (the ambiguous-submit and provider-disagreement paths).
    if payment.lifecycleState == .requiresAttention {
      switch payment.failureCode {
      case "SUBMISSION_AMBIGUOUS": return "Checking whether this was submitted"
      case "PROVIDER_DISAGREEMENT", "RECONCILIATION_REQUIRED": return "Verifying final details"
      default: return "Needs your attention"
      }
    }
    switch payment.lifecycleState {
    case .completed:
      switch payment.kind {
      case .refund: return "Refunded"
      case .claimFunding: return "Protected for \(shortName(payment.recipient))"
      case .claimSettlement: return "Received"
      default: return payment.direction == .received ? "Received" : "Sent"
      }
    case .refunded: return "Refunded"
    case .claimWaiting, .claimable: return "Protected for \(shortName(payment.recipient))"
    case .failedTerminal, .reverted, .cancelled: return "Failed"
    case .refundAvailable: return "Refund available"
    case .expired: return "Expired"
    case .created, .resolving, .resolved, .awaitingAuthorization, .authorized:
      return inflightLabel(started: false)
    case .submitted, .processing:
      return inflightLabel(started: true)
    case .confirming, .confirmed, .indexing, .indexed, .reconciling, .reconciled:
      return settlingLabel
    default: return "In progress"
    }
  }

  private func inflightLabel(started: Bool) -> String {
    switch payment.kind {
    case .claimFunding: return "Protecting \(payment.dollars) for \(shortName(payment.recipient))…"
    case .claimSettlement: return "Verifying…"
    case .refund: return "Returning your money…"
    default: return started ? "Sending…" : "Preparing…"
    }
  }
  /// A fuller, calm sentence for attention states — shown as a subtle banner, not an error.
  var attentionMessage: String? {
    guard payment.lifecycleState == .requiresAttention else { return nil }
    switch payment.failureCode {
    case "SUBMISSION_AMBIGUOUS": return "Prism is checking whether this payment was submitted. Don't retry yet."
    case "PROVIDER_DISAGREEMENT", "RECONCILIATION_REQUIRED": return "Prism is verifying the final payment details."
    default: return "This payment needs your attention."
    }
  }

  private var settlingLabel: String {
    switch payment.kind {
    case .claimFunding: return "Protecting \(payment.dollars) for \(shortName(payment.recipient))…"
    case .claimSettlement: return "Receiving…"
    case .refund: return "Returning your money…"
    default: return "Settling…"
    }
  }

  enum StatusTone { case positive, pending, danger, neutral }
  var statusTone: StatusTone {
    switch payment.lifecycleState {
    case .completed, .refunded: return .positive
    case .failedTerminal, .reverted, .cancelled, .expired: return .danger
    case .requiresAttention:
      // "Checking / verifying" is calm, not alarming; only an unresolved attention state is danger.
      switch payment.failureCode {
      case "SUBMISSION_AMBIGUOUS", "PROVIDER_DISAGREEMENT", "RECONCILIATION_REQUIRED": return .pending
      default: return .danger
      }
    case .claimWaiting, .claimable, .refundAvailable: return .neutral
    default: return .pending
    }
  }

  var isPending: Bool { statusTone == .pending }

  // MARK: dates

  private func parse(_ iso: String?) -> Date? { iso.flatMap { ISO8601DateFormatter().date(from: $0) } }
  private var primaryDate: Date? { parse(payment.completedAt) ?? parse(payment.submittedAt) ?? parse(payment.createdAt) }
  var dateLine: String? { primaryDate.map { $0.formatted(date: .long, time: .omitted) } }
  var timeLine: String? { primaryDate.map { $0.formatted(date: .omitted, time: .shortened) } }

  // MARK: lifecycle timeline (human language)

  private static let rank: [PrismLifecycleState: Int] = [
    .created: 1, .resolved: 2, .authorized: 3, .submitted: 4,
    .confirming: 5, .confirmed: 6, .reconciled: 7, .completed: 8, .indexed: 9
  ]
  private var maxRank: Int {
    events.compactMap { PaymentDisplay.rank[$0.state] }.max() ?? (PaymentDisplay.rank[payment.lifecycleState] ?? 0)
  }
  private var isFailed: Bool { statusTone == .danger && payment.lifecycleState != .claimWaiting }
  private func timestamp(forRank r: Int) -> String? {
    events.first { PaymentDisplay.rank[$0.state] == r }?.occurredAt
  }

  /// Ordered human steps for this payment kind. Each step carries the lifecycle rank it needs.
  private var stepTemplate: [(title: String, rank: Int)] {
    switch payment.kind {
    case .claimFunding:
      return [("Payment created", 1), ("You approved", 3), ("Funds protected", 4), ("Confirmed on Monad", 6), ("Waiting to be claimed", 8)]
    case .claimSettlement:
      return [("Claim opened", 1), ("Recipient verified", 2), ("You approved", 3), ("Claimed", 4), ("Confirmed on Monad", 6), ("Delivered", 8)]
    case .refund:
      return [("Refund created", 1), ("Submitted", 4), ("Confirmed on Monad", 6), ("Returned", 8)]
    case .crossChainSend:
      // Stops at "Sent from Monad". Delivery happens on another chain and is tracked by the route,
      // so this screen must not imply it — see AuroraRouteDisplay for that half.
      return [("Payment created", 1), ("You approved", 3), ("Submitted", 4), ("Sent from Monad", 6)]
    default:
      let verified = payment.kind == .requestPayment ? "Request matched" : "\(shortName(counterparty)) verified"
      return [("Payment created", 1), (verified, 2), ("You approved", 3), ("Submitted", 4), ("Confirmed on Monad", 6), ("Delivered", 8)]
    }
  }

  var timeline: [PrismTimelineStep] {
    let mr = maxRank
    var firstUnreachedMarked = false
    return stepTemplate.map { step in
      let reached = mr >= step.rank
      let state: PrismStepState
      if reached { state = .done }
      else if !firstUnreachedMarked && !isFailed { firstUnreachedMarked = true; state = .current }
      else { state = .upcoming }
      return PrismTimelineStep(title: step.title, state: state, timestamp: timestamp(forRank: step.rank))
    }
  }

  // MARK: receipt rows (no blank rows)

  var entryMethodLabel: String {
    switch payment.entryMethod {
    case .contact: return "Contacts"
    case .phone: return "Phone"
    case .handle: return "@handle"
    case .qr: return "Prism QR"
    case .paymentLink: return "payment link"
    case .request: return "a request"
    case .claim: return "a claim"
    case .internalRecovery: return "recovery"
    }
  }

  var receiptRows: [PrismDetailRow] {
    var rows: [PrismDetailRow] = []
    func add(_ label: String, _ value: String?) { if let v = value, !v.isEmpty { rows.append(.init(label: label, value: v)) } }
    add("Amount", payment.amountAtomic.map { Money.dollars(fromAtomic: $0) })
    add("From", payment.sender.displayName == "You" ? "You" : (payment.sender.handle ?? payment.sender.displayName))
    if let route = payment.route {
      // There is no Prism recipient on the far side, so naming one would be a fiction. The
      // destination is the address on the destination chain.
      add("To", shortRef(route.destinationAddress ?? ""))
      add("On", route.destinationChainLabel)
    } else {
      add("To", payment.recipient.displayName == "You" ? "You" : (payment.recipient.handle ?? payment.recipient.displayName))
    }
    add("Paid using", entryMethodLabel)
    add("Note", memo)
    add("Status", statusLabel)
    if let c = parse(payment.createdAt) { add("Created", c.formatted(date: .abbreviated, time: .shortened)) }
    if payment.isSettled, let s = parse(payment.completedAt) { add("Settled", s.formatted(date: .abbreviated, time: .shortened)) }
    if let g = payment.gasSponsored { add("Gas sponsored", g ? "Yes" : "No") }
    if let rid = payment.requestId { add("Related request", shortRef(rid)) }
    if payment.kind != .refund, let cid = payment.claimId { add("Claim reference", shortRef(cid)) }
    return rows
  }

  // MARK: cross-chain

  /// Rows describing the routed leg. Empty for every other kind, so the section simply does not
  /// render. Deliberately separate from the receipt above: the receipt describes money leaving the
  /// account on Monad, and this describes where it is going — a confirmed Monad leg is not delivery.
  var crossChainRows: [PrismDetailRow] {
    guard let route = payment.route else { return [] }
    var rows: [PrismDetailRow] = []
    func add(_ label: String, _ value: String?) { if let v = value, !v.isEmpty { rows.append(.init(label: label, value: v)) } }

    add("Destination", route.destinationChainLabel)
    add("They receive", route.destinationSymbol)
    // The guaranteed floor the payer actually approved, never a forecast.
    if let minOut = route.minAmountOut, let decimals = route.destinationDecimals, let symbol = route.destinationSymbol {
      add("Guaranteed minimum", "\(AuroraRouteDisplay.tokenAmount(minOut, decimals: decimals)) \(symbol)")
    }
    add("Address", route.destinationAddress)
    add("Route status", routeStatusLabel)
    return rows
  }

  /// The routed leg's status, stated in its own words so it can never be read as the Monad leg's.
  var routeStatusLabel: String? {
    guard let route = payment.route else { return nil }
    return switch route.state {
    case .quoted, .awaitingDeposit: "Not sent yet"
    case .funding: "Sent — waiting for the network"
    case .funded: "Received by the network"
    case .routing: "Converting to \(route.destinationSymbol ?? "the destination token")"
    case .delivered: "Delivered"
    case .refunding: "Refunding"
    case .refunded: "Refunded to your balance"
    case .routeFailed: "Route failed"
    case .requiresAttention: "Needs attention"
    case .expired: "Quote expired"
    }
  }

  var routeStatusTone: PrismStatusTone {
    switch payment.route?.state {
    case .delivered: .positive
    case .routeFailed, .refunded: .danger
    case .requiresAttention, .expired: .pending
    default: .neutral
    }
  }

  // MARK: technical details (collapsed; never secrets)

  var technicalRows: [PrismDetailRow] {
    // Monad is where Prism settles, but it is no longer the only network a payment touches: a
    // cross-chain send leaves from Monad and lands elsewhere, and the row says so rather than
    // stating a single network as if it were the whole story.
    var rows: [PrismDetailRow] = [.init(label: "Network", value: networkLabel)]
    if let tx = payment.transactionHash { rows.append(.init(label: "Transaction", value: shortRef(tx))) }
    if let b = payment.blockNumber { rows.append(.init(label: "Block", value: b)) }
    rows.append(.init(label: "Settlement", value: payment.isSettled ? "Confirmed" : (isFailed ? "Failed" : "Pending")))
    return rows
  }

  // MARK: helpers

  /// Cross-chain sends leave Monad; everything else begins and ends there.
  var networkLabel: String { payment.kind == .crossChainSend ? "Monad → another network" : "Monad" }

  private func shortName(_ p: PrismParty) -> String { p.displayName == "You" ? "You" : (p.displayName.split(separator: " ").first.map(String.init) ?? p.displayName) }
  func shortRef(_ s: String) -> String { s.count > 14 ? "\(s.prefix(6))…\(s.suffix(4))" : s }
}
