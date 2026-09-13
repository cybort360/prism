import Foundation

/// Prism Circles over the wire.
///
/// Two rules hold across every method here, and they are the reason this is a separate extension
/// rather than more methods on the payment API:
///
///  1. **No call carries a Safe address, a target, or calldata.** A Circle is named by its id; the
///     Safe always comes from the Circle record the caller belongs to, on the server. There is no
///     request shape on this surface that can aim a Circle operation at someone else's Safe.
///  2. **Approval is signed locally, after local validation.** `approvePayment` will not sign a
///     payload it cannot independently account for — see `CircleApprovalValidator`.
extension PrismAPI {
  private var client: APIClient { APIClient.shared }

  // MARK: request bodies
  struct PrepareContributionBody: Encodable { let amountAtomic: String }
  struct SubmitContributionBody: Encodable { let prismSignature: String; let tokenSignature: String }
  struct ProposeCirclePaymentBody: Encodable { let resolution: ResolutionResponse; let amountAtomic: String; let memo: String }
  struct CircleApprovalBody: Encodable { let signature: String }

  // MARK: reading Circles

  func circles() async throws -> [CircleSummary] {
    let response: CirclesResponse = try await client.request("/v1/circles")
    return response.circles
  }

  /// One Circle, with its authority and balance read live from Monad. Either may come back
  /// `unavailable` — which is a truthful answer and must be rendered as one.
  func circle(_ circleId: String) async throws -> CircleDetail {
    try await client.request("/v1/circles/\(circleId)")
  }

  /// Everything on this Circle awaiting approval — the admin's inbox.
  func circlePending(_ circleId: String) async throws -> CirclePendingResponse {
    try await client.request("/v1/circles/\(circleId)/pending")
  }

  // MARK: contributions (money in)

  /// Build the signable envelope for adding money. A contribution is an ordinary Prism payment
  /// whose recipient is the Circle's Safe — same envelope, same ERC-3009 authorization to the
  /// audited router, same relayer.
  func prepareContribution(circleId: String, amountAtomic: String) async throws -> PreparedContribution {
    try await client.send("/v1/circles/\(circleId)/contributions/prepare", body: PrepareContributionBody(amountAtomic: amountAtomic))
  }

  /// Sign both payloads with the Mera account and relay. The response already carries the
  /// reconciliation attempt, so a fast confirmation needs no extra round trip.
  @MainActor
  func submitContribution(_ prepared: PreparedContribution) async throws -> CircleContributionStatus {
    let mera = MeraAccountManager.shared
    try await mera.beginSession(.payments)
    let prismSignature = try await mera.signTypedDataHex(prepared.typedData.envelope.jsonData())
    let tokenSignature = try await mera.signTypedDataHex(prepared.typedData.tokenAuthorization.jsonData())
    return try await APIClient.shared.send(
      "/v1/circles/\(prepared.contribution.circleId)/contributions/\(prepared.contribution.contributionId)/submit",
      body: SubmitContributionBody(prismSignature: prismSignature, tokenSignature: tokenSignature),
      idempotencyKey: prepared.contribution.contributionId)
  }

  /// Reconcile one contribution from chain truth. COMPLETED only ever comes from a receipt.
  func contributionStatus(circleId: String, contributionId: String) async throws -> CircleContributionStatus {
    try await client.request("/v1/circles/\(circleId)/contributions/\(contributionId)")
  }

  func contributions(circleId: String) async throws -> [CircleContribution] {
    let response: CircleContributionsResponse = try await client.request("/v1/circles/\(circleId)/contributions")
    return response.contributions
  }

  // MARK: payments (money out)

  /// Propose a payment from a Circle. The recipient arrives as a signed resolution from the SAME
  /// Protected Alias Resolver a personal payment uses, so this inherits Prism Continuity whole.
  func proposeCirclePayment(circleId: String, resolution: ResolutionResponse, amountAtomic: String, memo: String) async throws -> CirclePayment {
    try await client.send(
      "/v1/circles/\(circleId)/payments/propose",
      body: ProposeCirclePaymentBody(resolution: resolution, amountAtomic: amountAtomic, memo: memo))
  }

  func circlePayments(_ circleId: String) async throws -> [CirclePayment] {
    let response: CirclePaymentsResponse = try await client.request("/v1/circles/\(circleId)/payments")
    return response.payments
  }

  func circlePayment(circleId: String, proposalId: String) async throws -> CirclePayment {
    try await client.request("/v1/circles/\(circleId)/payments/\(proposalId)")
  }

  /// Approve a Circle payment with the admin's existing Mera account key.
  ///
  /// `payload` must already have passed `CircleApprovalValidator` against this device's own
  /// expectation — the caller is `CircleCoordinator.approve`, which refuses to reach this method
  /// otherwise. The signature is over the Safe's own EIP-712 `SafeTx`, rebuilt here from the
  /// validated fields, so the bytes signed are the bytes checked.
  @MainActor
  func approveCirclePayment(circleId: String, proposalId: String, payload: CircleApprovalPayload) async throws -> CircleApprovalResult {
    let mera = MeraAccountManager.shared
    try await mera.beginSession(.payments)
    let signature = try await mera.signTypedDataHex(SafeTypedData.jsonData(for: payload))
    return try await APIClient.shared.send(
      "/v1/circles/\(circleId)/payments/\(proposalId)/approve",
      body: CircleApprovalBody(signature: signature),
      idempotencyKey: "\(proposalId):approve")
  }

  /// Ask the backend to send a fully-approved payment.
  ///
  /// This grants nothing the signatures had not already authorized. The backend re-reads the Safe's
  /// live owners, threshold and nonce, re-verifies every signature, simulates `execTransaction`, and
  /// broadcasts only if the simulation succeeds — so a `blocked` response is the normal, honest
  /// outcome when the Circle is not ready, not an error.
  func executeCirclePayment(circleId: String, proposalId: String) async throws -> CirclePayment {
    try await client.send(
      "/v1/circles/\(circleId)/payments/\(proposalId)/execute",
      body: EmptyBody(),
      idempotencyKey: "\(proposalId):execute")
  }
}
