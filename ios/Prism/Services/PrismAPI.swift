import Foundation

/// Thin typed wrapper over the Prism backend. All signing goes through the Mera account bridge:
/// onboarding proves account control, identity changes are authorized by the Mera account, and
/// payments are EIP-712 ERC-3009 authorizations. Prism never handles a private key.
final class PrismAPI: @unchecked Sendable {
  static let shared = PrismAPI()
  private let api = APIClient.shared
  @MainActor private var mera: MeraAccountManager { MeraAccountManager.shared }
  private init() {}

  // MARK: request bodies
  struct DeviceAuthBody: Encodable { let account: String; let bindingProof: String; let challenge: String; let handle: String? }
  struct OTPStartBody: Encodable { let phone: String }
  struct OTPCheckBody: Encodable { let phone: String; let code: String; let account: String; let bindingProof: String; let challenge: String; let handle: String? }
  struct EmptyChallengeBody: Encodable {}
  struct SignedHandleBody: Encodable { let handle: String; let accountSignature: String }
  struct PrivacyBody: Encodable { let phoneDiscoverable: Bool; let handleSearchable: Bool }
  struct ProfileBody: Encodable { let displayName: String }
  struct PhoneBindingCheckBody: Encodable { let phone: String; let code: String; let accountSignature: String }
  struct ResolvePhoneBody: Encodable { let phone: String }
  struct ResolveHandleBody: Encodable { let handle: String }
  struct ResolvePrismBody: Encodable { let prismId: String }
  struct PreparePaymentBody: Encodable { let resolution: ResolutionResponse; let amountAtomic: String; let requestId: String?; let memo: String; let entryMethod: String? }
  struct SubmitPaymentBody: Encodable { let paymentId: String; let prismSignature: String; let tokenSignature: String }
  struct DraftRequestBody: Encodable { let payerPrismId: String; let amountAtomic: String; let memo: String }
  struct CommitRequestBody: Encodable { let requestId: String; let signature: String }
  struct RequestStatusBody: Encodable { let requestId: String; let status: String }
  struct PrepareClaimBody: Encodable { let recipientPhone: String; let amountAtomic: String; let expirySeconds: Int; let memo: String }
  struct FundClaimBody: Encodable { let signature: String }
  struct ClaimIntentBody: Encodable { let recipientIntentSignature: String }
  struct AuroraDepositAddressBody: Encodable { let depositChain: String }
  struct AuroraQuoteBody: Encodable { let destinationChain: String; let destinationAsset: String; let destinationAddress: String; let amountAtomic: String; let contractAddress: String? }
  struct AuroraPrepareBody: Encodable { let routeId: String }
  struct AuroraSubmitBody: Encodable { let routeId: String; let prismSignature: String; let tokenSignature: String }

  func config() async throws -> PrismNetworkConfig { try await api.request("/v1/config") }

  // MARK: Prism Save (USDC → AUSD → earnAUSD). Read-only quotes; the client re-verifies the plan.
  func saveState() async throws -> SaveState { try await api.request("/v1/save/state") }
  func saveQuote(amountAtomic: String) async throws -> SaveQuote {
    try await api.send("/v1/save/quote", body: SaveQuoteBody(amountAtomic: amountAtomic))
  }
  func savePosition() async throws -> SavePositionResponse { try await api.request("/v1/save/position") }
  func saveWithdrawals() async throws -> SaveWithdrawalsResponse { try await api.request("/v1/save/withdrawals") }
  func withdrawQuote(sharesAtomic: String) async throws -> WithdrawQuote {
    try await api.send("/v1/save/withdraw/quote", body: WithdrawQuoteBody(sharesAtomic: sharesAtomic))
  }
  func runtimeConfig() async throws -> PrismNetworkConfig { try await config() }

  // MARK: onboarding

