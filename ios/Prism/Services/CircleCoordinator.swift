import Foundation

/// Drives the three things a person actually does with a Circle's money: add to it, propose a
/// payment out of it, and approve one.
///
/// The states mirror `PaymentCoordinator.State` deliberately, so `OperationStateOverlay` renders a
/// Circle action with the same vocabulary as a personal payment — *Adding… Settling… Added*. The
/// one thing this coordinator adds over its personal sibling is the **approval gate**: before Face
/// ID is presented for a Circle approval, the device rebuilds the Safe digest from the fields it
/// displayed and refuses to sign if it disagrees with what the backend asked for.
@MainActor
final class CircleCoordinator: ObservableObject {
  enum State: Equatable {
    case idle, preparing, awaitingAuthorization, sending, settling
    case sent(String?)
    /// Broadcast, not yet confirmed. Not a success and not a failure — the honest middle, which
    /// sends the person to the Circle's activity rather than inviting a second attempt.
    case pendingReview(String)
    case failed(String)
  }

  @Published var state: State = .idle
  /// The contribution the last "add money" produced, so the receipt can be built from chain truth.
  @Published var lastContribution: CircleContribution?
  /// The payment the last propose/approve/execute touched, carrying its live lifecycle.
  @Published var lastPayment: CirclePayment?
  /// Set when the backend declined to send: not enough approvals, or a simulation that would fail.
  @Published var blockedReason: String?
  /// The within-limit spend the last authorization produced, with its live status.
  @Published var lastSpend: CircleSpend?

  private let api = PrismAPI.shared

  // MARK: - adding money

  /// Add money to a Circle from the person's own Prism balance.
  ///
  /// `Adding…` is the signature; `Settling…` is the relayed transaction reaching Monad; `Added`
  /// requires the contribution to reach COMPLETED, which only an on-chain receipt can do.
  func addMoney(circleId: String, amountAtomic: String, pin: String?, useFaceID: Bool) async {
    do {
      blockedReason = nil
      state = .preparing
      let prepared = try await api.prepareContribution(circleId: circleId, amountAtomic: amountAtomic)
      state = .awaitingAuthorization
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let submitted = try await api.submitContribution(prepared)
      lastContribution = submitted.contribution
      try await settleContribution(circleId: circleId, contributionId: submitted.contribution.contributionId)
    } catch { fail(error) }
  }

  private func settleContribution(circleId: String, contributionId: String) async throws {
    state = .settling
    if let current = lastContribution, current.isComplete {
      state = .sent(current.transactionHash)
      PrismHaptics.success()
      return
    }
    for _ in 0..<40 {
      try await Task.sleep(for: .milliseconds(400))
      let status = try await api.contributionStatus(circleId: circleId, contributionId: contributionId)
      lastContribution = status.contribution
      if status.contribution.isComplete {
        state = .sent(status.contribution.transactionHash)
        PrismHaptics.success()
        return
      }
      if status.contribution.isFailed {
        PrismHaptics.error()
        throw CircleError.rejected(status.contribution.failureReason ?? "This didn't go through.")
      }
    }
    PrismHaptics.warning()
    state = .pendingReview("Your money is confirming. It'll show in the Circle once it settles. Don't add it again.")
  }

  // MARK: - proposing a payment

  /// Propose a payment out of a Circle. Nothing moves here: this produces the transaction the
  /// Circle's admins are asked to approve, and it is why the flow ends at "Waiting for approval"
  /// rather than at a receipt.
  func proposePayment(circleId: String, resolution: ResolutionResponse, amountAtomic: String, memo: String) async {
    do {
      blockedReason = nil
      state = .preparing
      let payment = try await api.proposeCirclePayment(
        circleId: circleId, resolution: resolution, amountAtomic: amountAtomic, memo: memo)
      lastPayment = payment
      state = .idle
      PrismHaptics.success()
    } catch { fail(error) }
  }

  // MARK: - proposing a withdrawal

