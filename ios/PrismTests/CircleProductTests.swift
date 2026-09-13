import XCTest

@testable import Prism

/// The Circles consumer product, tested where it can be tested without a screen.
///
/// Three things are checked here, and they are the three that break quietly:
///
///  1. **The words.** Circles must never surface Safe, multisig, wallet, signer, threshold, nonce,
///     delegate or allowance vocabulary to a person. That is easy to state and easy to regress the
///     next time someone adds a state, so it is asserted over the whole vocabulary surface rather
///     than spot-checked.
///  2. **Every state has a next action.** A dead end in a shared-money product is where people start
///     guessing, so `CircleState` is swept for one.
///  3. **The wire shapes the screens actually receive.** A Circle's approval inbox holds payments and
///     governance changes in one array, and decoding one as the other would show a blank amount next
///     to an Approve button.
final class CircleProductTests: XCTestCase {

  // MARK: - the words

  /// Terms that must never reach a normal screen. A Circle is not treasury software.
  private let forbidden = [
    "safe", "multisig", "multi-sig", "wallet", "signer", "signature", "threshold", "nonce",
    "delegate", "allowance", "on-chain", "onchain", "gas", "eoa", "erc", "usdc", "token",
    "smart contract", "blockchain", "crypto",
  ]

  private func assertPlainLanguage(_ text: String, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
    let haystack = text.lowercased()
    for term in forbidden {
      // Word-ish boundary check, so "Monad" and "unavailable" don't trip on "nad"/"allow".
      let pattern = "(^|[^a-z])\(NSRegularExpression.escapedPattern(for: term))([^a-z]|$)"
      let found = haystack.range(of: pattern, options: .regularExpression) != nil
      XCTAssertFalse(found, "\(label) exposes \"\(term)\": \(text)", file: file, line: line)
    }
  }

  func testEveryCircleStateSpeaksPlainly() {
    for state in Self.allStates {
      let copy = state.copy
      assertPlainLanguage(copy.title, "state title")
      assertPlainLanguage(copy.detail, "state detail")
      if let action = copy.action { assertPlainLanguage(action, "state action") }
    }
  }

  func testEveryRoleSpeaksPlainly() {
    for role in CircleVocabulary.Role.allCases {
      assertPlainLanguage(role.title, "role title")
      assertPlainLanguage(role.summary, "role summary")
      assertPlainLanguage(role.consequence, "role consequence")
    }
  }

  func testEveryPaymentStatusSpeaksPlainly() {
    let lifecycles = [
      "CREATED", "RESOLVING", "RESOLVED", "PROPOSED", "APPROVAL_PENDING", "APPROVED",
      "SUBMITTED", "CONFIRMING", "CONFIRMED", "RECONCILED", "COMPLETED",
      "EXPIRED", "INVALIDATED", "CANCELLED", "FAILED",
    ]
    for lifecycle in lifecycles {
      assertPlainLanguage(CircleVocabulary.paymentStatus(lifecycle).text, "status for \(lifecycle)")
    }
  }

  func testEveryGovernanceChangeSpeaksPlainly() {
    let kinds = [
      "OWNER_ADD", "OWNER_REMOVE", "THRESHOLD_CHANGE", "MODULE_ENABLE",
      "SPEND_DELEGATE_ADD", "SPEND_DELEGATE_REMOVE", "SPEND_LIMIT_SET", "SPEND_LIMIT_DELETE",
    ]
    for kind in kinds {
      let proposal = Self.governance(kind: kind, memo: nil)
      assertPlainLanguage(CircleVocabulary.governanceTitle(proposal), "title for \(kind)")
    }
  }

  func testApprovalRuleConsequencesSpeakPlainly() {
    for admins in 1...5 {
      for threshold in 1...admins {
        assertPlainLanguage(
          CircleVocabulary.approvalRuleConsequence(threshold: threshold, admins: admins),
          "consequence for \(threshold) of \(admins)")
      }
    }
  }

  // MARK: - no dead ends

  func testEveryStateOffersSomethingToDoOrIsGenuinelyFine() {
    for state in Self.allStates {
      let copy = state.copy
      XCTAssertFalse(copy.title.isEmpty, "a state with no title: \(state)")
      XCTAssertFalse(copy.detail.isEmpty, "a state with no detail: \(state)")

      switch state {
      case .noPendingApprovals, .limitsUnavailable:
        // The only two states where nothing is wrong and nothing is owed. Everything else must
        // name a next step.
        break
      default:
        XCTAssertNotNil(copy.action, "no next action for \(state)")
      }
    }
  }

