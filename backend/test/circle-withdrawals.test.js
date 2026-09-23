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
// proposeClosePayouts — sequential: one payout at a time from a FROZEN pro-rata plan
// ===========================================================================

test('proposeClosePayouts (admin actor): sequential — proposes the largest target one at a time; the frozen plan prevents over-pay under a shortfall', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const carol = await makeIdentity(s.identityService, { name: 'Carol', handle: 'carol' });
  await addContributor(s, s.circle, s.octane.prismId, carol);
  const { circles, circle, octane, tobi, fake } = s;

  seedContribution(s.store, { id: 'ctr_a', circleId: circle.circleId, contributorPrismId: octane.prismId, amount: 100000000n });
  seedContribution(s.store, { id: 'ctr_b', circleId: circle.circleId, contributorPrismId: tobi.prismId, amount: 50000000n });
  seedContribution(s.store, { id: 'ctr_c', circleId: circle.circleId, contributorPrismId: carol.prismId, amount: 50000000n });
  // Shortfall: 200M owed, only 100M in the Safe -> frozen split is octane 50M, tobi 25M, carol 25M.
  fake.setBalance(circle.safeAddress, 100000000n);

  // Round 1: only the single largest target is proposed (octane 50M); the rest are still owed.
  const r1 = await circles.proposeClosePayouts({ circleId: circle.circleId, actorPrismId: octane.prismId });
  assert.equal(r1.proposal.proposal.recipientPrismId, octane.prismId);
  assert.equal(r1.proposal.proposal.amount, '50000000');
  assert.equal(r1.done, false);
  // Everyone is still owed until their money actually moves (COMPLETED) — including octane, now in flight.
  assert.deepEqual(r1.remaining.map((x) => x.prismId).sort(), [octane.prismId, tobi.prismId, carol.prismId].sort());
  assert.deepEqual(r1.skipped, []);
  const stored1 = s.store.read().circleProposals[r1.proposal.proposal.proposalId];
  assert.equal(stored1.withdrawal.closePayout, true);
  assert.equal(stored1.lifecycle, 'PROPOSED');
  assert.equal(r1.proposal.proposal.collectedApprovals, 0);

  // Dedup: with octane's payout still in flight, another call proposes nothing (waits for it).
  const waiting = await circles.proposeClosePayouts({ circleId: circle.circleId, actorPrismId: octane.prismId });
  assert.equal(waiting.proposal, null);
  assert.equal(waiting.done, false);
  assert.equal(waiting.remaining.length, 3); // nothing paid yet; octane's payout is still in flight

  // Execute octane's payout -> balance drops, octane's frozen target is now met.
  await approve(s, circle.circleId, r1.proposal.proposal, octane);
  await approve(s, circle.circleId, r1.proposal.proposal, tobi);
  const exec1 = await circles.executePayment({ circleId: circle.circleId, proposalId: r1.proposal.proposal.proposalId, actorPrismId: octane.prismId });
  assert.equal(exec1.lifecycle, 'COMPLETED');

  // Round 2: octane is NOT proposed again (frozen target met — no over-pay); the next largest
  // remaining target is proposed instead (tobi or carol, 25M).
  const r2 = await circles.proposeClosePayouts({ circleId: circle.circleId, actorPrismId: octane.prismId });
  assert.notEqual(r2.proposal, null);
  assert.notEqual(r2.proposal.proposal.recipientPrismId, octane.prismId);
  assert.equal(r2.proposal.proposal.amount, '25000000');
  assert.equal(r2.done, false);
  // octane's target is now fully paid, so they are no longer owed; only tobi and carol remain.
  assert.deepEqual(r2.remaining.map((x) => x.prismId).sort(), [tobi.prismId, carol.prismId].sort());
});

