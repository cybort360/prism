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
  ///
  /// The list holds two different things: payments, and governance changes such as an approval-rule
  /// change or a spending limit. `CirclePendingItem` decodes the union, so neither is rendered with
  /// the other's vocabulary.
  func circlePending(_ circleId: String) async throws -> CirclePendingInboxResponse {
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

// MARK: - member spending limits

extension PrismAPI {
  struct CircleLimitBody: Encodable { let prismId: String; let amountAtomic: String; let period: String }
  struct CircleRevokeBody: Encodable { let prismId: String }
  struct CirclePreviewBody: Encodable { let amountAtomic: String }
  struct CircleSpendPrepareBody: Encodable { let resolution: ResolutionResponse; let amountAtomic: String; let memo: String }
  struct CircleSpendSubmitBody: Encodable { let signature: String }

  /// Are limits available at all on this deployment? `enabled: false` carries the reason, and is an
  /// ordinary state — the Circle still spends by threshold.
  func circleLimitsStatus() async throws -> CircleLimitsStatus {
    try await APIClient.shared.request("/v1/circles/limits/status")
  }

  func circleLimits(_ circleId: String) async throws -> CircleLimitsResponse {
    try await APIClient.shared.request("/v1/circles/\(circleId)/limits")
  }

  func myCircleLimit(_ circleId: String) async throws -> CircleMyLimitResponse {
    try await APIClient.shared.request("/v1/circles/\(circleId)/limits/me")
  }

  /// Build the NEXT threshold-approved transaction for a limit change. There may be up to three
  /// (enable the module, register the member, set the limit) and they cannot be batched, so this
  /// returns one proposal plus what remains. Call it again after each executes.
  func prepareCircleLimit(circleId: String, prismId: String, amountAtomic: String, period: String) async throws -> CircleGovernanceProposal {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/limits/prepare",
      body: CircleLimitBody(prismId: prismId, amountAtomic: amountAtomic, period: period))
  }

  func prepareCircleLimitRevoke(circleId: String, prismId: String) async throws -> CircleGovernanceProposal {
    try await APIClient.shared.send("/v1/circles/\(circleId)/limits/revoke/prepare", body: CircleRevokeBody(prismId: prismId))
  }

  /// Apply an approved governance change, then read the module back. "Active" means the readback
  /// agreed — not that a transaction succeeded.
  func executeCircleGovernance(circleId: String, proposalId: String) async throws -> CircleGovernanceProposal {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/governance/\(proposalId)/execute", body: EmptyBody(),
      idempotencyKey: "\(proposalId):governance")
  }

  /// Allowance or threshold, decided from live chain state. Ask before showing an amount sheet's
  /// confirm button, so the person learns which one they are doing before they commit to it.
  func previewCirclePayment(circleId: String, amountAtomic: String) async throws -> CirclePaymentPreview {
    try await APIClient.shared.send("/v1/circles/\(circleId)/payments/preview", body: CirclePreviewBody(amountAtomic: amountAtomic))
  }

  func prepareCircleSpend(circleId: String, resolution: ResolutionResponse, amountAtomic: String, memo: String) async throws -> PreparedCircleSpend {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/spend/prepare",
      body: CircleSpendPrepareBody(resolution: resolution, amountAtomic: amountAtomic, memo: memo))
  }

  /// Sign the module's transfer hash with the member's own Prism authority and relay it.
  ///
  /// `payload` must already have passed `CircleSpendValidator` — the caller is
  /// `CircleCoordinator.spendWithinLimit`, which refuses to reach this method otherwise. The
  /// signature is over the module's EIP-712 `AllowanceTransfer`, rebuilt here from the validated
  /// fields, so the bytes signed are the bytes checked.
  @MainActor
  func submitCircleSpend(circleId: String, payload: CircleSpendPayload) async throws -> CircleSpendStatusResponse {
    let mera = MeraAccountManager.shared
    try await mera.beginSession(.payments)
    let signature = try await mera.signTypedDataHex(AllowanceTypedData.jsonData(for: payload))
    return try await APIClient.shared.send(
      "/v1/circles/\(circleId)/spend/\(payload.spendId)/submit",
      body: CircleSpendSubmitBody(signature: signature),
      idempotencyKey: "\(payload.spendId):spend")
  }

  func circleSpendStatus(circleId: String, spendId: String) async throws -> CircleSpendStatusResponse {
    try await APIClient.shared.request("/v1/circles/\(circleId)/spend/\(spendId)")
  }
}

