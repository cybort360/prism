import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The domain model on its own: the rules that hold before any chain, store or request exists.
 *
 * This suite is where the canonical source map stops being prose. If someone later adds a cached
 * balance or a Prism-owned threshold, the assertions here are what should stop them.
 */

const model = await import('../src/circles/model.js');
const templates = await import('../src/circles/templates.js');

const {
  CANONICAL_SOURCES, NEVER_FABRICATED, CircleStatus, CREATION_FLOW, MemberRole, MemberStatus,
  ProposalKind, SignatureType, canCircleTransition, assertCircleTransition,
  assertThresholdWithinOwners, thresholdWarnings, spareApprovals, newCircle, newCircleMember,
  newCircleProposal, newCircleApproval, newCircleContribution, CIRCLE_ASSET
} = model;

test('canonical sources: money and authority belong to the chain, names belong to Prism', () => {
  assert.equal(CANONICAL_SOURCES['circle.balance'], 'chain');
  assert.equal(CANONICAL_SOURCES['circle.owners'], 'chain');
  assert.equal(CANONICAL_SOURCES['circle.threshold'], 'chain');
  assert.equal(CANONICAL_SOURCES['circle.adminAuthority'], 'chain');
  assert.equal(CANONICAL_SOURCES['circle.executedPayment'], 'chain');
  assert.equal(CANONICAL_SOURCES['circle.name'], 'prism');
  assert.equal(CANONICAL_SOURCES['circle.icon'], 'prism');
  assert.equal(CANONICAL_SOURCES['circle.recipientIdentity'], 'resolver');
  assert.equal(CANONICAL_SOURCES['circle.collectedApprovals'], 'signature');
  assert.equal(CANONICAL_SOURCES['circle.memberAllowance'], 'module');
  assert.deepEqual([...NEVER_FABRICATED], ['balance', 'owner', 'threshold', 'allowance', 'successfulPayment']);
});

test('a new Circle carries no authority until the chain supplies it', () => {
  const circle = newCircle({
    circleId: 'cir_1', name: 'Trip', icon: null, chainId: 10143, createdByPrismId: 'p1',
    template: 'TRIP', requestedThreshold: 2, requestedAdmins: [{ prismId: 'p1', authorityAddress: '0x1111111111111111111111111111111111111111' }],
    saltNonce: '7', predictedSafeAddress: '0x2222222222222222222222222222222222222222'
  });

  assert.equal(circle.status, CircleStatus.CREATED);
  assert.equal(circle.threshold, null, 'threshold is chain-owned and starts unknown');
  assert.equal(circle.adminCount, null, 'admin count is chain-owned and starts unknown');
  assert.equal(circle.activation, null, 'no verification receipt exists yet');
  assert.equal(circle.activatedAt, null);
  assert.equal(circle.asset, CIRCLE_ASSET);
  // The requested threshold is kept, but clearly as an intent rather than a fact.
  assert.equal(circle.creation.requestedThreshold, 2);
  // And there is nowhere to put a balance at all.
  assert.ok(!('balance' in circle), 'a Circle record has no balance field to fabricate');
});

test('the creation flow has exactly one route to ACTIVE, and it runs through verification', () => {
  assert.deepEqual([...CREATION_FLOW], [
    'CREATED', 'MEMBERS_SELECTED', 'POLICY_REVIEWED', 'AWAITING_AUTHORIZATION',
    'DEPLOYING', 'CONFIRMING', 'RECONCILING', 'ACTIVE'
  ]);

  // Only RECONCILING may become ACTIVE.
  for (const from of Object.values(CircleStatus)) {
    if (from === CircleStatus.ACTIVE || from === CircleStatus.RECONCILING) continue;
    assert.ok(!canCircleTransition(from, CircleStatus.ACTIVE), `${from} must not reach ACTIVE directly`);
  }
  assert.ok(canCircleTransition(CircleStatus.RECONCILING, CircleStatus.ACTIVE));

  // The tempting shortcuts are all closed.
  assert.throws(() => assertCircleTransition(CircleStatus.CREATED, CircleStatus.ACTIVE), /illegal circle transition/);
  assert.throws(() => assertCircleTransition(CircleStatus.DEPLOYING, CircleStatus.ACTIVE), /illegal circle transition/);
  assert.throws(() => assertCircleTransition(CircleStatus.CONFIRMING, CircleStatus.ACTIVE), /illegal circle transition/);
  assert.throws(() => assertCircleTransition(CircleStatus.CLOSED, CircleStatus.ACTIVE), /illegal circle transition/);
  // Re-entering the same state is always allowed, so retries are safe.
  assert.ok(canCircleTransition(CircleStatus.CONFIRMING, CircleStatus.CONFIRMING));
});