  /// Colour is never the only carrier of a status: every tone travels with a symbol.
  func testEveryStateCarriesASymbolNotJustAColour() {
    for state in Self.allStates {
      XCTAssertFalse(state.copy.symbol.isEmpty, "no symbol for \(state)")
    }
    for member in ["ACTIVE", "INVITED", "PENDING_ACTIVATION", "PENDING_REMOVAL", "LEFT", "REMOVED"] {
      let status = CircleVocabulary.memberStatus(Self.member(status: member, role: "CONTRIBUTOR"))
      XCTAssertFalse(status.symbol.isEmpty, "no symbol for member status \(member)")
      XCTAssertFalse(status.text.isEmpty)
    }
  }

  // MARK: - the approval rule, stated correctly

  func testTheApprovalRuleNamesTheRealConsequence() {
    // One admin: no ceremony to explain.
    XCTAssertTrue(CircleVocabulary.approvalRuleConsequence(threshold: 1, admins: 1)
      .contains("only admin"))

    // 1-of-N: the dangerous-because-convenient one. It must say a single person can act alone.
    XCTAssertTrue(CircleVocabulary.approvalRuleConsequence(threshold: 1, admins: 3)
      .contains("on their own"))

    // N-of-N: the unrecoverable one. It must say the money can become unmovable.
    let allOfThem = CircleVocabulary.approvalRuleConsequence(threshold: 3, admins: 3)
    XCTAssertTrue(allOfThem.contains("every"))
    XCTAssertTrue(allOfThem.contains("can't be moved"))

    // A rule with spare capacity says how much slack there is, in people.
    XCTAssertTrue(CircleVocabulary.approvalRuleConsequence(threshold: 2, admins: 4)
      .contains("2 admins"))
  }

  func testApprovalRuleReadsAsPeopleNotNumbers() {
    XCTAssertEqual(CircleVocabulary.approvalRule(threshold: 2, admins: 3), "2 of 3 admins")
    // An unreadable chain is "Unknown", never a remembered number.
    XCTAssertEqual(CircleVocabulary.approvalRule(threshold: nil, admins: 3), "Unknown")
  }

  // MARK: - roles

  func testSpenderIsOnlyOfferedWhereLimitsActuallyWork() {
    // Offering "can spend" on a deployment with no verified spending contract would be a promise
    // the product cannot keep — the whole point of not faking the feature.
    XCTAssertFalse(CircleVocabulary.Role.invitableRoles(limitsEnabled: false).contains(.spender))
    XCTAssertTrue(CircleVocabulary.Role.invitableRoles(limitsEnabled: true).contains(.spender))
  }

  func testOnlyAdminAuthorityIsMarkedAsNeedingTheCircle() {
    XCTAssertTrue(CircleVocabulary.Role.admin.needsCircleApproval)
    for role in CircleVocabulary.Role.allCases where role != .admin {
      XCTAssertFalse(role.needsCircleApproval, "\(role) should not claim to need Circle approval")
    }
  }

  func testAnAdminAcceptedInPrismButNotYetOnMonadIsNotShownAsActive() {
    // The distinction the whole authority model rests on: accepted is not the same as empowered.
    let accepted = Self.member(status: "ACTIVE", role: "ADMIN", confirmed: false)
    XCTAssertEqual(CircleVocabulary.memberStatus(accepted).text, "Not yet active")

    let empowered = Self.member(status: "ACTIVE", role: "ADMIN", confirmed: true)
    XCTAssertEqual(CircleVocabulary.memberStatus(empowered).text, "Active")
  }

  // MARK: - the activity feed

  func testTheFeedMergesAllThreeSourcesNewestFirst() {
    let feed = CircleActivityItem.feed(
      contributions: [Self.contribution(id: "c1", amount: "100000000", at: "2026-09-10T10:00:00.000Z")],
      payments: [Self.payment(id: "p1", amount: "480000000", at: "2026-09-12T10:00:00.000Z")],
      spends: [Self.spend(id: "s1", amount: "42000000", at: "2026-09-11T10:00:00.000Z")],
      memberName: { _ in "Tobi" })

    XCTAssertEqual(feed.map(\.id), ["payment:p1", "spend:s1", "contribution:c1"])
    // Money in reads positive, money out negative — the sign is the fastest thing to scan.
    XCTAssertTrue(feed[0].signedAmount.hasPrefix("−"))
    XCTAssertTrue(feed[2].signedAmount.hasPrefix("+"))
    XCTAssertTrue(feed[2].incoming)
  }