  /// Propose taking money out of a Circle, to the caller's own account. This is an ordinary Circle
  /// payment under the hood — `lastPayment` is set the same way `proposePayment` sets it — so it
  /// ends at the same honest stopping point: nothing moves until the Circle's own threshold of
  /// approvals is met.
  func proposeWithdrawal(circleId: String, amountAtomic: String) async {
    do {
      blockedReason = nil
      state = .preparing
      let response = try await api.proposeCircleWithdrawal(circleId: circleId, amountAtomic: amountAtomic)
      lastPayment = response.proposal
      state = .idle
      PrismHaptics.success()
    } catch { fail(error) }
  }

  // MARK: - approving a payment

  /// Validate, then sign.
  ///
  /// The order is the whole security property. `CircleApprovalValidator` is handed the payment the
  /// backend sent AND an expectation assembled from the device's own Circle record — the Circle id,
  /// its Safe, its chain, its USDC, its next nonce — plus the recipient and amount the person
  /// actually read on screen. It checks all of those, then recomputes the Safe digest from the
  /// displayed fields and refuses if it disagrees with the one the backend asked to have signed.
  ///
  /// Only if every check passes is Face ID presented, and the payload that is signed is rebuilt
  /// from the validated fields — so there is no gap between what was checked and what was signed.
  func approve(
    payment: CirclePayment,
    circle: CircleDetail,
    usdcAddress: String,
    pin: String?,
    useFaceID: Bool
  ) async {
    do {
      blockedReason = nil
      state = .preparing
      let payload = try CircleApprovalPayloadBuilder.make(from: payment)
      let expectation = try CircleApprovalPayloadBuilder.expectation(
        circle: circle,
        usdcAddress: usdcAddress,
        reviewedRecipient: payload.recipientAccount,
        reviewedAmount: payload.amount)
      try CircleApprovalValidator.validate(payload, against: expectation)

      state = .awaitingAuthorization
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let result = try await api.approveCirclePayment(
        circleId: payment.circleId, proposalId: payment.proposalId, payload: payload)
      lastPayment = result.payment
      state = .idle
      PrismHaptics.success()
    } catch { fail(error) }
  }

  // MARK: - approving a change to the Circle

  /// The change a person approved on screen, as it stands after their approval.
  @Published var lastGovernance: CircleGovernanceProposal?

  /// Validate, then sign — the same order, and for the same reason, as approving a payment.
  ///
  /// What differs is *what* gets proven. A payment binds a recipient and an amount; a change binds a
  /// target and calldata, and the only two targets a Circle ever signs are its own Safe and the
  /// verified spending contract. `CircleGovernanceValidator` checks that, checks the gas-refund
  /// fields cannot smuggle a second payment, and then recomputes the digest from the displayed
  /// fields. Only then is Face ID presented.
  func approveGovernance(
    proposal: CircleGovernanceProposal,
    circle: CircleDetail,
    summary: String,
    allowanceModule: String?,
    pin: String?,
    useFaceID: Bool
  ) async {
    do {
      blockedReason = nil
      state = .preparing
      let base = try CircleGovernancePayloadBuilder.make(from: proposal, summary: summary)
      // The chain comes from this device's Circle record, never from the proposal being reviewed.
      let payload = try CircleGovernancePayloadBuilder.withChain(base, circle: circle)
      let expectation = try CircleGovernancePayloadBuilder.expectation(
        circle: circle, allowanceModule: allowanceModule)
      try CircleGovernanceValidator.validate(payload, against: expectation)

      state = .awaitingAuthorization
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let result = try await api.approveCircleGovernance(
        circleId: proposal.circleId, proposalId: proposal.proposalId, payload: payload)
      lastGovernance = result.governance
      state = .idle
      PrismHaptics.success()
    } catch { fail(error) }
  }

