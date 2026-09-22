import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { circleStack, makeIdentity, acknowledgement } from './circles-harness.js';
import { ContributionStatus } from '../src/circles/model.js';

/** Sign and approve a payment (or withdrawal) proposal exactly as `circles-payments.test.js` does. */
const approve = (stack, circleId, payment, admin) =>
  admin.account.sign({ hash: payment.safeTxHash }).then((signature) =>
    stack.circles.approvePayment({ circleId, proposalId: payment.proposalId, prismId: admin.prismId, signature }));

/** 2-admin Circle, modeled on circle-messages.test.js's `circleWithProposal`. */
async function circleWithMembers() {
  const stack = await circleStack({ withPayments: true });
  const octane = await makeIdentity(stack.identityService, { name: 'Octane', handle: 'octane' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const circle = await stack.circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Retreat', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }], threshold: 2,
    policyAcknowledgement: acknowledgement({ threshold: 2, adminCount: 2, warnings: ['NO_SPARE_AUTHORITY'] })
  });
  return { ...stack, circle, octane, tobi };
}

function seedContribution(store, { id, circleId, contributorPrismId, amount }) {
  store.mutate((d) => {
    d.circleContributions ||= {};
    d.circleContributions[id] = {
      contributionId: id, circleId, contributorPrismId, amount: String(amount),
      asset: 'USDC', operationId: `op_${id}`, safeAddress: null,
      balanceBefore: null, balanceAfter: null,
      status: ContributionStatus.COMPLETED,
      createdAt: new Date().toISOString(), completedAt: new Date().toISOString()
    };
  });
}

function statusOf(e) {
  return e?.statusCode;
}

/** Invite `identity` as a CONTRIBUTOR and accept immediately — CONTRIBUTOR is not chain-backed, so
 *  this lands ACTIVE with a real `authorityAddress` in one step, exactly like `circles-members.test.js`. */
async function addContributor(stack, circle, adminPrismId, identity) {
  const invite = stack.circles.invite({
    circleId: circle.circleId, actorPrismId: adminPrismId, prismId: identity.prismId, role: 'CONTRIBUTOR'
  });
  stack.circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: identity.prismId });
  return identity;
}

test('withdrawablePreview reports net contribution capped by the live Safe balance', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);

  seedContribution(s.store, { id: 'ctr_a1', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  seedContribution(s.store, { id: 'ctr_b1', circleId: s.circle.circleId, contributorPrismId: s.tobi.prismId, amount: 60000000n });

  s.circles.safe.getUsdcBalance = async () => 160000000n;

  const preview = await s.circles.withdrawablePreview({ circleId: s.circle.circleId, memberPrismId: s.octane.prismId });
  assert.equal(preview.circleId, s.circle.circleId);
  assert.equal(preview.memberPrismId, s.octane.prismId);
  assert.equal(preview.netContributedAtomic, '100000000');
  assert.equal(preview.balanceAtomic, '160000000');
  assert.equal(preview.withdrawableAtomic, '100000000');

  // Balance drops below net contribution — withdrawable is capped by the chain-truth balance.
  s.circles.safe.getUsdcBalance = async () => 40000000n;
  const capped = await s.circles.withdrawablePreview({ circleId: s.circle.circleId, memberPrismId: s.octane.prismId });
  assert.equal(capped.netContributedAtomic, '100000000');
  assert.equal(capped.balanceAtomic, '40000000');
  assert.equal(capped.withdrawableAtomic, '40000000');
});

test('withdrawablePreview is per-member: the other contributor sees their own net, not the pool', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);

  seedContribution(s.store, { id: 'ctr_a1', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  seedContribution(s.store, { id: 'ctr_b1', circleId: s.circle.circleId, contributorPrismId: s.tobi.prismId, amount: 60000000n });
  s.circles.safe.getUsdcBalance = async () => 160000000n;

  const preview = await s.circles.withdrawablePreview({ circleId: s.circle.circleId, memberPrismId: s.tobi.prismId });
  assert.equal(preview.netContributedAtomic, '60000000');
  assert.equal(preview.withdrawableAtomic, '60000000');
});

test('a non-member is rejected', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const stranger = await makeIdentity(s.identityService, { name: 'Stranger', handle: 'stranger' });
  s.circles.safe.getUsdcBalance = async () => 160000000n;

  await assert.rejects(
    () => s.circles.withdrawablePreview({ circleId: s.circle.circleId, memberPrismId: stranger.prismId }),
    (e) => statusOf(e) === 403 || statusOf(e) === 404
  );
});