  func testAnItemWithNoTimestampIsKeptAndSortedLastRatherThanDropped() {
    // A line whose time is unknown is still a line that happened; dropping it would make a shared
    // account's history quietly incomplete, which is worse than showing it out of order.
    let feed = CircleActivityItem.feed(
      contributions: [Self.contribution(id: "c1", amount: "100000000", at: nil)],
      payments: [Self.payment(id: "p1", amount: "480000000", at: "2026-09-12T10:00:00.000Z")],
      spends: [],
      memberName: { _ in "Tobi" })

    XCTAssertEqual(feed.count, 2)
    XCTAssertEqual(feed.last?.id, "contribution:c1")
  }

  func testOnlyAnOpenPaymentIsTappableThroughToItsApproval() {
    let open = CircleActivityItem.feed(
      contributions: [], payments: [Self.payment(id: "p1", amount: "1", at: nil, lifecycle: "APPROVAL_PENDING")],
      spends: [], memberName: { _ in "T" })
    XCTAssertEqual(open[0].proposalId, "p1")

    // A settled payment is a receipt, not an approval — offering to "review" it would be a lie.
    for settled in ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED", "INVALIDATED"] {
      let feed = CircleActivityItem.feed(
        contributions: [], payments: [Self.payment(id: "p1", amount: "1", at: nil, lifecycle: settled)],
        spends: [], memberName: { _ in "T" })
      XCTAssertNil(feed[0].proposalId, "\(settled) should not be tappable through to an approval")
    }
  }

  func testAFeedLineNamesThePersonNotAnIdentifier() {
    let feed = CircleActivityItem.feed(
      contributions: [Self.contribution(id: "c1", amount: "100000000", at: nil)],
      payments: [], spends: [], memberName: { _ in "Tobi" })
    XCTAssertEqual(feed[0].title, "Tobi added")
    assertPlainLanguage(feed[0].title, "feed title")
    assertPlainLanguage(feed[0].status, "feed status")
  }

  // MARK: - the approval inbox decodes both shapes

  func testTheInboxDecodesAPaymentAndAChangeFromTheSameArray() throws {
    // The backend returns both in one `pending` array: a payment view (no `kind`... or `kind:
    // PAYMENT`) and a governance view (a real kind). Decoding one as the other would render a
    // change with a blank amount next to an Approve button.
    let json: [String: Any] = [
      "circleId": "cir_lagos",
      "pending": [
        [
          "proposalId": "prp_pay", "circleId": "cir_lagos", "kind": "PAYMENT",
          "lifecycle": "APPROVAL_PENDING", "amount": "480000000", "asset": "USDC",
          "recipientDisplayName": "Airbnb", "requiredApprovals": 2, "collectedApprovals": 1,
        ],
        [
          "proposalId": "prp_rule", "circleId": "cir_lagos", "kind": "THRESHOLD_CHANGE",
          "status": "PENDING", "memo": "Require 2 of 3 approvals",
          "subject": ["threshold": 2, "ownerCountAfter": 3],
          "requiredApprovals": 2, "collectedApprovals": 0,
        ],
      ],
      "authority": ["threshold": 2, "adminCount": 3, "nonce": 4, "spare": 1],
    ]
    let data = try JSONSerialization.data(withJSONObject: json)
    let response = try JSONDecoder().decode(CirclePendingInboxResponse.self, from: data)

    XCTAssertEqual(response.pending.count, 2)
    XCTAssertNotNil(response.pending[0].payment)
    XCTAssertNil(response.pending[0].governance)
    XCTAssertEqual(response.pending[0].payment?.amount, "480000000")

    XCTAssertNil(response.pending[1].payment)
    XCTAssertEqual(response.pending[1].governance?.kind, "THRESHOLD_CHANGE")
    XCTAssertEqual(response.pending[1].governance?.subject?.threshold, 2)
    // A prepared change reports `status`; an executed one reports `lifecycle`. Both must read.
    XCTAssertEqual(response.pending[1].governance?.state, "PENDING")
  }

  func testAPreparedChangeAndAnExecutedChangeBothReadTheirState() throws {
    let prepared = Self.governance(kind: "OWNER_ADD", memo: nil, status: "PENDING", lifecycle: nil)
    XCTAssertEqual(prepared.state, "PENDING")
    XCTAssertFalse(prepared.isComplete)

    let executed = Self.governance(kind: "OWNER_ADD", memo: nil, status: "EXECUTED", lifecycle: "COMPLETED")
    XCTAssertEqual(executed.state, "COMPLETED")
    XCTAssertTrue(executed.isComplete)
  }

  func testAChangeBuiltAgainstASpentTransactionNumberIsDeadHoweverManyApprovalsItHas() {
    // It can never execute, so the screen must not keep collecting approvals for it.
    let stale = Self.governance(kind: "OWNER_ADD", memo: nil, status: "EXPIRED", lifecycle: "APPROVED", stale: true)
    XCTAssertTrue(stale.isDead)
  }

  func testARemainingStepsNoteIsShownWhenALimitNeedsMoreThanOneApproval() {
    let single = Self.governance(kind: "SPEND_LIMIT_SET", memo: nil, remaining: ["SPEND_LIMIT_SET"])
    XCTAssertEqual(CircleVocabulary.remainingStepsNote(single), "One more approval like this is needed after this one to finish the change.")

    let none = Self.governance(kind: "SPEND_LIMIT_SET", memo: nil, remaining: [])
    XCTAssertNil(CircleVocabulary.remainingStepsNote(none))

    let many = Self.governance(kind: "MODULE_ENABLE", memo: nil, remaining: ["SPEND_DELEGATE_ADD", "SPEND_LIMIT_SET"])
    XCTAssertTrue(CircleVocabulary.remainingStepsNote(many)?.contains("2 more") == true)
  }

  // MARK: - the Circle's own standing

  func testANormalCircleGetsNoBadgeAndAnAbnormalOneAlwaysDoes() {
    XCTAssertNil(CircleVocabulary.circleStatus(Self.circle(status: "ACTIVE")))
    XCTAssertEqual(CircleVocabulary.circleStatus(Self.circle(status: "DEPLOYING"))?.text, "Setting up")
    XCTAssertEqual(CircleVocabulary.circleStatus(Self.circle(status: "CONFIRMING"))?.text, "Setting up")
    XCTAssertEqual(CircleVocabulary.circleStatus(Self.circle(status: "VERIFICATION_FAILED"))?.text, "Setup failed")
    XCTAssertEqual(CircleVocabulary.circleStatus(Self.circle(status: "CLOSED"))?.text, "Closed")
  }

  func testACircleSummaryDecodesWithoutTheFieldsOnlyCreationSends() throws {
    // `GET /v1/circles` omits `requested` and `failureReason`; the creation response includes them.
    // Both have to decode, or the list breaks the first time someone creates a Circle.
    let minimal: [String: Any] = [
      "circleId": "cir_1", "name": "Lagos Trip", "chainId": "10143", "asset": "USDC",
      "status": "ACTIVE", "verifiedOnChain": true,
    ]
    let data = try JSONSerialization.data(withJSONObject: minimal)
    let summary = try JSONDecoder().decode(CircleSummary.self, from: data)
    XCTAssertTrue(summary.isActive)
    XCTAssertFalse(summary.isBeingCreated)
    XCTAssertNil(summary.requested)

    let creating: [String: Any] = [
      "circleId": "cir_2", "name": "Family", "chainId": "10143", "asset": "USDC",
      "status": "DEPLOYING", "verifiedOnChain": false,
      "requested": ["threshold": 2, "adminCount": 3],
      "failureReason": NSNull(),
    ]
    let pending = try JSONDecoder().decode(
      CircleSummary.self, from: try JSONSerialization.data(withJSONObject: creating))
    XCTAssertTrue(pending.isBeingCreated)
    XCTAssertEqual(pending.requested?.threshold, 2)
  }

  // MARK: - fixtures

  private static let allStates: [CircleState] = [
    .noCircles,
    .noMembers,
    .noBalance(circleName: "Lagos Trip"),
    .noPendingApprovals,
    .deploymentPending(status: "DEPLOYING"),
    .deploymentPending(status: "CONFIRMING"),
    .deploymentPending(status: "RECONCILING"),
    .setupFailed(reason: nil),
    .proposalStale,
    .adminRemoved,
    .insufficientFunds(available: "$40.00", needed: "$480.00"),
    .spendingLimitReached(limitLine: nil),
    .networkUnavailable(detail: nil),
    .approvalAlreadyCounted,
    .alreadyExecuted(transactionHash: nil),
    .limitsUnavailable(reason: nil),
  ]

  private static func member(status: String, role: String, confirmed: Bool? = nil) -> CircleMember {
    CircleMember(
      prismId: "prism_1", displayName: "Sarah", handle: "@sarah", role: role, status: status,
      authorityConfirmedOnChain: confirmed, authorityAddress: nil, joinedAt: nil)
  }

  private static func circle(status: String) -> CircleSummary {
    CircleSummary(
      circleId: "cir_1", name: "Lagos Trip", icon: "🌴", safeAddress: nil, chainId: "10143",
      asset: "USDC", status: status, myRole: "ADMIN", myStatus: "ACTIVE", verifiedOnChain: true,
      requested: nil, failureReason: nil)
  }

  private static func contribution(id: String, amount: String, at: String?) -> CircleContribution {
    CircleContribution(
      contributionId: id, circleId: "cir_1", circleName: "Lagos Trip",
      contributorPrismId: "prism_1", amount: amount, asset: "USDC", status: "COMPLETED",
      operationId: "op_1", transactionHash: "0xabc", failureReason: nil, balance: nil,
      createdAt: at, completedAt: at)
  }

  private static func payment(
    id: String, amount: String, at: String?, lifecycle: String = "COMPLETED"
  ) -> CirclePayment {
    CirclePayment(
      proposalId: id, circleId: "cir_1", circleName: "Lagos Trip", lifecycle: lifecycle,
      storedLifecycle: lifecycle, proposerPrismId: "prism_1", recipientPrismId: "prism_2",
      recipientAccount: nil, recipientDisplayName: "Airbnb", recipientHandle: nil,
      amount: amount, asset: "USDC", memo: "Airbnb", safeAddress: nil, chainId: nil, token: nil,
      safeTxHash: nil, safeNonce: nil, safeTransaction: nil, requiredApprovals: 2,
      collectedApprovals: 2, approvals: nil, binding: nil, executionTxHash: "0xdef",
      evidence: nil, failureReason: nil, lastSimulation: nil, balance: nil, trace: nil,
      createdAt: at, executedAt: at, expiresAt: nil, blocked: nil, sufficientBalance: nil)
  }

  private static func spend(id: String, amount: String, at: String?) -> CircleSpend {
    CircleSpend(
      spendId: id, circleId: "cir_1", spenderPrismId: "prism_1", recipientPrismId: nil,
      recipientAccount: nil, recipientDisplayName: "Groceries", recipientHandle: nil,
      amount: amount, amountDisplay: nil, asset: "USDC", memo: "Groceries", route: "ALLOWANCE",
      status: "COMPLETED", transactionHash: "0x123", evidence: nil, failureReason: nil,
      allowanceNonce: 1, limitAtSigning: nil, limitAfter: nil, createdAt: at, completedAt: at)
  }

  private static func governance(
    kind: String, memo: String?, status: String? = "PENDING", lifecycle: String? = nil,
    stale: Bool? = nil, remaining: [String]? = nil
  ) -> CircleGovernanceProposal {
    CircleGovernanceProposal(
      proposalId: "prp_1", circleId: "cir_1", circleName: "Lagos Trip", kind: kind,
      isSpendingLimitChange: nil, lifecycle: lifecycle, storedLifecycle: nil, status: status,
      staleNonce: stale, proposerPrismId: "prism_1", memo: memo,
      subject: CircleProposalSubject(
        prismId: "prism_2", authorityAddress: nil, threshold: 2, ownerCountAfter: 3,
        amount: nil, period: nil, step: nil),
      safeAddress: nil, safeTxHash: nil, safeNonce: nil, safeTransaction: nil,
      requiredApprovals: 2, collectedApprovals: 0, approvals: nil, executionTxHash: nil,
      evidence: nil, failureReason: nil, lastSimulation: nil, blocked: nil,
      createdAt: nil, executedAt: nil, expiresAt: nil, remainingSteps: remaining, complete: nil)
  }
}
