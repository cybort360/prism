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

  /// Consumer status label. Green "settled" wording only when the lifecycle actually reached completed.
  var statusLabel: String {
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
    case .requiresAttention: return "Needs your attention"
    case .failedTerminal, .reverted, .cancelled: return "Failed"
    case .refundAvailable: return "Refund available"
    case .expired: return "Expired"
    case .created, .resolving, .resolved, .awaitingAuthorization, .authorized: return "Preparing"
    case .submitted, .processing: return "Sending"
    case .confirming, .confirmed, .indexing, .indexed, .reconciling, .reconciled: return "Confirming"
    default: return "In progress"
    }
  }

  enum StatusTone { case positive, pending, danger, neutral }
  var statusTone: StatusTone {
    switch payment.lifecycleState {
    case .completed, .refunded: return .positive
    case .failedTerminal, .reverted, .cancelled, .requiresAttention, .expired: return .danger
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
      return [("Payment created", 1), ("You approved", 3), ("Sent to escrow", 4), ("Confirmed on Monad", 6), ("Protected — waiting to be claimed", 8)]
    case .claimSettlement:
      return [("Claim opened", 1), ("You approved", 3), ("Claimed", 4), ("Confirmed on Monad", 6), ("Received", 8)]
    case .refund:
      return [("Refund created", 1), ("Submitted", 4), ("Confirmed on Monad", 6), ("Returned", 8)]
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
    add("To", payment.recipient.displayName == "You" ? "You" : (payment.recipient.handle ?? payment.recipient.displayName))
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

  // MARK: technical details (collapsed; never secrets)

  var technicalRows: [PrismDetailRow] {
    var rows: [PrismDetailRow] = [.init(label: "Network", value: "Monad")]
    if let tx = payment.transactionHash { rows.append(.init(label: "Transaction", value: shortRef(tx))) }
    if let b = payment.blockNumber { rows.append(.init(label: "Block", value: b)) }
    rows.append(.init(label: "Settlement", value: payment.isSettled ? "Confirmed" : (isFailed ? "Failed" : "Pending")))
    return rows
  }

  // MARK: helpers

  private func shortName(_ p: PrismParty) -> String { p.displayName == "You" ? "You" : (p.displayName.split(separator: " ").first.map(String.init) ?? p.displayName) }
  func shortRef(_ s: String) -> String { s.count > 14 ? "\(s.prefix(6))…\(s.suffix(4))" : s }
}