test('proposeClosePayouts: a payee with no bound account is surfaced as skipped and keeps the close from reporting done', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const { circles, circle, octane, fake } = s;

  // A contribution from a prismId with no active member record (e.g. a removed member) still counts
  // toward the plan, but there is no account to pay it to.
  seedContribution(s.store, { id: 'ctr_a', circleId: circle.circleId, contributorPrismId: octane.prismId, amount: 50000000n });
  seedContribution(s.store, { id: 'ctr_ghost', circleId: circle.circleId, contributorPrismId: 'ghost', amount: 50000000n });
  fake.setBalance(circle.safeAddress, 100000000n);

  const r = await circles.proposeClosePayouts({ circleId: circle.circleId, actorPrismId: octane.prismId });
  assert.equal(r.proposal.proposal.recipientPrismId, octane.prismId); // the real member is paid
  assert.deepEqual(r.skipped.map((x) => x.prismId), ['ghost']);        // the account-less payee is surfaced
  assert.equal(r.done, false);                                         // residual keeps it from finishing
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

// ===========================================================================
// Fund-return lock: while a close plan is frozen, no other spending
// ===========================================================================

test('while a close plan is frozen, ordinary withdrawals are blocked; clearing the plan unlocks them', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const { circles, circle, octane, fake } = s;

  seedContribution(s.store, { id: 'ctr_a', circleId: circle.circleId, contributorPrismId: octane.prismId, amount: 50000000n });
  fake.setBalance(circle.safeAddress, 50000000n);

  // Freeze the close plan by starting the return-on-close flow.
  await circles.proposeClosePayouts({ circleId: circle.circleId, actorPrismId: octane.prismId });
  assert.ok(s.store.read().circleClosePlans[circle.circleId], 'plan is frozen');

  // A side-channel self-withdrawal can no longer drain the balance out from under the frozen plan.
  await assert.rejects(
    () => circles.proposeWithdrawal({ circleId: circle.circleId, memberPrismId: octane.prismId, amountAtomic: '1000000' }),
    (e) => statusOf(e) === 409
  );

  // Cancelling the close (here via the same clear the lifecycle uses) unlocks ordinary spending again.
  circles._clearClosePlan(circle.circleId);
  const wd = await circles.proposeWithdrawal({ circleId: circle.circleId, memberPrismId: octane.prismId, amountAtomic: '1000000' });
  assert.ok(wd.proposal, 'withdrawal is allowed once the Circle is no longer returning funds');
});

// ===========================================================================
// reconcilePendingFor — a delivered payout stops showing as Pending in Activity
// ===========================================================================

test('reconcilePendingFor settles a delivered-but-still-CONFIRMING withdrawal the viewer received', async (t) => {
  const s = await circleWithMembers();
  t.after(s.restoreProvider);
  const { circles, circle, octane, tobi, fake } = s;

  seedContribution(s.store, { id: 'ctr', circleId: circle.circleId, contributorPrismId: octane.prismId, amount: 100000000n });
  fake.setBalance(circle.safeAddress, 100000000n);

  const { proposal, withdrawalId } = await circles.proposeWithdrawal({
    circleId: circle.circleId, memberPrismId: octane.prismId, amountAtomic: '100000000'
  });
  await approve(s, circle.circleId, proposal, octane);
  await approve(s, circle.circleId, proposal, tobi);
  await circles.executePayment({ circleId: circle.circleId, proposalId: proposal.proposalId, actorPrismId: octane.prismId });

  // Simulate a lost reconcile: the tx settled on-chain, but the record is stuck CONFIRMING and the
  // withdrawal record never reached COMPLETED (exactly the "always pending" bug).
  s.store.mutate((d) => {
    d.circleProposals[proposal.proposalId].lifecycle = 'CONFIRMING';
    d.circleWithdrawals[withdrawalId].status = 'PROPOSED';
  });

  // Opening Activity reconciles the viewer's received payouts from chain truth.
  await circles.reconcilePendingFor(octane.prismId);

  assert.equal(s.store.read().circleProposals[proposal.proposalId].lifecycle, 'COMPLETED');
  assert.equal(s.store.read().circleWithdrawals[withdrawalId].status, 'COMPLETED');
});