  /// Apply a change that has reached its threshold.
  ///
  /// "Applied" is not "the transaction succeeded". The backend re-reads the Circle's live authority,
  /// re-verifies every signature, simulates, broadcasts — and then READS THE CHANGE BACK off Monad
  /// before calling it done. A `blocked` answer is the normal, honest outcome when the change is not
  /// ready, and is surfaced as a reason rather than an error.
  func applyGovernance(proposal: CircleGovernanceProposal) async {
    do {
      blockedReason = nil
      state = .sending
      var result = try await api.executeCircleGovernance(
        circleId: proposal.circleId, proposalId: proposal.proposalId)
      lastGovernance = result

      if let blocked = result.blocked {
        blockedReason = blocked
        state = .idle
        PrismHaptics.warning()
        return
      }

      state = .settling
      for _ in 0..<40 {
        if result.isComplete {
          state = .sent(result.executionTxHash)
          PrismHaptics.success()
          return
        }
        if result.isDead {
          PrismHaptics.error()
          throw CircleError.rejected(result.failureReason ?? "This change didn't go through.")
        }
        try await Task.sleep(for: .milliseconds(400))
        result = try await api.circleGovernanceStatus(
          circleId: proposal.circleId, proposalId: proposal.proposalId)
        lastGovernance = result
      }
      PrismHaptics.warning()
      state = .pendingReview("The change is confirming. It'll show in the Circle once Monad confirms it. Don't send it again.")
    } catch { fail(error) }
  }

  // MARK: - sending an approved payment

  /// Ask the backend to send a payment that has reached its threshold.
  ///
  /// A refusal is expected and normal: the backend re-reads the Safe's live authority, re-verifies
  /// every signature and simulates the transaction, and `blocked` is what it says when the payment
  /// is not ready or would fail. That is surfaced as a reason, not as an error.
  func send(payment: CirclePayment) async {
    do {
      blockedReason = nil
      state = .sending
      var result = try await api.executeCirclePayment(circleId: payment.circleId, proposalId: payment.proposalId)
      lastPayment = result

      if let blocked = result.blocked {
        blockedReason = blocked
        state = .idle
        PrismHaptics.warning()
        return
      }

      state = .settling
      for _ in 0..<40 {
        if result.isComplete {
          state = .sent(result.executionTxHash)
          PrismHaptics.success()
          return
        }
        if result.isDead {
          PrismHaptics.error()
          throw CircleError.rejected(result.failureReason ?? "This payment didn't go through.")
        }
        try await Task.sleep(for: .milliseconds(400))
        result = try await api.circlePayment(circleId: payment.circleId, proposalId: payment.proposalId)
        lastPayment = result
      }
      PrismHaptics.warning()
      state = .pendingReview("The payment is confirming. It'll show in the Circle once it settles. Don't send it again.")
    } catch { fail(error) }
  }

  // MARK: - spending within a limit

  /// Which way this payment can happen, from live chain state. Nil means the question could not be
  /// answered, and the caller falls back to proposing — never to spending.
  func preview(circleId: String, amountAtomic: String) async -> CirclePaymentPreview? {
    try? await api.previewCirclePayment(circleId: circleId, amountAtomic: amountAtomic)
  }

  /// Spend inside a limit the Circle already agreed: the member authorizes it alone.
  ///
  /// Validate, then sign — the same order, and for the same reason, as approving a threshold
  /// payment. `CircleSpendValidator` is handed the backend's payload AND an expectation assembled
  /// from this device's own Circle record plus the recipient and amount the person read on screen.
  /// It rebuilds the module's transfer hash from those fields and refuses if it disagrees with the
  /// digest the backend asked to have signed. Only then is Face ID presented.
  func spendWithinLimit(
    circleId: String,
    circle: CircleDetail,
    resolution: ResolutionResponse,
    amountAtomic: String,
    memo: String,
    moduleAddress: String,
    usdcAddress: String,
    reviewedRecipient: String,
    availableAtomic: String?,
    pin: String?,
    useFaceID: Bool
  ) async {
    do {
      blockedReason = nil
      state = .preparing
      let prepared = try await api.prepareCircleSpend(
        circleId: circleId, resolution: resolution, amountAtomic: amountAtomic, memo: memo)
      lastSpend = prepared.spend

      let payload = try CircleSpendPayloadBuilder.make(
        from: prepared, circle: circle, moduleAddress: moduleAddress, usdcAddress: usdcAddress)
      guard let reviewed = EVMAddress(reviewedRecipient), let reviewedAmount = SafeUInt256(decimalString: amountAtomic) else {
        throw CircleSpendPayloadBuilder.Failure.malformed("the reviewed recipient or amount")
      }
      guard let safeAddress = circle.safeAddress.flatMap(EVMAddress.init),
        let chainId = SafeUInt256(decimalString: circle.chainId),
        let module = EVMAddress(moduleAddress),
        let usdc = EVMAddress(usdcAddress)
      else { throw CircleSpendPayloadBuilder.Failure.malformed("this Circle's own settings") }

      try CircleSpendValidator.validate(payload, against: CircleSpendExpectation(
        circleId: circleId, safeAddress: safeAddress, chainId: chainId, moduleAddress: module,
        usdcAddress: usdc, reviewedRecipientAccount: reviewed, reviewedAmount: reviewedAmount,
        availableAtomic: availableAtomic.flatMap { SafeUInt256(decimalString: $0) }))

      state = .awaitingAuthorization
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let submitted = try await api.submitCircleSpend(circleId: circleId, payload: payload)
      lastSpend = submitted.spend
      try await settleSpend(circleId: circleId, spendId: submitted.spend.spendId)
    } catch { fail(error) }
  }

