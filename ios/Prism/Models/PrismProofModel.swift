import Foundation
import SwiftUI

// MARK: - Canonical Payment Proof (decodes GET /v1/payments/:id/proof)

/// Evidence-backed, inspectable proof for one Prism operation. Its job is to make the invisible
/// architecture legible to a skeptic — did value move, was a human resolved, was the phone exposed
/// on-chain, did the user need MON, was it confirmed on Monad, can I inspect the tx, was it read
/// independently — never to dump raw chain debugging. Statuses are honest: "no" only when a check
/// proved it, "unknown" otherwise.
struct PrismPaymentProof: Codable {
  let paymentId: String
  var kind: String = ""
  var direction: String = "sent"
  var amountAtomic: String? = nil
  var tokenSymbol: String? = "USDC"
  var proofStatus: String = "unknown"
  var evidenceLevel: String = "E0"
  var demo: Bool = false
  var recipient: Recipient = .init()
  var privacy: Privacy = .init()
  var authorization: Authorization = .init()
  var gas: Gas = .init()
  var settlement: Settlement = .init()
  var verification: Verification = .init()
  var request: RequestBinding? = nil
  var claim: ClaimProof? = nil
  var evidence: [PrismEvidenceItem] = []
  var generatedAt: String? = nil

  struct Recipient: Codable {
    var displayName: String? = nil
    var handle: String? = nil
    var entryMethod: String? = nil
    var resolutionReference: String? = nil
    var resolutionVersion: Int? = nil
  }
  struct Privacy: Codable {
    var calldataCheck: String = "unknown"
    var eventCheck: String = "unknown"
    var schemaCheck: String = "unknown"
    var sensitiveOnchain: String = "unknown"
    var rawPhoneInCalldata: String = "unknown"
    var rawPhoneInEvents: String = "unknown"
    var phoneDerivedHashOnchain: String = "unknown"
  }
  struct Authorization: Codable {
    var method: String = "Mera passkey"
    var localApproval: String? = nil
    var otpForSpending: String = "no"
  }
  struct Gas: Codable {
    var userPaidDollars: String = "0.00"
    var monRequiredFromSender: String = "0"
    var sponsored: String = "unknown"
    var sponsoredBy: String? = nil
  }
  struct Settlement: Codable {
    var network: String = "Monad"
    var chainId: String? = nil
    var asset: String = "USDC"
    var status: String = "unknown"
    var blockNumber: String? = nil
    var txHash: String? = nil
    var explorerUrl: String? = nil
    var createdAt: String? = nil
    var submittedAt: String? = nil
    var confirmedAt: String? = nil
  }
  struct Verification: Codable {
    var monadReceipt: String = "unknown"
    var blockConfirmation: String = "unknown"
    var alchemyReadback: String = "unknown"
    var alchemyProvider: String? = nil
    var envioIndex: String = "unknown"
    var balanceDelta: String = "unknown"
  }
  struct RequestBinding: Codable {
    var requestId: String? = nil
    var label: String? = nil
    var amountAtomic: String? = nil
    var boundToPayment: String = "unknown"
  }
  struct ClaimProof: Codable {
    var claimId: String? = nil
    var fundsProtected: String = "unknown"
    var recipientEligibility: String = "unknown"
    var claimedAt: String? = nil
    var expiredAt: String? = nil
    var refund: String? = nil
    var senderRestored: String? = nil
  }
}

