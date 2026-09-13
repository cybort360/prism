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
    state = .pendingReview("Your money was sent and is still confirming. It'll show in the Circle once it settles — don't add it again.")
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
      state = .pendingReview("The payment was sent and is still confirming. It'll show in the Circle once it settles — don't send it again.")
    } catch { fail(error) }
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
