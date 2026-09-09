import Foundation

@MainActor
final class PaymentCoordinator: ObservableObject {
  enum State: Equatable {
    case idle, preparing, awaitingAuthorization, sending, settling
    case sent(String?)
    case failed(String)
  }
  @Published var state: State = .idle
  /// Canonical operation id of the last submitted action — opens PaymentDetailsView from success.
  @Published var lastOperationId: String?
  /// The claimId of the last funded claim — lets the sender surface remember the recipient locally
  /// and build a safe share invitation. Never leaves the device beyond the opaque claimId.
  @Published var lastClaimId: String?
  /// The routeId of the last cross-chain send. The Monad leg completing is NOT delivery, so the
  /// route is tracked separately and the caller follows it after this coordinator reaches `.sent`.
  @Published var lastRouteId: String?
  private let api = PrismAPI.shared

  // MARK: direct payment

  func pay(resolution: ResolutionResponse, amountAtomic: String, requestId: String? = nil, memo: String, entryMethod: PrismEntryMethod? = nil, pin: String?, useFaceID: Bool) async {
    do {
      state = .preparing
      let prepared = try await api.preparePayment(resolution: resolution, amountAtomic: amountAtomic, requestId: requestId, memo: memo, entryMethod: entryMethod)
      state = .awaitingAuthorization
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let result = try await api.submitPayment(prepared)
      lastOperationId = result.canonicalOperationId
      try await poll { try await self.api.paymentStatus(result.id) }
    } catch { fail(error) }
  }

  // MARK: cross-chain send / spend

  /// Send to another chain in another asset.
  ///
  /// State-for-state identical to `pay`, so `OperationStateOverlay` works unchanged: this only
  /// covers the Monad leg, which is an ordinary router settlement whose recipient is Aurora's
  /// deposit address. Reaching `.sent` means the money left the account — the routed leg is still
  /// in flight, and the caller tracks it through the route, never inferring delivery from here.
  func sendCrossChain(routeId: String, pin: String?, useFaceID: Bool) async {
    do {
      state = .preparing
      let prepared = try await api.prepareAuroraSend(routeId: routeId)
      lastRouteId = prepared.route.routeId
      state = .awaitingAuthorization
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let result = try await api.submitAuroraSend(prepared)
      lastOperationId = result.canonicalOperationId
      try await poll { try await self.api.paymentStatus(result.id) }
    } catch { fail(error) }
  }

  // MARK: device-P256 → PrismP256Account (on-chain P-256 authority; distinct from the secp256k1 router)

  /// Pay from the user's PrismP256Account, authorized by a device P-256 signature verified on-chain.
  /// The relayer submits and pays gas. Reaching `.sent` means the payment confirmed on Monad.
  func payViaP256Account(credential: DeviceP256Credential, recipientAddress: String, amountAtomic: String) async {
    do {
      state = .preparing
      let (qx, qy) = credential.publicKeyXY
      _ = try await api.ensureP256Account(qx: qx, qy: qy)
      let prepared = try await api.prepareP256(recipient: recipientAddress, amountAtomic: amountAtomic)
      state = .awaitingAuthorization
      guard let intent = prepared.intentHex.hexData else { throw PaymentError.failed }
      let (r, s) = try credential.sign(intent) // Secure Enclave / CryptoKit: signs SHA-256(intent)
      state = .sending
      let submitted = try await api.submitP256(opId: prepared.opId, r: r, s: s)
      lastOperationId = submitted.opId
      try await pollP256(prepared.opId)
    } catch { fail(error) }
  }

  private func pollP256(_ opId: String) async throws {
    state = .settling
    for _ in 0..<40 {
      try await Task.sleep(for: .milliseconds(400))
      let st = try await api.p256Status(opId)
      if st.state == "completed" { state = .sent(st.txHash); PrismHaptics.success(); return }
      if st.state == "failed" { PrismHaptics.error(); throw PaymentError.failed }
    }
    state = .failed("Your payment was submitted and is still confirming. Check Activity before trying again.")
  }

  // MARK: claims (send before signup)

  func fundClaim(phone: String, amountAtomic: String, memo: String, pin: String?, useFaceID: Bool) async {
    do {
      state = .preparing
      let prepared = try await api.prepareClaim(phone: phone, amountAtomic: amountAtomic, memo: memo)
      lastClaimId = prepared.claimId
      state = .awaitingAuthorization
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let result = try await api.fundClaim(prepared)
      lastOperationId = result.canonicalOperationId
      try await poll { try await self.api.claimStatus(result.id) }
    } catch { fail(error) }
  }

  func collectClaim(_ claim: ClaimRecord, pin: String?, useFaceID: Bool) async {
    do {
      state = .preparing
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let result = try await api.collectClaim(claim) // recipient Mera intent + backend eligibility
      lastOperationId = result.canonicalOperationId
      try await poll { try await self.api.claimStatus(result.id) }
    } catch { fail(error) }
  }

  func refundClaim(_ claim: ClaimRecord, pin: String?, useFaceID: Bool) async {
    do {
      state = .preparing
      try await localApproval(pin: pin, useFaceID: useFaceID)
      state = .sending
      let result = try await api.refundClaim(claim.claimId)
      lastOperationId = result.canonicalOperationId
      try await poll { try await self.api.claimStatus(result.id) }
    } catch { fail(error) }
  }

  // MARK: shared

  /// Local human approval gate. Face ID (fallback to PIN handled by the sheet) or the payment PIN.
  private func localApproval(pin: String?, useFaceID: Bool) async throws {
    if useFaceID {
      try await BiometricService().authenticate()
    } else {
      guard let pin, try PINService.shared.verify(pin) else { throw PaymentError.badPIN }
    }
  }

  private func poll(_ status: () async throws -> OperationStatus) async throws {
    state = .settling
    for _ in 0..<40 {
      try await Task.sleep(for: .milliseconds(400))
      let r = try await status()
      if r.state == "completed" {
        state = .sent(r.transactionHash)
        PrismHaptics.success()
        return
      }
      if r.state == "failed" {
        PrismHaptics.error()
        throw PaymentError.failed
      }
    }
    state = .failed("Your payment was submitted and is still confirming. Check Activity before trying again.")
  }

  private func fail(_ error: Error) {
    PrismHaptics.error()
    state = .failed(error.localizedDescription)
  }

  func reset() { state = .idle }
}

enum PaymentError: LocalizedError {
  case badPIN, failed
  var errorDescription: String? {
    switch self {
    case .badPIN: "That PIN doesn't match. Try again."
    case .failed: "The payment couldn't be completed."
    }
  }
}