  /// Fetch a single-use binding challenge and sign it, so the account-control proof can't be replayed.
  @MainActor
  private func freshBindingProof(for address: String) async throws -> (proof: String, nonce: String) {
    let challenge: BindingChallenge = try await api.send("/v1/auth/challenge", body: EmptyChallengeBody())
    let proof = try await mera.bindingProofHex(for: address, nonce: challenge.nonce)
    return (proof, challenge.nonce)
  }

  @MainActor
  func createDeviceIdentity() async throws -> AuthResponse {
    let account = try await mera.ensureAccount()
    let (proof, nonce) = try await freshBindingProof(for: account.address)
    let response: AuthResponse = try await api.send(
      "/v1/auth/device", body: DeviceAuthBody(account: account.address, bindingProof: proof, challenge: nonce, handle: nil))
    try KeychainStore.shared.setString(response.session, for: "session")
    return response
  }

  @MainActor
  func createHandleIdentity(handle: String) async throws -> AuthResponse {
    let account = try await mera.ensureAccount()
    let (proof, nonce) = try await freshBindingProof(for: account.address)
    let response: AuthResponse = try await api.send(
      "/v1/auth/device", body: DeviceAuthBody(account: account.address, bindingProof: proof, challenge: nonce, handle: handle))
    try KeychainStore.shared.setString(response.session, for: "session")
    return response
  }

  func startOTP(phone: String) async throws {
    let _: SimpleStatus = try await api.send("/v1/auth/otp/start", body: OTPStartBody(phone: phone))
  }

  @MainActor
  func checkOTP(phone: String, code: String) async throws -> AuthResponse {
    let account = try await mera.ensureAccount()
    let (proof, nonce) = try await freshBindingProof(for: account.address)
    let response: AuthResponse = try await api.send(
      "/v1/auth/otp/check",
      body: OTPCheckBody(phone: phone, code: code, account: account.address, bindingProof: proof, challenge: nonce, handle: nil))
    try KeychainStore.shared.setString(response.session, for: "session")
    return response
  }

  func me() async throws -> PrismIdentity { try await api.request("/v1/me") }
  func balance() async throws -> BalanceResponse { try await api.request("/v1/me/balance") }

  func startPhoneBinding(phone: String) async throws {
    let _: SimpleStatus = try await api.send("/v1/me/phone/start", body: OTPStartBody(phone: phone))
  }

  // Identity changes re-authenticate the Mera account (high-risk scope).
  @MainActor
  func checkPhoneBinding(phone: String, code: String) async throws -> PrismIdentity {
    let current = try await me()
    let normalized = ContactService.normalize(phone) ?? phone
    try await mera.beginSession(.identity)
    let signature = try await mera.signCanonicalHex([
      "action": "bind_phone", "aliasVersion": current.aliasVersion, "prismId": current.prismId, "value": normalized,
    ])
    return try await api.send(
      "/v1/me/phone/check", body: PhoneBindingCheckBody(phone: normalized, code: code, accountSignature: signature))
  }