// Lenient decoding: a missing or renamed field degrades to its default (or Unknown) rather than
// blanking the whole proof surface. The backend sends complete objects; this is defence in depth.
extension PrismPaymentProof {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      paymentId: try c.decode(String.self, forKey: .paymentId),
      kind: try c.decodeIfPresent(String.self, forKey: .kind) ?? "",
      direction: try c.decodeIfPresent(String.self, forKey: .direction) ?? "sent",
      amountAtomic: try c.decodeIfPresent(String.self, forKey: .amountAtomic),
      tokenSymbol: try c.decodeIfPresent(String.self, forKey: .tokenSymbol) ?? "USDC",
      proofStatus: try c.decodeIfPresent(String.self, forKey: .proofStatus) ?? "unknown",
      evidenceLevel: try c.decodeIfPresent(String.self, forKey: .evidenceLevel) ?? "E0",
      demo: try c.decodeIfPresent(Bool.self, forKey: .demo) ?? false,
      recipient: try c.decodeIfPresent(Recipient.self, forKey: .recipient) ?? .init(),
      privacy: try c.decodeIfPresent(Privacy.self, forKey: .privacy) ?? .init(),
      authorization: try c.decodeIfPresent(Authorization.self, forKey: .authorization) ?? .init(),
      gas: try c.decodeIfPresent(Gas.self, forKey: .gas) ?? .init(),
      settlement: try c.decodeIfPresent(Settlement.self, forKey: .settlement) ?? .init(),
      verification: try c.decodeIfPresent(Verification.self, forKey: .verification) ?? .init(),
      request: try c.decodeIfPresent(RequestBinding.self, forKey: .request),
      claim: try c.decodeIfPresent(ClaimProof.self, forKey: .claim),
      evidence: try c.decodeIfPresent([PrismEvidenceItem].self, forKey: .evidence) ?? [],
      generatedAt: try c.decodeIfPresent(String.self, forKey: .generatedAt)
    )
  }
}
extension PrismPaymentProof.Recipient {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      displayName: try c.decodeIfPresent(String.self, forKey: .displayName),
      handle: try c.decodeIfPresent(String.self, forKey: .handle),
      entryMethod: try c.decodeIfPresent(String.self, forKey: .entryMethod),
      resolutionReference: try c.decodeIfPresent(String.self, forKey: .resolutionReference),
      resolutionVersion: try c.decodeIfPresent(Int.self, forKey: .resolutionVersion))
  }
}
extension PrismPaymentProof.Privacy {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    func s(_ k: CodingKeys) throws -> String { try c.decodeIfPresent(String.self, forKey: k) ?? "unknown" }
    self.init(
      calldataCheck: try s(.calldataCheck), eventCheck: try s(.eventCheck), schemaCheck: try s(.schemaCheck),
      sensitiveOnchain: try s(.sensitiveOnchain), rawPhoneInCalldata: try s(.rawPhoneInCalldata),
      rawPhoneInEvents: try s(.rawPhoneInEvents), phoneDerivedHashOnchain: try s(.phoneDerivedHashOnchain))
  }
}
extension PrismPaymentProof.Authorization {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      method: try c.decodeIfPresent(String.self, forKey: .method) ?? "Mera passkey",
      localApproval: try c.decodeIfPresent(String.self, forKey: .localApproval),
      otpForSpending: try c.decodeIfPresent(String.self, forKey: .otpForSpending) ?? "no")
  }
}
extension PrismPaymentProof.Gas {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      userPaidDollars: try c.decodeIfPresent(String.self, forKey: .userPaidDollars) ?? "0.00",
      monRequiredFromSender: try c.decodeIfPresent(String.self, forKey: .monRequiredFromSender) ?? "0",
      sponsored: try c.decodeIfPresent(String.self, forKey: .sponsored) ?? "unknown",
      sponsoredBy: try c.decodeIfPresent(String.self, forKey: .sponsoredBy))
  }
}
extension PrismPaymentProof.Settlement {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      network: try c.decodeIfPresent(String.self, forKey: .network) ?? "Monad",
      chainId: try c.decodeIfPresent(String.self, forKey: .chainId),
      asset: try c.decodeIfPresent(String.self, forKey: .asset) ?? "USDC",
      status: try c.decodeIfPresent(String.self, forKey: .status) ?? "unknown",
      blockNumber: try c.decodeIfPresent(String.self, forKey: .blockNumber),
      txHash: try c.decodeIfPresent(String.self, forKey: .txHash),
      explorerUrl: try c.decodeIfPresent(String.self, forKey: .explorerUrl),
      createdAt: try c.decodeIfPresent(String.self, forKey: .createdAt),
      submittedAt: try c.decodeIfPresent(String.self, forKey: .submittedAt),
      confirmedAt: try c.decodeIfPresent(String.self, forKey: .confirmedAt))
  }
}
extension PrismPaymentProof.Verification {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    func s(_ k: CodingKeys) throws -> String { try c.decodeIfPresent(String.self, forKey: k) ?? "unknown" }
    self.init(
      monadReceipt: try s(.monadReceipt), blockConfirmation: try s(.blockConfirmation),
      alchemyReadback: try s(.alchemyReadback),
      alchemyProvider: try c.decodeIfPresent(String.self, forKey: .alchemyProvider),
      envioIndex: try s(.envioIndex), balanceDelta: try s(.balanceDelta))
  }
}
extension PrismPaymentProof.RequestBinding {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      requestId: try c.decodeIfPresent(String.self, forKey: .requestId),
      label: try c.decodeIfPresent(String.self, forKey: .label),
      amountAtomic: try c.decodeIfPresent(String.self, forKey: .amountAtomic),
      boundToPayment: try c.decodeIfPresent(String.self, forKey: .boundToPayment) ?? "unknown")
  }
}
extension PrismPaymentProof.ClaimProof {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      claimId: try c.decodeIfPresent(String.self, forKey: .claimId),
      fundsProtected: try c.decodeIfPresent(String.self, forKey: .fundsProtected) ?? "unknown",
      recipientEligibility: try c.decodeIfPresent(String.self, forKey: .recipientEligibility) ?? "unknown",
      claimedAt: try c.decodeIfPresent(String.self, forKey: .claimedAt),
      expiredAt: try c.decodeIfPresent(String.self, forKey: .expiredAt),
      refund: try c.decodeIfPresent(String.self, forKey: .refund),
      senderRestored: try c.decodeIfPresent(String.self, forKey: .senderRestored))
  }
}
extension PrismEvidenceItem {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      id: try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString,
      type: try c.decodeIfPresent(PrismEvidenceType.self, forKey: .type) ?? .unknown,
      status: try c.decodeIfPresent(String.self, forKey: .status) ?? "unknown",
      source: try c.decodeIfPresent(String.self, forKey: .source),
      observedAt: try c.decodeIfPresent(String.self, forKey: .observedAt),
      reference: try c.decodeIfPresent(String.self, forKey: .reference),
      detail: try c.decodeIfPresent(String.self, forKey: .detail),
      level: try c.decodeIfPresent(String.self, forKey: .level))
  }
}

