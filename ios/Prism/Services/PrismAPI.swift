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
  struct DeviceAuthBody: Encodable { let account: String; let bindingProof: String; let handle: String? }
  struct OTPStartBody: Encodable { let phone: String }
  struct OTPCheckBody: Encodable { let phone: String; let code: String; let account: String; let bindingProof: String; let handle: String? }
  struct SignedHandleBody: Encodable { let handle: String; let accountSignature: String }
  struct PrivacyBody: Encodable { let phoneDiscoverable: Bool; let handleSearchable: Bool }
  struct ProfileBody: Encodable { let displayName: String }
  struct PhoneBindingCheckBody: Encodable { let phone: String; let code: String; let accountSignature: String }
  struct ResolvePhoneBody: Encodable { let phone: String }
  struct ResolveHandleBody: Encodable { let handle: String }
  struct ResolvePrismBody: Encodable { let prismId: String }
  struct PreparePaymentBody: Encodable { let resolution: ResolutionResponse; let amountAtomic: String; let token: String; let requestId: String?; let memo: String }
  struct SubmitPaymentBody: Encodable { let paymentId: String; let prismSignature: String; let tokenSignature: String }
  struct DraftRequestBody: Encodable { let payerPrismId: String; let amountAtomic: String; let token: String; let memo: String }
  struct CommitRequestBody: Encodable { let requestId: String; let signature: String }
  struct RequestStatusBody: Encodable { let requestId: String; let status: String }
  struct PrepareClaimBody: Encodable { let recipientPhone: String; let amountAtomic: String; let token: String; let expirySeconds: Int; let memo: String }
  struct FundClaimBody: Encodable { let signature: String }
  struct ClaimIntentBody: Encodable { let recipientIntentSignature: String }

  func config() async throws -> PrismNetworkConfig { try await api.request("/v1/config") }
  func runtimeConfig() async throws -> PrismNetworkConfig { try await config() }

  // MARK: onboarding

  @MainActor
  func createDeviceIdentity() async throws -> AuthResponse {
    let account = try await mera.ensureAccount()
    let proof = try await mera.bindingProofHex(for: account.address)
    let response: AuthResponse = try await api.send(
      "/v1/auth/device", body: DeviceAuthBody(account: account.address, bindingProof: proof, handle: nil))
    try KeychainStore.shared.setString(response.session, for: "session")
    return response
  }

  @MainActor
  func createHandleIdentity(handle: String) async throws -> AuthResponse {
    let account = try await mera.ensureAccount()
    let proof = try await mera.bindingProofHex(for: account.address)
    let response: AuthResponse = try await api.send(
      "/v1/auth/device", body: DeviceAuthBody(account: account.address, bindingProof: proof, handle: handle))
    try KeychainStore.shared.setString(response.session, for: "session")
    return response
  }

  func startOTP(phone: String) async throws {
    let _: SimpleStatus = try await api.send("/v1/auth/otp/start", body: OTPStartBody(phone: phone))
  }

  @MainActor
  func checkOTP(phone: String, code: String) async throws -> AuthResponse {
    let account = try await mera.ensureAccount()
    let proof = try await mera.bindingProofHex(for: account.address)
    let response: AuthResponse = try await api.send(
      "/v1/auth/otp/check",
      body: OTPCheckBody(phone: phone, code: code, account: account.address, bindingProof: proof, handle: nil))
    try KeychainStore.shared.setString(response.session, for: "session")
    return response
  }

  func me() async throws -> PrismIdentity { try await api.request("/v1/me") }
  func balance() async throws -> BalanceResponse { try await api.request("/v1/me/balance") }
  func balances() async throws -> [TokenBalance] {
    let response: BalancesResponse = try await api.request("/v1/me/balances")
    return response.balances
  }

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

  // MARK: direct payments (Prism envelope + ERC-3009 stablecoin)

  func preparePayment(resolution: ResolutionResponse, amountAtomic: String, asset: Stablecoin, requestId: String? = nil, memo: String = "") async throws -> PreparedPayment {
    try await api.send("/v1/payments/prepare", body: PreparePaymentBody(resolution: resolution, amountAtomic: amountAtomic, token: asset.rawValue, requestId: requestId, memo: memo))
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

  func activity() async throws -> [ActivityRecord] { try await api.request("/v1/activity") }
  func requests() async throws -> [PaymentRequestRecord] { try await api.request("/v1/requests") }

  func draftRequest(payerPrismId: String, amountAtomic: String, token: String, memo: String) async throws -> RequestDraftResponse {
    try await api.send("/v1/requests/draft", body: DraftRequestBody(payerPrismId: payerPrismId, amountAtomic: amountAtomic, token: token, memo: memo))
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
  func prepareClaim(phone: String, amountAtomic: String, asset: Stablecoin, memo: String = "") async throws -> PreparedClaim {
    try await api.send("/v1/claims/prepare", body: PrepareClaimBody(recipientPhone: phone, amountAtomic: amountAtomic, token: asset.rawValue, expirySeconds: 604800, memo: memo))
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