test('threshold arithmetic: zero is refused, and more approvals than admins is refused', () => {
  assert.ok(assertThresholdWithinOwners({ threshold: 2, ownerCount: 3 }));
  assert.throws(() => assertThresholdWithinOwners({ threshold: 0, ownerCount: 3 }), /at least 1/);
  assert.throws(() => assertThresholdWithinOwners({ threshold: -1, ownerCount: 3 }), /at least 1/);
  assert.throws(() => assertThresholdWithinOwners({ threshold: 1.5, ownerCount: 3 }), /whole number/);
  assert.throws(() => assertThresholdWithinOwners({ threshold: 4, ownerCount: 3 }), /exceeds the 3 admins/);
  assert.throws(() => assertThresholdWithinOwners({ threshold: 1, ownerCount: 0 }), /at least one admin/);
});

test('spare approvals: the number that decides whether one lost phone freezes the Circle', () => {
  assert.equal(spareApprovals({ threshold: 2, ownerCount: 3 }), 1);
  assert.equal(spareApprovals({ threshold: 2, ownerCount: 2 }), 0);
  assert.equal(spareApprovals({ threshold: 3, ownerCount: 5 }), 2);
});

test('a two-person Circle is honest about both choices, and calls neither safe', () => {
  const oneOfTwo = thresholdWarnings({ threshold: 1, ownerCount: 2 });
  assert.equal(oneOfTwo.length, 1);
  assert.equal(oneOfTwo[0].code, 'ANY_ADMIN_ALONE');
  assert.equal(oneOfTwo[0].title, '1 of 2');
  assert.equal(oneOfTwo[0].detail, 'Either admin can move money alone.');

  const twoOfTwo = thresholdWarnings({ threshold: 2, ownerCount: 2 });
  assert.equal(twoOfTwo.length, 1);
  assert.equal(twoOfTwo[0].code, 'NO_SPARE_AUTHORITY');
  assert.equal(twoOfTwo[0].title, '2 of 2');
  assert.equal(twoOfTwo[0].detail, 'Both admins are required. Losing access to either authority can block spending.');

  // Every two-person threshold carries a warning: there is no unwarned option to default to.
  for (const threshold of [1, 2]) assert.ok(thresholdWarnings({ threshold, ownerCount: 2 }).length > 0);
  // A 2-of-3 Circle needs no warning — it has a spare and no single admin acts alone.
  assert.deepEqual(thresholdWarnings({ threshold: 2, ownerCount: 3 }), []);
});

test('templates recommend a threshold for the admins chosen, and never invent an admin', () => {
  // The documented shapes, when the admins exist for them.
  assert.equal(templates.recommendThreshold('FAMILY', 3), 2);
  assert.equal(templates.recommendThreshold('TRIP', 3), 2);
  assert.equal(templates.recommendThreshold('COMMUNITY', 5), 3);
  // CUSTOM makes no recommendation at all.
  assert.equal(templates.recommendThreshold('CUSTOM', 4), null);

  // With fewer admins than the template was designed for, it degrades rather than demanding people.
  assert.equal(templates.recommendThreshold('COMMUNITY', 3), 2);
  assert.equal(templates.recommendThreshold('COMMUNITY', 4), 2);

  // Never more approvals than admins, for any template at any size.
  for (const template of ['FAMILY', 'TRIP', 'COMMUNITY']) {
    for (let admins = 1; admins <= 8; admins++) {
      const recommended = templates.recommendThreshold(template, admins);
      assert.ok(recommended >= 1 && recommended <= admins, `${template}/${admins} recommended ${recommended}`);
    }
  }
  assert.throws(() => templates.recommendThreshold('FAMILY', 0), /at least one admin/);
  assert.throws(() => templates.recommendThreshold('NONSENSE', 3), /unknown circle template/);
});