test('a live balance read failure is treated as zero, never thrown', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  seedContribution(s.store, { id: 'ctr_a1', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  s.circles.safe.getUsdcBalance = async () => { throw new Error('rpc unavailable'); };

  const preview = await s.circles.withdrawablePreview({ circleId: s.circle.circleId, memberPrismId: s.octane.prismId });
  assert.equal(preview.balanceAtomic, '0');
  assert.equal(preview.withdrawableAtomic, '0');
});

// ===========================================================================
// proposeWithdrawal — capped payment to the member's own account
// ===========================================================================

test('proposeWithdrawal: HOSTILE — a member cannot propose more than their withdrawable', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);

  seedContribution(s.store, { id: 'ctr_a1', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  s.circles.safe.getUsdcBalance = async () => 100000000n;

  await assert.rejects(
    () => s.circles.proposeWithdrawal({ circleId: s.circle.circleId, memberPrismId: s.octane.prismId, amountAtomic: '100000001' }),
    (e) => statusOf(e) === 409
  );
});

test('proposeWithdrawal: at exactly the withdrawable amount, creates a PAYMENT proposal to the member\'s own account and a PROPOSED withdrawal record', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);

  seedContribution(s.store, { id: 'ctr_a1', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  s.circles.safe.getUsdcBalance = async () => 100000000n;

  const { proposal, withdrawalId } = await s.circles.proposeWithdrawal({
    circleId: s.circle.circleId, memberPrismId: s.octane.prismId, amountAtomic: '100000000'
  });

  assert.equal(proposal.kind, 'PAYMENT');
  assert.equal(proposal.amount, '100000000');
  assert.equal(getAddress(proposal.recipientAccount), getAddress(s.octane.accountAddress));

  // The persisted proposal record carries the same recipient inside `payment`, plus the withdrawal
  // tag that a later confirmation hook needs to recognize it as a withdrawal rather than a payment.
  const stored = s.store.read().circleProposals[proposal.proposalId];
  assert.equal(getAddress(stored.payment.recipientAccount), getAddress(s.octane.accountAddress));
  assert.equal(stored.payment.recipientPrismId, s.octane.prismId);
  assert.deepEqual(stored.withdrawal, { beneficiaryPrismId: s.octane.prismId });

  // A PROPOSED withdrawal record links back to this exact proposal.
  assert.ok(withdrawalId);
  const record = s.store.read().circleWithdrawals[withdrawalId];
  assert.ok(record, 'a circleWithdrawals record was written');
  assert.equal(record.status, 'PROPOSED');
  assert.equal(record.proposalId, proposal.proposalId);
  assert.equal(record.circleId, s.circle.circleId);
  assert.equal(record.beneficiaryPrismId, s.octane.prismId);
  assert.equal(getAddress(record.beneficiaryAccount), getAddress(s.octane.accountAddress));
  assert.equal(record.amount, '100000000');

  // Never auto-approved or auto-executed — it is recorded as PROPOSED and starts life needing the
  // Circle's normal threshold of signatures (nothing has approved it yet).
  assert.equal(stored.lifecycle, 'PROPOSED');
  assert.equal(proposal.storedLifecycle, 'PROPOSED');
  assert.equal(proposal.collectedApprovals, 0);
  assert.equal(proposal.executionTxHash, null);
});

// ===========================================================================
// Withdrawal confirmation — the ledger effect only lands once the chain confirms
// ===========================================================================

test('a confirmed withdrawal payment marks the CircleWithdrawal COMPLETED and drops the member\'s withdrawable to 0', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const { circles, circle, octane, tobi, fake } = s;

  seedContribution(s.store, { id: 'ctr_a1', circleId: circle.circleId, contributorPrismId: octane.prismId, amount: 100000000n });
  // Fund the Safe for real on the fake chain — `executePayment` broadcasts a real USDC transfer,
  // so the on-chain balance (not just the mocked preview) must actually hold the money.
  fake.setBalance(circle.safeAddress, 100000000n);

  const { proposal, withdrawalId } = await circles.proposeWithdrawal({
    circleId: circle.circleId, memberPrismId: octane.prismId, amountAtomic: '100000000'
  });

  await approve(s, circle.circleId, proposal, octane);
  await approve(s, circle.circleId, proposal, tobi);

  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: proposal.proposalId, actorPrismId: octane.prismId });
  assert.equal(done.lifecycle, 'COMPLETED');

  // The withdrawal record is COMPLETED, carrying the confirmed transaction hash — the real ledger
  // effect, not something asserted just because the proposal said so.
  const record = s.store.read().circleWithdrawals[withdrawalId];
  assert.equal(record.status, 'COMPLETED');
  assert.ok(record.transactionHash, 'a transaction hash was recorded');
  assert.equal(record.transactionHash, done.evidence.transactionHash);

  // A fresh preview reflects the completed withdrawal: net contribution minus the completed
  // withdrawal leaves nothing to take out.
  const preview = await circles.withdrawablePreview({ circleId: circle.circleId, memberPrismId: octane.prismId });
  assert.equal(preview.withdrawableAtomic, '0');

  // A second withdrawal of any positive amount is rejected — the cap is re-derived from the ledger,
  // not cached from before this one confirmed.
  await assert.rejects(
    () => circles.proposeWithdrawal({ circleId: circle.circleId, memberPrismId: octane.prismId, amountAtomic: '1' }),
    (e) => statusOf(e) === 409
  );
});