// MARK: - creating a Circle, and changing who is in it

extension PrismAPI {
  struct CreateCircleBody: Encodable {
    let name: String
    let icon: String?
    let template: String
    let admins: [CreateCircleAdmin]
    let threshold: Int
    let policyAcknowledgement: CirclePolicyAcknowledgement
  }
  struct CreateCircleAdmin: Encodable { let prismId: String }
  struct CircleInviteBody: Encodable { let prismId: String?; let handle: String?; let role: String }
  struct CircleRoleBody: Encodable { let role: String }
  struct CircleAdminBody: Encodable { let prismId: String?; let handle: String?; let threshold: Int? }
  struct CircleAdminRemoveBody: Encodable { let prismId: String; let threshold: Int? }
  struct CircleThresholdBody: Encodable { let threshold: Int }

  /// What threshold to recommend for the admins chosen so far, and the consequence of every valid
  /// choice. Purely advisory: the creator picks, and `createCircle` re-derives the warnings itself.
  func circleTemplateGuidance(template: String, admins: Int) async throws -> CircleTemplateGuidance {
    try await APIClient.shared.request("/v1/circles/templates?template=\(template)&admins=\(admins)")
  }

  /// Create a Circle and start it on its way to Monad.
  ///
  /// The response is a Circle that may still be mid-creation — DEPLOYING or CONFIRMING rather than
  /// ACTIVE — and that is the honest answer, not a failure. `circle(_:)` advances it on each read,
  /// so the creation screen polls that rather than holding this request open across block time.
  ///
  /// The idempotency key is the creator's own retry token: the backend keys creation on the Circle's
  /// shape, so a retried request resumes the same Circle rather than deploying a second Safe.
  func createCircle(
    name: String, icon: String?, template: String, adminPrismIds: [String], threshold: Int,
    acknowledgement: CirclePolicyAcknowledgement, idempotencyKey: String
  ) async throws -> CircleSummary {
    try await APIClient.shared.send(
      "/v1/circles",
      body: CreateCircleBody(
        name: name, icon: icon, template: template,
        admins: adminPrismIds.map(CreateCircleAdmin.init(prismId:)),
        threshold: threshold, policyAcknowledgement: acknowledgement),
      idempotencyKey: idempotencyKey)
  }

  func circleMembers(_ circleId: String) async throws -> [CircleMember] {
    let response: CircleMembersResponse = try await APIClient.shared.request("/v1/circles/\(circleId)/members")
    return response.members
  }