// MARK: - Typed evidence (section 11)

enum PrismEvidenceType: String, Codable {
  case transactionReceipt, blockConfirmation, alchemyReadback, envioIndex, balanceDelta
  case resolutionAttestation, privacyCalldataCheck, privacyEventCheck, contractSchemaCheck
  case requestBinding, claimState, unknown
  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = PrismEvidenceType(rawValue: raw) ?? .unknown
  }
  var title: String {
    switch self {
    case .transactionReceipt: "Monad receipt"
    case .blockConfirmation: "Block confirmation"
    case .alchemyReadback: "Alchemy readback"
    case .envioIndex: "Envio index"
    case .balanceDelta: "Recipient balance delta"
    case .resolutionAttestation: "Resolution attestation"
    case .privacyCalldataCheck: "Calldata privacy scan"
    case .privacyEventCheck: "Event privacy scan"
    case .contractSchemaCheck: "Contract schema audit"
    case .requestBinding: "Request binding"
    case .claimState: "Claim state"
    case .unknown: "Evidence"
    }
  }
}

struct PrismEvidenceItem: Codable, Identifiable {
  let id: String
  let type: PrismEvidenceType
  let status: String
  var source: String? = nil
  var observedAt: String? = nil
  var reference: String? = nil
  var detail: String? = nil
  var level: String? = nil
}

// MARK: - Presentation helpers (consumer labels + tone from raw status strings)

enum ProofTone: Equatable { case positive, neutral, pending, danger, muted }

struct ProofBadge {
  let text: String
  let tone: ProofTone

  /// The top-level proof status → the headline badge (VERIFIED / PARTIALLY VERIFIED / …).
  static func status(_ raw: String, demo: Bool) -> ProofBadge {
    if demo { return .init(text: "DEMO DATA", tone: .neutral) }
    switch raw {
    case "verified": return .init(text: "VERIFIED", tone: .positive)
    case "partially_verified": return .init(text: "PARTIALLY VERIFIED", tone: .pending)
    case "pending": return .init(text: "PENDING", tone: .pending)
    case "unknown": return .init(text: "UNKNOWN", tone: .muted)
    default: return .init(text: raw.uppercased(), tone: .muted)
    }
  }

  /// A per-check status → a short consumer label + tone. Handles the shared vocabulary
  /// (pass/fail/pending/unavailable/not_configured/unknown) plus yes/no privacy answers.
  static func check(_ raw: String?, passText: String = "Verified", failText: String = "Failed") -> ProofBadge {
    switch raw {
    case "pass", "verified", "indexed", "confirmed": return .init(text: passText, tone: .positive)
    case "fail": return .init(text: failText, tone: .danger)
    case "pending", "available": return .init(text: "Pending", tone: .pending)
    case "unavailable": return .init(text: "Unavailable", tone: .muted)
    case "not_configured": return .init(text: "Not configured", tone: .muted)
    case "yes": return .init(text: "Yes", tone: .positive)
    case "no": return .init(text: "No", tone: .positive)
    default: return .init(text: "Unknown", tone: .muted)
    }
  }

  /// The privacy "exposed?" answer is inverted: "No" (not exposed) is the good outcome.
  static func exposure(_ raw: String?) -> ProofBadge {
    switch raw {
    case "no": return .init(text: "No", tone: .positive)
    case "yes": return .init(text: "Yes", tone: .danger)
    default: return .init(text: "Unknown", tone: .muted)
    }
  }
}

extension ProofTone {
  var color: Color {
    switch self {
    case .positive: PrismTheme.positive
    case .neutral: PrismTheme.mintDeep
    case .pending: PrismTheme.amber
    case .danger: PrismTheme.danger
    case .muted: PrismTheme.muted
    }
  }
}