test('execute-time cap re-check: a withdrawal that confirmed in between propose and execute blocks this one', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const { circles, circle, octane, tobi, fake } = s;

  seedContribution(s.store, { id: 'ctr_a1', circleId: circle.circleId, contributorPrismId: octane.prismId, amount: 100000000n });
  fake.setBalance(circle.safeAddress, 100000000n);

  const { proposal, withdrawalId } = await circles.proposeWithdrawal({
    circleId: circle.circleId, memberPrismId: octane.prismId, amountAtomic: '100000000'
  });
  await approve(s, circle.circleId, proposal, octane);
  await approve(s, circle.circleId, proposal, tobi);

  // The proposal is now fully approved, on its original (still-current) Safe nonce — nothing about
  // it looks stale. But another withdrawal for the same member has, in this moment, confirmed
  // elsewhere and already consumed the entire net contribution. A Safe's nonce ordering cannot
  // itself catch this (both withdrawals were proposed against the same nonce before either executed,
  // which is exactly how two honestly-raced withdrawals would look on-chain); only re-deriving the
  // cap from the ledger at execute time can. This seeds that outcome directly — the repo's
  // established idiom for exercising a defensive check against ledger state a single synchronous
  // test cannot otherwise race into being (see circles-payments.test.js's "hand-marked COMPLETED"
  // test for the same idiom).
  s.store.mutate((d) => {
    d.circleWithdrawals['wd_other'] = {
      withdrawalId: 'wd_other', circleId: circle.circleId, beneficiaryPrismId: octane.prismId,
      beneficiaryAccount: octane.accountAddress, amount: '100000000', proposalId: 'prp_other',
      status: 'COMPLETED', transactionHash: `0x${'11'.repeat(32)}`,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
  });

  // Even though every existing check (binding, continuity, approvals, nonce, simulation) would
  // pass, executing this proposal must fail: the ledger it would draw from has already been spent.
  await assert.rejects(
    () => circles.executePayment({ circleId: circle.circleId, proposalId: proposal.proposalId, actorPrismId: octane.prismId }),
    (e) => statusOf(e) === 409
  );

  // Nothing was broadcast, and this withdrawal's own record is untouched.
  assert.equal(fake.calls.executions.length, 0, 'the payment was never sent');
  const record = s.store.read().circleWithdrawals[withdrawalId];
  assert.notEqual(record.status, 'COMPLETED');
});

// ===========================================================================
// planClosePayouts — pro-rata preview, writes nothing
// ===========================================================================