test('template options offer only thresholds that are actually valid, each with its consequence', () => {
  const options = templates.templateOptions('FAMILY', 3);
  assert.deepEqual(options.choices.map((c) => c.threshold), [1, 2, 3]);
  assert.equal(options.choices.filter((c) => c.recommended).length, 1);
  assert.equal(options.choices.find((c) => c.recommended).threshold, 2);
  assert.equal(options.twoPersonTradeoff, null);

  const two = templates.templateOptions('CUSTOM', 2);
  assert.ok(two.twoPersonTradeoff, 'a two-person Circle states both consequences');
  assert.equal(two.twoPersonTradeoff.oneOfTwo[0].code, 'ANY_ADMIN_ALONE');
  assert.equal(two.twoPersonTradeoff.twoOfTwo[0].code, 'NO_SPARE_AUTHORITY');
  // CUSTOM recommends nothing, by design: the creator was told they choose, so Prism does not then
  // put its thumb on the scale.
  assert.equal(two.recommendedThreshold, null);
  assert.equal(two.choices.filter((c) => c.recommended).length, 0);

  // A template that does recommend still warns about whichever two-person shape it lands on.
  const familyOfTwo = templates.templateOptions('FAMILY', 2);
  assert.equal(familyOfTwo.recommendedThreshold, 1);
  assert.ok(familyOfTwo.choices.find((c) => c.recommended).warnings.some((w) => w.code === 'ANY_ADMIN_ALONE'));

  assert.throws(() => templates.assertTemplateChoice({ template: 'TRIP', threshold: 4, adminCount: 3 }), /exceeds the 3 admins/);
});

test('an admin invited in Prism is not an admin on Monad', () => {
  const member = newCircleMember({
    circleId: 'cir_1', prismId: 'p2', authorityAddress: '0x1111111111111111111111111111111111111111',
    displayName: 'Tobi', handle: '@tobi', role: MemberRole.ADMIN, status: MemberStatus.PENDING_ACTIVATION
  });
  assert.equal(member.status, MemberStatus.PENDING_ACTIVATION);
  assert.equal(member.joinedAt, null, 'nobody has joined until the chain says so');
  assert.deepEqual([...model.CHAIN_BACKED_ROLES], [MemberRole.ADMIN]);
  assert.deepEqual([...model.TERMINAL_MEMBER_STATUSES], [MemberStatus.LEFT, MemberStatus.REMOVED]);
  assert.throws(() => newCircleMember({ circleId: 'c', prismId: 'p', role: 'SUPERUSER', status: MemberStatus.ACTIVE }), /unknown circle role/);
});

test('a proposal starts with zero approvals and is identified by its Safe digest', () => {
  const proposal = newCircleProposal({
    proposalId: 'prp_1', circleId: 'cir_1', kind: ProposalKind.PAYMENT, proposerPrismId: 'p1',
    recipientPrismId: 'p9', recipientAccount: '0x1111111111111111111111111111111111111111',
    amount: '20000000', asset: 'USDC', memo: 'dinner',
    safeTxHash: `0x${'ab'.repeat(32)}`, safeNonce: '3', requiredApprovals: 2
  });
  assert.equal(proposal.collectedApprovals, 0);
  assert.equal(proposal.status, 'PENDING');
  assert.equal(proposal.executedAt, null);
  assert.throws(() => newCircleProposal({ proposalId: 'x', circleId: 'c', kind: 'SEIZE_FUNDS', proposerPrismId: 'p', requiredApprovals: 1 }), /unknown proposal kind/);
});

test('an approval records how the signature was made, because the four kinds differ in trust', () => {
  const approval = newCircleApproval({
    proposalId: 'prp_1', prismId: 'p1', authorityAddress: '0x1111111111111111111111111111111111111111',
    signatureType: SignatureType.ECDSA, signature: `0x${'11'.repeat(65)}`
  });
  assert.equal(approval.signatureType, 'ECDSA');
  assert.ok(approval.approvedAt);
  assert.deepEqual(Object.values(SignatureType), ['ECDSA', 'ETH_SIGN', 'CONTRACT_SIGNATURE', 'APPROVED_HASH']);
  assert.throws(() => newCircleApproval({ proposalId: 'p', prismId: 'p', authorityAddress: '0x1', signatureType: 'VIBES' }), /unknown signature type/);
});

test('a contribution rides the existing payment lifecycle rather than a second ledger', () => {
  const contribution = newCircleContribution({
    contributionId: 'con_1', circleId: 'cir_1', contributorPrismId: 'p1',
    amount: '50000000', operationId: 'op_123'
  });
  assert.equal(contribution.operationId, 'op_123', 'money in is an ordinary Prism operation');
  assert.equal(contribution.asset, CIRCLE_ASSET);
  assert.equal(contribution.status, 'PREPARED');
  assert.equal(contribution.transactionHash, null, 'no hash until the chain provides one');
});