#if DEBUG
extension PrismPaymentProof {
  /// A believable-but-clearly-demo proof fixture. When `demo` is true the view stamps DEMO DATA and
  /// the evidence level is capped at E1 — never a live verification badge over a fixture.
  static func fixture(status: String = "verified", demo: Bool = false, claim: Bool = false, request: Bool = false) -> PrismPaymentProof {
    var p = PrismPaymentProof(paymentId: "0xdemopayment000000000000000000000000000000000000000000000000demo")
    p.kind = claim ? "claim-collection" : "payment"
    p.direction = "sent"
    p.amountAtomic = "20000000"
    p.proofStatus = status
    p.evidenceLevel = demo ? "E1" : "E3"
    p.demo = demo
    p.recipient = .init(displayName: "Tobi Bakare", handle: "@tobi", entryMethod: "contacts", resolutionReference: "res_9f2a1c7be4", resolutionVersion: 4)
    p.privacy = .init(calldataCheck: "pass", eventCheck: "pass", schemaCheck: "pass", sensitiveOnchain: "no", rawPhoneInCalldata: "no", rawPhoneInEvents: "no", phoneDerivedHashOnchain: "no")
    p.authorization = .init(method: "Mera passkey", localApproval: "Face ID", otpForSpending: "no")
    p.gas = .init(userPaidDollars: "0.00", monRequiredFromSender: "0", sponsored: "pass", sponsoredBy: "0xF00D")
    p.settlement = .init(network: "Monad", chainId: "10143", asset: "USDC", status: "confirmed", blockNumber: "38420119", txHash: "0x72f0aa11bbccddeeff0011223344556677889900aabbccddeeff001122334491a", explorerUrl: "https://testnet.monadexplorer.com/tx/0x72f", createdAt: "2026-09-08T02:31:01Z", submittedAt: "2026-09-08T02:31:02Z", confirmedAt: "2026-09-08T02:31:03Z")
    p.verification = .init(monadReceipt: "pass", blockConfirmation: "pass", alchemyReadback: "pass", alchemyProvider: "alchemy", envioIndex: "not_configured", balanceDelta: "pass")
    if request { p.request = .init(requestId: "req_lunch01", label: "Lunch · $15", amountAtomic: "15000000", boundToPayment: "yes") }
    if claim { p.claim = .init(claimId: "clm_7be4a1", fundsProtected: "yes", recipientEligibility: "verified", claimedAt: "2026-09-05T12:00:00Z", refund: nil, senderRestored: nil) }
    p.evidence = [
      PrismEvidenceItem(id: "transactionReceipt:demo", type: .transactionReceipt, status: "pass", source: "monad", reference: "0x72f…491a", detail: "receipt status success", level: p.evidenceLevel),
      PrismEvidenceItem(id: "privacyCalldataCheck:demo", type: .privacyCalldataCheck, status: "pass", source: "prism", detail: "8 calldata fields vs 2 prohibited values", level: p.evidenceLevel),
      PrismEvidenceItem(id: "contractSchemaCheck:demo", type: .contractSchemaCheck, status: "pass", source: "contract-source-audit", detail: "no phone-derived field emitted or stored", level: p.evidenceLevel)
    ]
    return p
  }
}
#endif

// MARK: - Safe shareable proof (section 14)

/// A judge/debug-friendly proof summary. Contains only public settlement facts and evidence
/// references — never a phone, OTP, PIN, resolution secret, private key, or passkey material.
enum PaymentProofShare {
  static func text(_ p: PrismPaymentProof) -> String {
    var lines: [String] = []
    lines.append("PRISM PAYMENT PROOF")
    lines.append("paymentId: \(p.paymentId)")
    lines.append("network: \(p.settlement.network) (chain \(p.settlement.chainId ?? "?"))")
    lines.append("asset: \(p.settlement.asset)")
    if let a = p.amountAtomic { lines.append("amount: \(Money.dollars(fromAtomic: a))") }
    lines.append("proofStatus: \(p.proofStatus)")
    lines.append("evidenceLevel: \(p.evidenceLevel)")
    if let tx = p.settlement.txHash { lines.append("txHash: \(tx)") }
    if let b = p.settlement.blockNumber { lines.append("block: \(b)") }
    if let url = p.settlement.explorerUrl { lines.append("explorer: \(url)") }
    lines.append("sensitiveIdentifierOnchain: \(p.privacy.sensitiveOnchain)")
    lines.append("gasSponsored: \(p.gas.sponsored)")
    lines.append("evidence:")
    for e in p.evidence {
      lines.append("  - \(e.type.rawValue): \(e.status)\(e.level.map { " [\($0)]" } ?? "")")
    }
    return lines.joined(separator: "\n")
  }
}