test('planClosePayouts previews a pro-rata split of the live balance, summing exactly to it', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const carol = await makeIdentity(s.identityService, { name: 'Carol', handle: 'carol' });
  await addContributor(s, s.circle, s.octane.prismId, carol);

  seedContribution(s.store, { id: 'ctr_a', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  seedContribution(s.store, { id: 'ctr_b', circleId: s.circle.circleId, contributorPrismId: s.tobi.prismId, amount: 50000000n });
  seedContribution(s.store, { id: 'ctr_c', circleId: s.circle.circleId, contributorPrismId: carol.prismId, amount: 50000000n });

  s.circles.safe.getUsdcBalance = async () => 100000000n;
  const plan = await s.circles.planClosePayouts({ circleId: s.circle.circleId });

  assert.equal(plan.balanceAtomic, '100000000');
  const byId = Object.fromEntries(plan.payouts.map((p) => [p.prismId, p]));
  assert.equal(byId[s.octane.prismId].amountAtomic, '50000000');
  assert.equal(byId[s.tobi.prismId].amountAtomic, '25000000');
  assert.equal(byId[carol.prismId].amountAtomic, '25000000');
  assert.equal(getAddress(byId[s.octane.prismId].account), getAddress(s.octane.accountAddress));
  const total = plan.payouts.reduce((sum, p) => sum + BigInt(p.amountAtomic), 0n);
  assert.equal(total, 100000000n);

  // Writes nothing: no proposal, no withdrawal record.
  assert.deepEqual(s.store.read().circleProposals ?? {}, {});
  assert.deepEqual(s.store.read().circleWithdrawals ?? {}, {});
});

test('planClosePayouts under a shortfall still sums exactly to the smaller live balance', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const carol = await makeIdentity(s.identityService, { name: 'Carol', handle: 'carol' });
  await addContributor(s, s.circle, s.octane.prismId, carol);

  seedContribution(s.store, { id: 'ctr_a', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  seedContribution(s.store, { id: 'ctr_b', circleId: s.circle.circleId, contributorPrismId: s.tobi.prismId, amount: 50000000n });
  seedContribution(s.store, { id: 'ctr_c', circleId: s.circle.circleId, contributorPrismId: carol.prismId, amount: 50000000n });

  s.circles.safe.getUsdcBalance = async () => 80000000n;
  const plan = await s.circles.planClosePayouts({ circleId: s.circle.circleId });

  assert.equal(plan.balanceAtomic, '80000000');
  const byId = Object.fromEntries(plan.payouts.map((p) => [p.prismId, p]));
  assert.equal(byId[s.octane.prismId].amountAtomic, '40000000');
  assert.equal(byId[s.tobi.prismId].amountAtomic, '20000000');
  assert.equal(byId[carol.prismId].amountAtomic, '20000000');
  const total = plan.payouts.reduce((sum, p) => sum + BigInt(p.amountAtomic), 0n);
  assert.equal(total, 80000000n);
});

test('planClosePayouts excludes a member with zero net contribution', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const carol = await makeIdentity(s.identityService, { name: 'Carol', handle: 'carol' });
  await addContributor(s, s.circle, s.octane.prismId, carol); // never contributes

  seedContribution(s.store, { id: 'ctr_a', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  seedContribution(s.store, { id: 'ctr_b', circleId: s.circle.circleId, contributorPrismId: s.tobi.prismId, amount: 50000000n });

  s.circles.safe.getUsdcBalance = async () => 100000000n;
  const plan = await s.circles.planClosePayouts({ circleId: s.circle.circleId });

  const prismIds = plan.payouts.map((p) => p.prismId);
  assert.ok(!prismIds.includes(carol.prismId), 'a zero-net member is omitted from the payout list');
  assert.equal(prismIds.length, 2);
});

// ===========================================================================
// proposeClosePayouts — one withdrawal-tagged PAYMENT proposal per positive payout
// ===========================================================================

test('proposeClosePayouts (admin actor): one PAYMENT proposal per member with the correct pro-rata amounts', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const carol = await makeIdentity(s.identityService, { name: 'Carol', handle: 'carol' });
  await addContributor(s, s.circle, s.octane.prismId, carol);

  seedContribution(s.store, { id: 'ctr_a', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  seedContribution(s.store, { id: 'ctr_b', circleId: s.circle.circleId, contributorPrismId: s.tobi.prismId, amount: 50000000n });
  seedContribution(s.store, { id: 'ctr_c', circleId: s.circle.circleId, contributorPrismId: carol.prismId, amount: 50000000n });
  s.circles.safe.getUsdcBalance = async () => 100000000n;

  const { proposals } = await s.circles.proposeClosePayouts({ circleId: s.circle.circleId, actorPrismId: s.octane.prismId });

  assert.equal(proposals.length, 3);
  const byRecipient = Object.fromEntries(proposals.map((p) => [p.proposal.recipientPrismId, p]));
  assert.equal(byRecipient[s.octane.prismId].proposal.amount, '50000000');
  assert.equal(byRecipient[s.tobi.prismId].proposal.amount, '25000000');
  assert.equal(byRecipient[carol.prismId].proposal.amount, '25000000');

  for (const { proposal, withdrawalId } of proposals) {
    assert.equal(proposal.kind, 'PAYMENT');
    const stored = s.store.read().circleProposals[proposal.proposalId];
    assert.deepEqual(stored.withdrawal, { beneficiaryPrismId: proposal.recipientPrismId });

    // Never auto-approved or auto-executed.
    assert.equal(stored.lifecycle, 'PROPOSED');
    assert.equal(proposal.collectedApprovals, 0);
    assert.equal(proposal.executionTxHash, null);

    const record = s.store.read().circleWithdrawals[withdrawalId];
    assert.equal(record.status, 'PROPOSED');
    assert.equal(record.beneficiaryPrismId, proposal.recipientPrismId);
  }
});

test('proposeClosePayouts: a non-admin actor is rejected', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const carol = await makeIdentity(s.identityService, { name: 'Carol', handle: 'carol' });
  await addContributor(s, s.circle, s.octane.prismId, carol);

  seedContribution(s.store, { id: 'ctr_a', circleId: s.circle.circleId, contributorPrismId: s.octane.prismId, amount: 100000000n });
  seedContribution(s.store, { id: 'ctr_c', circleId: s.circle.circleId, contributorPrismId: carol.prismId, amount: 50000000n });
  s.circles.safe.getUsdcBalance = async () => 100000000n;

  await assert.rejects(
    () => s.circles.proposeClosePayouts({ circleId: s.circle.circleId, actorPrismId: carol.prismId }),
    (e) => statusOf(e) === 403
  );

  // Nothing was created.
  assert.deepEqual(s.store.read().circleProposals ?? {}, {});
});
