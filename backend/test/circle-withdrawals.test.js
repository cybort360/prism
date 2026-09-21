import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { circleStack, makeIdentity, acknowledgement } from './circles-harness.js';
import { ContributionStatus } from '../src/circles/model.js';

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