  private func settleSpend(circleId: String, spendId: String) async throws {
    state = .settling
    if let current = lastSpend, current.isComplete {
      state = .sent(current.transactionHash)
      PrismHaptics.success()
      return
    }
    for _ in 0..<40 {
      try await Task.sleep(for: .milliseconds(400))
      let status = try await api.circleSpendStatus(circleId: circleId, spendId: spendId)
      lastSpend = status.spend
      if status.spend.isComplete {
        state = .sent(status.spend.transactionHash)
        PrismHaptics.success()
        return
      }
      if status.spend.isFailed {
        PrismHaptics.error()
        throw CircleError.rejected(status.spend.failureReason ?? "This didn't go through.")
      }
    }
    PrismHaptics.warning()
    state = .pendingReview("Your payment is confirming. It'll show in the Circle once it settles. Don't send it again.")
  }

  // MARK: - shared

  private func localApproval(pin: String?, useFaceID: Bool) async throws {
    if useFaceID {
      try await BiometricService().authenticate()
    } else {
      guard let pin, try PINService.shared.verify(pin) else { throw PaymentError.badPIN }
    }
  }

  private func fail(_ error: Error) {
    PrismHaptics.error()
    state = .failed(Self.message(for: error))
  }

  /// A rejected approval is the one error a person genuinely needs the detail of: it means the
  /// screen and the transaction disagreed, and no amount of retrying will fix that. So a
  /// `CircleApprovalRejection` is surfaced verbatim, while ordinary infrastructure failures fall
  /// back to the same plain language the personal payment path uses.
  nonisolated static func message(for error: Error) -> String {
    if let rejection = error as? CircleApprovalRejection {
      return "This approval was stopped: \(rejection.description)"
    }
    if let failure = error as? CircleApprovalPayloadBuilder.Failure {
      return "This approval was stopped: \(failure.description)"
    }
    if let rejection = error as? CircleGovernanceRejection {
      return "This change was stopped: \(rejection.description)"
    }
    if let failure = error as? CircleGovernancePayloadBuilder.Failure {
      return "This change was stopped: \(failure.description)"
    }
    if let rejection = error as? CircleSpendRejection {
      return "This payment was stopped: \(rejection.description)"
    }
    if let failure = error as? CircleSpendPayloadBuilder.Failure {
      return "This payment was stopped: \(failure.description)"
    }
    if let circle = error as? CircleError { return circle.errorDescription ?? "That didn't work." }
    return PaymentCoordinator.friendlyMessage(for: error)
  }

  func reset() { state = .idle; blockedReason = nil }
}

enum CircleError: LocalizedError {
  case rejected(String)
  case notActive
  case notConfigured

  var errorDescription: String? {
    switch self {
    case .rejected(let reason): return reason
    case .notActive: return "This Circle isn't active on Monad yet."
    case .notConfigured: return "Circles aren't available on this build."
    }
  }
}