  @MainActor
  func setHandle(_ raw: String) async throws -> PrismIdentity {
    let current = try await me()
    let handle = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "@", with: "").lowercased()
    try await mera.beginSession(.identity)
    let signature = try await mera.signCanonicalHex([
      "action": "set_handle", "aliasVersion": current.aliasVersion, "prismId": current.prismId, "value": handle,
    ])
    return try await api.send("/v1/me/handle", body: SignedHandleBody(handle: handle, accountSignature: signature))
  }

  func setPrivacy(phoneDiscoverable: Bool, handleSearchable: Bool) async throws -> PrismIdentity {
    try await api.send("/v1/me/privacy", body: PrivacyBody(phoneDiscoverable: phoneDiscoverable, handleSearchable: handleSearchable))
  }
  func setDisplayName(_ displayName: String) async throws -> PrismIdentity {
    try await api.send("/v1/me/profile", body: ProfileBody(displayName: displayName))
  }

  func resolve(phone: String) async throws -> ResolutionResponse { try await api.send("/v1/resolve/phone", body: ResolvePhoneBody(phone: phone)) }
  func resolve(handle: String) async throws -> ResolutionResponse { try await api.send("/v1/resolve/handle", body: ResolveHandleBody(handle: handle)) }
  func resolve(prismId: String) async throws -> ResolutionResponse { try await api.send("/v1/resolve/prism", body: ResolvePrismBody(prismId: prismId)) }

  // MARK: direct payments (Prism envelope + ERC-3009 USDC)

  func preparePayment(resolution: ResolutionResponse, amountAtomic: String, requestId: String? = nil, memo: String = "", entryMethod: PrismEntryMethod? = nil) async throws -> PreparedPayment {
    try await api.send("/v1/payments/prepare", body: PreparePaymentBody(resolution: resolution, amountAtomic: amountAtomic, requestId: requestId, memo: memo, entryMethod: entryMethod?.rawValue))
  }
  /// The Mera account signs the Prism envelope and token authorization, then the relayer submits.
  @MainActor
  func submitPayment(_ prepared: PreparedPayment) async throws -> OperationResult {
    try await mera.beginSession(.payments)
    let prismSignature = try await mera.signTypedDataHex(prepared.typedData.envelope.jsonData())
    let tokenSignature = try await mera.signTypedDataHex(prepared.typedData.tokenAuthorization.jsonData())
    return try await api.send("/v1/payments/submit",
      body: SubmitPaymentBody(paymentId: prepared.paymentId, prismSignature: prismSignature, tokenSignature: tokenSignature),
      idempotencyKey: prepared.paymentId)
  }
  func paymentStatus(_ id: String) async throws -> OperationStatus { try await api.request("/v1/payments/\(id)") }
  /// The canonical projection of any operation: { payment, events, receipt } — the one payment model.
  /// Operation ids may contain '#' (claim ops), so the id is percent-encoded for the path.
  func canonicalPayment(_ id: String) async throws -> PrismCanonicalPayment {
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    return try await api.request("/v1/payments/\(encoded)/canonical")
  }

  /// The canonical, evidence-backed Payment Proof for any operation the caller owns.
  func canonicalProof(_ id: String) async throws -> PrismPaymentProof {
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    return try await api.request("/v1/payments/\(encoded)/proof")
  }

  // MARK: device-P256 → PrismP256Account (adoption of the on-chain P-256 path)
  struct P256AccountBody: Encodable { let qx: String; let qy: String }
  struct P256PrepareBody: Encodable { let recipient: String; let amountAtomic: String }
  struct P256SubmitBody: Encodable { let opId: String; let r: String; let s: String }

  func ensureP256Account(qx: String, qy: String) async throws -> P256AccountResponse {
    try await api.send("/v1/p256/account", body: P256AccountBody(qx: qx, qy: qy))
  }
  func prepareP256(recipient: String, amountAtomic: String) async throws -> P256PrepareResponse {
    try await api.send("/v1/p256/prepare", body: P256PrepareBody(recipient: recipient, amountAtomic: amountAtomic))
  }
  func submitP256(opId: String, r: String, s: String) async throws -> P256OpStatus {
    try await api.send("/v1/p256/submit", body: P256SubmitBody(opId: opId, r: r, s: s), idempotencyKey: opId)
  }
  func p256Status(_ opId: String) async throws -> P256OpStatus {
    // opId is path-safe (p256_<hex>); do NOT pre-encode — the API client's URL builder would
    // double-encode it (a leading '%' becomes '%25'), which previously 404'd the status poll.
    try await api.request("/v1/p256/ops/\(opId)")
  }

  func activity() async throws -> [ActivityRecord] { try await api.request("/v1/activity") }

  /// PRISM Continuity Lab: the fixtures-only baseline-vs-PRISM comparison report. Read-only; the
  /// server creates no payment state producing it.
  func continuityLab() async throws -> ContinuityLabReport { try await api.request("/v1/lab/continuity") }

  // MARK: cross-chain (Aurora Intents)
  //
  // Receiving needs no signature: the deposit address is derived from the user's own account, so
  // there is nothing for Prism to authorize. That is why none of these touch the Mera bridge.

  /// Chains and assets Aurora can currently route, plus whether a route can actually settle against
  /// the chain this build talks to.
  func auroraChains() async throws -> AuroraChainsResponse { try await api.request("/v1/aurora/chains") }

  /// Create (or return) the permanent deposit address for a source chain. Idempotent server-side —
  /// calling it again for the same chain returns the same address with `alreadyExists: true`.
  func createAuroraDepositAddress(depositChain: String) async throws -> AuroraDeposit {
    try await api.send("/v1/aurora/deposits/address", body: AuroraDepositAddressBody(depositChain: depositChain))
  }

  func auroraDeposits() async throws -> AuroraDepositsResponse { try await api.request("/v1/aurora/deposits") }

  /// Refresh one address against Aurora's live status. A response with `statusKnown == false` means
  /// the status service could not be reached, not that nothing has happened.
  func refreshAuroraDeposit(address: String) async throws -> AuroraDeposit {
    let encoded = address.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? address
    return try await api.request("/v1/aurora/deposits/\(encoded)")
  }

  /// USDC that has landed at the user's account on Monad, from the activity index.
  func auroraArrivals() async throws -> AuroraArrivalsResponse { try await api.request("/v1/aurora/arrivals") }

  /// Price a route out of USDC on Monad. Nothing is committed — this is what the user reads before
  /// they approve anything.
  func quoteAuroraSend(destinationChain: String, destinationAsset: String, destinationAddress: String, amountAtomic: String, contractAddress: String? = nil) async throws -> AuroraRoute {
    try await api.send("/v1/aurora/quote", body: AuroraQuoteBody(
      destinationChain: destinationChain, destinationAsset: destinationAsset,
      destinationAddress: destinationAddress, amountAtomic: amountAtomic, contractAddress: contractAddress))
  }

  /// Freeze the quote into a signable payment. Idempotent server-side: a retry returns the same
  /// payload rather than minting a second envelope against one quote.
  func prepareAuroraSend(routeId: String) async throws -> PreparedAuroraSend {
    try await api.send("/v1/aurora/send/prepare", body: AuroraPrepareBody(routeId: routeId))
  }

  /// Sign both payloads with the Mera account and relay the Monad leg.
  ///
  /// This is the same pair of signatures a direct payment uses — the difference is entirely in what
  /// the envelope's opaque hash slot binds, which for a route is the destination chain, asset,
  /// recipient and guaranteed minimum. One approval therefore authorizes the whole promise.
  @MainActor
  func submitAuroraSend(_ prepared: PreparedAuroraSend) async throws -> OperationResult {
    try await mera.beginSession(.payments)
    let prismSignature = try await mera.signTypedDataHex(prepared.typedData.envelope.jsonData())
    let tokenSignature = try await mera.signTypedDataHex(prepared.typedData.tokenAuthorization.jsonData())
    return try await api.send(
      "/v1/aurora/send/submit",
      body: AuroraSubmitBody(routeId: prepared.route.routeId, prismSignature: prismSignature, tokenSignature: tokenSignature),
      idempotencyKey: prepared.paymentId)
  }

  func auroraRoutes() async throws -> AuroraRoutesResponse { try await api.request("/v1/aurora/routes") }

  /// Reconcile both legs. A completed `payment` means the money left the account; only
  /// `route.state == .delivered` means it arrived.
  func auroraRouteStatus(_ routeId: String) async throws -> AuroraRouteStatus {
    let encoded = routeId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? routeId
    return try await api.request("/v1/aurora/routes/\(encoded)")
  }
  func requests() async throws -> [PaymentRequestRecord] { try await api.request("/v1/requests") }

  func draftRequest(payerPrismId: String, amountAtomic: String, memo: String) async throws -> RequestDraftResponse {
    try await api.send("/v1/requests/draft", body: DraftRequestBody(payerPrismId: payerPrismId, amountAtomic: amountAtomic, memo: memo))
  }
  @MainActor
  func commitRequest(_ draft: RequestDraftResponse) async throws -> PaymentRequestRecord {
    let signature = try await mera.signMessageHex(draft.signable)
    return try await api.send("/v1/requests/commit", body: CommitRequestBody(requestId: draft.request.requestId, signature: signature))
  }
  func setRequestStatus(_ id: String, status: String) async throws -> PaymentRequestRecord {
    try await api.send("/v1/requests/status", body: RequestStatusBody(requestId: id, status: status))
  }

  // MARK: claims (send before signup)

  func claims() async throws -> [ClaimRecord] { try await api.request("/v1/claims") }
  func prepareClaim(phone: String, amountAtomic: String, memo: String = "") async throws -> PreparedClaim {
    try await api.send("/v1/claims/prepare", body: PrepareClaimBody(recipientPhone: phone, amountAtomic: amountAtomic, expirySeconds: 604800, memo: memo))
  }
  @MainActor
  func fundClaim(_ prepared: PreparedClaim) async throws -> OperationResult {
    try await mera.beginSession(.payments)
    let signature = try await mera.signTypedDataHex(prepared.typedData.jsonData())
    return try await api.send("/v1/claims/\(prepared.claimId)/fund", body: FundClaimBody(signature: signature), idempotencyKey: prepared.claimId)
  }
  func eligibleClaims() async throws -> [ClaimRecord] { try await api.request("/v1/claims/eligible") }
  /// The recipient signs a ClaimIntent with their Mera account; the backend adds its eligibility and relays.
  @MainActor
  func collectClaim(_ claim: ClaimRecord) async throws -> OperationResult {
    let cfg = try await config()
    let identity = try await me()
    guard let vault = cfg.claimVault, let recipient = identity.account, let chainId = Int(cfg.chainId) else {
      throw APIError.server("Claims aren't available right now.")
    }
    let typed = try JSONSerialization.data(withJSONObject: Self.claimIntentTypedData(claimId: claim.claimId, recipient: recipient, vault: vault, chainId: chainId))
    try await mera.beginSession(.payments)
    let signature = try await mera.signTypedDataHex(typed)
    return try await api.send("/v1/claims/\(claim.claimId)/claim", body: ClaimIntentBody(recipientIntentSignature: signature), idempotencyKey: claim.claimId)
  }
  func refundClaim(_ claimId: String) async throws -> OperationResult {
    try await api.send("/v1/claims/\(claimId)/refund", body: EmptyBody(), idempotencyKey: claimId)
  }
  func claimStatus(_ id: String) async throws -> OperationStatus { try await api.request("/v1/claims/\(id)") }

  // MARK: developer/judge proof surface (dev backend only)

  func paymentProof(_ paymentId: String) async throws -> PaymentProof { try await api.request("/v1/proof/\(paymentId)") }
  func metrics() async throws -> MetricsSnapshot { try await api.request("/v1/metrics") }

  /// EIP-712 ClaimIntent payload matching PrismClaimVault (domain PrismClaimVault / 1).
  private static func claimIntentTypedData(claimId: String, recipient: String, vault: String, chainId: Int) -> [String: Any] {
    [
      "domain": ["name": "PrismClaimVault", "version": "1", "chainId": chainId, "verifyingContract": vault],
      "primaryType": "ClaimIntent",
      "types": ["ClaimIntent": [["name": "claimId", "type": "bytes32"], ["name": "recipient", "type": "address"]]],
      "message": ["claimId": claimId, "recipient": recipient]
    ]
  }
}

struct SimpleStatus: Decodable {
  let status: String?
  let channel: String?
  let sid: String?
}