  /// Invite someone by Prism id or @handle. An invitation grants nothing on its own — accepting it
  /// makes someone a member, and an ADMIN invitation still waits on the Circle approving them on
  /// Monad before any authority exists.
  func inviteToCircle(circleId: String, prismId: String?, handle: String?, role: String) async throws -> CircleInviteResult {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/invitations",
      body: CircleInviteBody(prismId: prismId, handle: handle, role: role))
  }

  /// Invitations addressed to me, across every Circle.
  func myCircleInvitations() async throws -> [CircleInvitation] {
    let response: CircleInvitationsResponse = try await APIClient.shared.request("/v1/circles/invitations")
    return response.invitations
  }

  func acceptCircleInvitation(circleId: String, inviteId: String) async throws -> CircleInvitationAcceptance {
    try await APIClient.shared.send("/v1/circles/\(circleId)/invitations/\(inviteId)/accept", body: EmptyBody())
  }

  func declineCircleInvitation(circleId: String, inviteId: String) async throws -> CircleInviteResult {
    try await APIClient.shared.send("/v1/circles/\(circleId)/invitations/\(inviteId)/decline", body: EmptyBody())
  }

  /// Change what a member may do — between the roles Prism alone decides.
  ///
  /// This cannot grant or revoke ADMIN in either direction, and the backend refuses if asked: admin
  /// authority is the Safe's owner set, so it moves through `prepareAddCircleAdmin` /
  /// `prepareRemoveCircleAdmin` and a threshold of signatures. It also refuses while the member
  /// still holds a live spending allowance, because taking away the label while leaving the money
  /// access would be worse than refusing.
  func setCircleMemberRole(circleId: String, prismId: String, role: String) async throws -> CircleMemberRoleResult {
    try await APIClient.shared.send("/v1/circles/\(circleId)/members/\(prismId)/role", body: CircleRoleBody(role: role))
  }

  func removeCircleMember(circleId: String, prismId: String) async throws -> CircleMemberRemovalResult {
    try await APIClient.shared.send("/v1/circles/\(circleId)/members/\(prismId)/remove", body: EmptyBody())
  }

  // MARK: governance — changes the Circle has to approve together

  /// Build the Safe transaction that would make someone an admin. Nothing changes here: this
  /// returns the proposal the Circle's admins are asked to approve.
  func prepareAddCircleAdmin(circleId: String, prismId: String?, handle: String?, threshold: Int?) async throws -> CircleGovernanceProposal {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/admins/prepare-add",
      body: CircleAdminBody(prismId: prismId, handle: handle, threshold: threshold))
  }

  /// Removing an admin may force the approval rule down with it — a Circle cannot need three
  /// approvals from two admins. The backend refuses to choose a weaker rule on the Circle's behalf,
  /// so `threshold` is required whenever the current one would no longer fit.
  func prepareRemoveCircleAdmin(circleId: String, prismId: String, threshold: Int?) async throws -> CircleGovernanceProposal {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/admins/prepare-remove",
      body: CircleAdminRemoveBody(prismId: prismId, threshold: threshold))
  }

  func prepareCircleThresholdChange(circleId: String, threshold: Int) async throws -> CircleGovernanceProposal {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/threshold/prepare", body: CircleThresholdBody(threshold: threshold))
  }

  /// Approve a governance change. Identical machinery to approving a payment, and identically
  /// gated: the device rebuilds the Safe digest from the fields it displayed and refuses to sign if
  /// it disagrees with what the backend asked for.
  ///
  /// `payload` must already have passed `CircleGovernanceValidator` — the caller is
  /// `CircleCoordinator.approveGovernance`, which refuses to reach this method otherwise.
  @MainActor
  func approveCircleGovernance(circleId: String, proposalId: String, payload: CircleGovernancePayload) async throws -> CircleGovernanceApprovalResult {
    let mera = MeraAccountManager.shared
    try await mera.beginSession(.payments)
    let signature = try await mera.signTypedDataHex(SafeTypedData.jsonData(for: payload))
    return try await APIClient.shared.send(
      "/v1/circles/\(circleId)/governance/\(proposalId)/approve",
      body: CircleApprovalBody(signature: signature),
      idempotencyKey: "\(proposalId):approve")
  }

  func circleGovernanceStatus(circleId: String, proposalId: String) async throws -> CircleGovernanceProposal {
    try await APIClient.shared.request("/v1/circles/\(circleId)/governance/\(proposalId)")
  }

  func circleSpends(_ circleId: String) async throws -> [CircleSpend] {
    let response: CircleSpendsResponse = try await APIClient.shared.request("/v1/circles/\(circleId)/spend")
    return response.spends
  }

  // MARK: activity

  /// The Circle's own feed: money and governance in one list, each row a projection of a record the
  /// backend already reconciled against the chain. The app does not merge three lists into a
  /// history of its own — that would be a second ledger, assembled on a phone.
  func circleActivity(_ circleId: String, limit: Int = 100) async throws -> CircleActivityResponse {
    try await APIClient.shared.request("/v1/circles/\(circleId)/activity?limit=\(limit)")
  }

  // MARK: closing

  /// What is still standing between this Circle and being closed. Every blocker is a live read, so
  /// this is re-fetched rather than remembered.
  func circleCloseState(_ circleId: String) async throws -> CircleCloseState {
    try await APIClient.shared.request("/v1/circles/\(circleId)/close")
  }

  /// Begin closing. The Circle can still pay money out — that is how a remaining balance leaves —
  /// but nothing more can come in.
  func beginCircleClose(_ circleId: String, reason: String?) async throws -> CircleCloseState {
    try await APIClient.shared.send("/v1/circles/\(circleId)/close/begin", body: CircleCloseBeginBody(reason: reason))
  }

  func cancelCircleClose(_ circleId: String) async throws -> CircleDetail {
    try await APIClient.shared.send("/v1/circles/\(circleId)/close/cancel", body: EmptyBody())
  }

  /// Close it for good. The balance the user was shown is sent back with the request: if it no
  /// longer matches what Monad reports, the backend refuses rather than closing a Circle whose state
  /// changed under the screen.
  func finalizeCircleClose(_ circleId: String, balanceAtomic: String) async throws -> CircleCloseState {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/close/finalize",
      body: CircleCloseFinalizeBody(acknowledgement: .init(balanceAtomic: balanceAtomic)))
  }

  /// Cancel a Circle transaction that has not been broadcast. Pre-broadcast only — once it is away,
  /// what happened to it is the chain's answer, not a button's.
  func cancelCircleProposal(circleId: String, proposalId: String) async throws -> CircleGovernanceProposal {
    try await APIClient.shared.send("/v1/circles/\(circleId)/proposals/\(proposalId)/cancel", body: EmptyBody())
  }

  // MARK: - member withdrawals: money OUT of a Circle, capped by a member's own net contribution

  struct ProposeCircleWithdrawalBody: Encodable { let amountAtomic: String }

  /// What this member may withdraw from this Circle right now. Always a live read, never a number
  /// this screen is trusted to compute for itself.
  func circleWithdrawable(_ circleId: String) async throws -> CircleWithdrawableResponse {
    try await APIClient.shared.request("/v1/circles/\(circleId)/withdrawable")
  }

  /// Propose taking money out of a Circle, to the caller's own account. Like any other Circle
  /// payment, this only builds the proposal: the Circle's normal threshold of approvals still gates
  /// whether it ever executes.
  func proposeCircleWithdrawal(circleId: String, amountAtomic: String) async throws -> CircleWithdrawalProposalResponse {
    try await APIClient.shared.send(
      "/v1/circles/\(circleId)/withdrawals",
      body: ProposeCircleWithdrawalBody(amountAtomic: amountAtomic))
  }

  /// Preview, per member, what closing this Circle would pay out right now. Writes nothing and
  /// proposes nothing; `proposeCircleClosePayouts` is the action this previews.
  func circleClosePlan(_ circleId: String) async throws -> CircleClosePlan {
    try await APIClient.shared.request("/v1/circles/\(circleId)/close/plan")
  }

  /// Turn the close preview into real proposals: one withdrawal-tagged payment per member with a
  /// positive payout, each still needing the Circle's own approvals before anything moves.
  func proposeCircleClosePayouts(_ circleId: String) async throws -> CircleClosePayoutsResult {
    try await APIClient.shared.send("/v1/circles/\(circleId)/close/payouts", body: EmptyBody())
  }
}

struct CircleCloseBeginBody: Encodable { let reason: String? }
struct CircleCloseFinalizeBody: Encodable {
  struct Acknowledgement: Encodable { let balanceAtomic: String }
  let acknowledgement: Acknowledgement
}
