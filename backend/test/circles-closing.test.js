import test from 'node:test';
import assert from 'node:assert/strict';
import { circleStack, makeIdentity, acknowledgement, contribute, resolveRecipient } from './circles-harness.js';
import { CircleActivityService } from '../src/services/circleActivityService.js';

/**
 * Closing a Circle.
 *
 * Closing is a lifecycle, not a delete: ACTIVE → CLOSING → CLOSED, with every record kept. The
 * property this suite exists to protect is the refusal at the centre of it — **Prism will not decide
 * where a shared balance goes.** A Circle holding money cannot be closed at all. It can only be
 * emptied first, by the same threshold-approved payments it has always used, to recipients its
 * members choose. There is no equal split, no automatic return to contributors, and no default.
 *
 * The other closure requirements are the ones that would otherwise leave something behind: an
 * unresolved decision Prism still holds, or a member who can still spend from the Safe.
 */

const USD = (dollars) => String(BigInt(Math.round(dollars * 100)) * 10_000n);

async function lagosTrip({ threshold = 2, contribution = USD(500) } = {}) {
  const stack = await circleStack({ withPayments: true });
  const octane = await makeIdentity(stack.identityService, { name: 'Octane', handle: 'octane' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const circle = await stack.circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }], threshold,
    policyAcknowledgement: acknowledgement({ threshold, adminCount: 2, warnings: threshold === 2 ? ['NO_SPARE_AUTHORITY'] : ['ANY_ADMIN_ALONE'] })
  });
  stack.fake.setBalance(octane.accountAddress, USD(2000));
  if (contribution !== '0') {
    await contribute({ circles: stack.circles, circleId: circle.circleId, member: octane, amountAtomic: contribution });
  }
  return { ...stack, circle, octane, tobi, admins: [octane, tobi] };
}

/** Send everything the Circle holds to one person the members chose. */
async function emptyInto(stack, recipient) {
  const balance = stack.fake.balanceOf(stack.circle.safeAddress).toString();
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: stack.octane.prismId, target: recipient });
  const payment = await stack.circles.proposePayment({
    circleId: stack.circle.circleId, actorPrismId: stack.octane.prismId, resolution,
    amountAtomic: balance, memo: 'Closing the Circle'
  });
  for (const admin of stack.admins) {
    const signature = await admin.account.sign({ hash: payment.safeTxHash });
    await stack.circles.approvePayment({ circleId: stack.circle.circleId, proposalId: payment.proposalId, prismId: admin.prismId, signature });
  }
  return stack.circles.executePayment({ circleId: stack.circle.circleId, proposalId: payment.proposalId, actorPrismId: stack.octane.prismId });
}

const closeWith = (stack, preflight) =>
  stack.circles.finalizeClose({
    circleId: stack.circle.circleId, actorPrismId: stack.octane.prismId,
    acknowledgement: { balanceAtomic: preflight.balance.amountAtomic }
  });

// ===========================================================================

test('a Circle holding money cannot be closed, and Prism does not decide where the money goes', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane } = stack;

  const preflight = await circles.closePreflight(circle.circleId, octane.prismId);
  assert.equal(preflight.canClose, false);
  const funds = preflight.blockers.find((b) => b.code === 'REMAINING_FUNDS');
  assert.ok(funds, 'money left in the Circle blocks closing');
  assert.equal(funds.balanceAtomic, USD(500));
  assert.equal(funds.balanceDisplay, '$500.00');
  assert.equal(funds.requiresExplicitDecision, true);
  // The refusal names the decision as the members' own, and offers no automatic distribution.
  assert.match(funds.detail, /Decide together where this money goes/);
  assert.match(funds.detail, /will not split it or return it automatically/);

  await circles.beginClose({ circleId: circle.circleId, actorPrismId: octane.prismId, reason: 'trip over' });
  await assert.rejects(
    () => closeWith(stack, preflight),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /cannot be closed yet/);
      assert.ok(error.blockers.some((b) => b.code === 'REMAINING_FUNDS'));
      return true;
    }
  );
  assert.equal(circles.getCircleRecord(circle.circleId).status, 'CLOSING');
});

test('closing: the money leaves by a decision the Circle made, and then the Circle can close', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, fake } = stack;
  const kemi = await makeIdentity(stack.identityService, { name: 'Kemi', handle: 'kemi' });

  await circles.beginClose({ circleId: circle.circleId, actorPrismId: octane.prismId, reason: 'trip over' });
  assert.equal(circles.getCircleRecord(circle.circleId).status, 'CLOSING');

  // Money can still leave a Circle that is closing — that is how the balance is settled — and the
  // decision is an ordinary threshold-approved payment to someone the members named.
  const payout = await emptyInto(stack, kemi);
  assert.equal(payout.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), '0');
  assert.equal(fake.balanceOf(kemi.accountAddress).toString(), USD(500));

  // But money can no longer come in.
  await assert.rejects(
    () => circles.prepareContribution({ circleId: circle.circleId, prismId: octane.prismId, amountAtomic: USD(10) }),
    /being closed/
  );

  const preflight = await circles.closePreflight(circle.circleId, octane.prismId);
  assert.equal(preflight.canClose, true);
  assert.deepEqual(preflight.blockers, []);
  assert.deepEqual(preflight.requirements, ['OPEN_PROPOSALS', 'SPENDING_ACCESS', 'REMAINING_FUNDS', 'CHAIN_RECONCILED']);
  assert.ok(preflight.checks.every((c) => c.ok), 'every requirement was checked and holds');

  const closed = await closeWith(stack, preflight);
  assert.equal(closed.status, 'CLOSED');

  // The closure kept evidence of what the Circle was at the moment it ended.
  const record = circles.getCircleRecord(circle.circleId);
  assert.equal(record.status, 'CLOSED');
  assert.ok(record.closedAt);
  const evidence = record.closing.evidence;
  assert.equal(evidence.balanceAtomic, '0');
  assert.equal(evidence.balanceSource, 'chain');
  assert.equal(evidence.threshold, fake.safeAt(circle.safeAddress).threshold);
  assert.equal(evidence.owners.length, fake.safeAt(circle.safeAddress).owners.length);
  assert.equal(evidence.spendDelegates.length, 0);
  // Where the money went is taken from the Circle's own completed payments, not from anything typed.
  assert.equal(evidence.withdrawals.length, 1);
  assert.equal(evidence.withdrawals[0].amount, USD(500));
  assert.equal(evidence.withdrawals[0].recipientPrismId, kemi.prismId);
  assert.equal(evidence.withdrawals[0].transactionHash, payout.executionTxHash);
});

test('finalizing refuses an acknowledgement that does not match what the chain says right now', async (t) => {
  const stack = await lagosTrip({ contribution: '0' });
  t.after(stack.restoreProvider);
  const { circles, circle, octane } = stack;
  await circles.beginClose({ circleId: circle.circleId, actorPrismId: octane.prismId });

  await assert.rejects(
    () => circles.finalizeClose({ circleId: circle.circleId, actorPrismId: octane.prismId, acknowledgement: { balanceAtomic: USD(9) } }),
    /confirm the balance you were shown/
  );
  await assert.rejects(
    () => circles.finalizeClose({ circleId: circle.circleId, actorPrismId: octane.prismId, acknowledgement: null }),
    /confirm the balance you were shown/
  );
  assert.equal(circles.getCircleRecord(circle.circleId).status, 'CLOSING');
});

test('an unresolved decision blocks closing until it is approved or cancelled', async (t) => {
  const stack = await lagosTrip({ contribution: '0' });
  t.after(stack.restoreProvider);
  const { circles, circle, octane } = stack;
  const kemi = await makeIdentity(stack.identityService, { name: 'Kemi', handle: 'kemi' });

  // A payment nobody will ever approve.
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: octane.prismId, target: kemi });
  const orphan = await circles.proposePayment({
    circleId: circle.circleId, actorPrismId: octane.prismId, resolution, amountAtomic: USD(5), memo: 'Never approved'
  });

  await circles.beginClose({ circleId: circle.circleId, actorPrismId: octane.prismId });
  let preflight = await circles.closePreflight(circle.circleId, octane.prismId);
  const blocker = preflight.blockers.find((b) => b.code === 'OPEN_PROPOSALS');
  assert.ok(blocker, 'an open decision blocks closing');
  assert.equal(blocker.proposals[0].proposalId, orphan.proposalId);
  await assert.rejects(() => closeWith(stack, preflight), /cannot be closed yet/);

  // Cancelling it is a real resolution: the decision is recorded as cancelled, not deleted.
  const cancelled = await circles.cancelProposal({ circleId: circle.circleId, proposalId: orphan.proposalId, actorPrismId: octane.prismId });
  assert.equal(cancelled.lifecycle, 'CANCELLED');

  preflight = await circles.closePreflight(circle.circleId, octane.prismId);
  assert.equal(preflight.canClose, true);
  assert.equal((await closeWith(stack, preflight)).status, 'CLOSED');

  // The cancelled payment is still there afterwards — closing deletes nothing.
  const after = await circles.canonicalFor(orphan.proposalId, octane.prismId);
  assert.equal(after.payment.circle.state, 'CANCELLED');
  assert.equal(after.payment.amountAtomic, USD(5));
});

test('a member who can still spend blocks closing until the Circle revokes it on Monad', async (t) => {
  const stack = await circleStack({ withPayments: true, withLimits: true });
  t.after(stack.restoreProvider);
  const octane = await makeIdentity(stack.identityService, { name: 'Octane', handle: 'octane' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const circle = await stack.circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }], threshold: 2,
    policyAcknowledgement: acknowledgement({ threshold: 2, adminCount: 2, warnings: ['NO_SPARE_AUTHORITY'] })
  });
  stack.fake.setBalance(octane.accountAddress, USD(2000));
  await contribute({ circles: stack.circles, circleId: circle.circleId, member: octane, amountAtomic: USD(200) });

  const sarah = await makeIdentity(stack.identityService, { name: 'Sarah', handle: 'sarah' });
  const invite = stack.circles.invite({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, role: 'SPENDER' });
  stack.circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: sarah.prismId });
  for (let step = 0; step < 5; step++) {
    const prepared = await stack.circles.prepareSpendingLimit({
      circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, amountAtomic: USD(50), period: 'DAILY'
    });
    if (prepared.complete) break;
    for (const admin of [octane, tobi]) {
      const signature = await admin.account.sign({ hash: prepared.safeTxHash });
      await stack.circles.recordApproval({ circleId: circle.circleId, proposalId: prepared.proposalId, prismId: admin.prismId, signature });
    }
    await stack.circles.executeGovernance({ circleId: circle.circleId, proposalId: prepared.proposalId, actorPrismId: octane.prismId });
  }

  const preflight = await stack.circles.closePreflight(circle.circleId, octane.prismId);
  const access = preflight.blockers.find((b) => b.code === 'SPENDING_ACCESS');
  assert.ok(access, 'a live spending delegate blocks closing');
  assert.equal(access.members[0].prismId, sarah.prismId);
  assert.match(access.detail, /Revoke every spending limit on Monad first/);

  // Revoking it is a governance change, and it still works while the Circle is closing.
  await stack.circles.beginClose({ circleId: circle.circleId, actorPrismId: octane.prismId });
  const revoke = await stack.circles.prepareSpendingLimitRevoke({
    circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId
  });
  for (const admin of [octane, tobi]) {
    const signature = await admin.account.sign({ hash: revoke.safeTxHash });
    await stack.circles.recordApproval({ circleId: circle.circleId, proposalId: revoke.proposalId, prismId: admin.prismId, signature });
  }
  await stack.circles.executeGovernance({ circleId: circle.circleId, proposalId: revoke.proposalId, actorPrismId: octane.prismId });
  assert.equal(stack.fake.delegatesOf(circle.safeAddress).length, 0);

  const afterRevoke = await stack.circles.closePreflight(circle.circleId, octane.prismId);
  assert.ok(!afterRevoke.blockers.some((b) => b.code === 'SPENDING_ACCESS'));
  // Money is still in there, so it still cannot close — the two requirements are independent.
  assert.ok(afterRevoke.blockers.some((b) => b.code === 'REMAINING_FUNDS'));
});

test('closing keeps every record, and a closed Circle refuses new money and new members', async (t) => {
  const stack = await lagosTrip({ contribution: USD(300) });
  t.after(stack.restoreProvider);
  const { circles, circle, octane } = stack;
  const kemi = await makeIdentity(stack.identityService, { name: 'Kemi', handle: 'kemi' });

  await circles.beginClose({ circleId: circle.circleId, actorPrismId: octane.prismId });
  const payout = await emptyInto(stack, kemi);
  const preflight = await circles.closePreflight(circle.circleId, octane.prismId);
  await closeWith(stack, preflight);

  // The whole history survives: contributions, payments, receipts, and the Circle's own activity.
  const activity = new CircleActivityService({
    store: stack.store, config: stack.config, circleService: circles, identityService: stack.identityService
  });
  const feed = await activity.list(circle.circleId, octane.prismId);
  assert.ok(feed.activity.some((a) => a.type === 'CONTRIBUTION' && a.amountAtomic === USD(300)));
  assert.ok(feed.activity.some((a) => a.paymentId === payout.proposalId));
  assert.ok(feed.activity.some((a) => a.type === 'CIRCLE_CLOSING'));
  assert.ok(feed.activity.some((a) => a.type === 'CIRCLE_CLOSED'));

  const { payment, receipt } = await circles.canonicalFor(payout.proposalId, octane.prismId);
  assert.equal(payment.lifecycleState, 'completed', 'a receipt from a closed Circle still reads true');
  assert.equal(receipt.transactionHash, payout.executionTxHash);

  // And a closed Circle is closed: nothing more goes in, nobody else is invited, nothing more is paid.
  await assert.rejects(() => circles.prepareContribution({ circleId: circle.circleId, prismId: octane.prismId, amountAtomic: USD(10) }), /closed/);
  assert.throws(() => circles.invite({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: kemi.prismId, role: 'VIEWER' }), /closed/);
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: octane.prismId, target: kemi });
  await assert.rejects(
    () => circles.proposePayment({ circleId: circle.circleId, actorPrismId: octane.prismId, resolution, amountAtomic: USD(1), memo: 'after' }),
    /closed/
  );
  // Closing is terminal: it cannot be undone, and it cannot be redone.
  await assert.rejects(() => circles.cancelClose({ circleId: circle.circleId, actorPrismId: octane.prismId }), /not being closed/);
});

test('a chain that cannot be read blocks closing rather than being assumed empty', async (t) => {
  const stack = await lagosTrip({ contribution: '0' });
  t.after(stack.restoreProvider);
  const { circles, circle, octane } = stack;
  await circles.beginClose({ circleId: circle.circleId, actorPrismId: octane.prismId });

  // With the token contract unreadable, Prism does not know whether the Circle is empty. Closing it
  // on the assumption that it is would record a closure nobody can stand behind.
  const realBalance = circles.safe.getUsdcBalance.bind(circles.safe);
  circles.safe.getUsdcBalance = async () => { throw new Error('RPC unavailable'); };
  try {
    const preflight = await circles.closePreflight(circle.circleId, octane.prismId);
    assert.equal(preflight.canClose, false);
    const funds = preflight.blockers.find((b) => b.code === 'REMAINING_FUNDS');
    assert.match(funds.title, /balance could not be read/);
    assert.match(funds.detail, /will not close a Circle without seeing that it is empty/);
    assert.equal(preflight.balance.unavailable, true);
    await assert.rejects(
      () => circles.finalizeClose({ circleId: circle.circleId, actorPrismId: octane.prismId, acknowledgement: { balanceAtomic: '0' } }),
      /cannot be closed yet/
    );
  } finally {
    circles.safe.getUsdcBalance = realBalance;
  }

  // Once it can be read again, the same Circle closes.
  const preflight = await circles.closePreflight(circle.circleId, octane.prismId);
  assert.equal(preflight.canClose, true);
  assert.equal((await closeWith(stack, preflight)).status, 'CLOSED');
});

test('a closure can be called off, and the Circle re-earns ACTIVE from a chain read', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane } = stack;

  await circles.beginClose({ circleId: circle.circleId, actorPrismId: octane.prismId, reason: 'changed our minds' });
  assert.equal(circles.getCircleRecord(circle.circleId).status, 'CLOSING');

  const reopened = await circles.cancelClose({ circleId: circle.circleId, actorPrismId: octane.prismId });
  assert.equal(reopened.status, 'ACTIVE');
  // It did not simply flip back: the activation receipt was rewritten from a fresh read of the Safe.
  const record = stack.store.read().circles[circle.circleId];
  assert.ok(Date.parse(record.activation.verifiedAt) >= Date.parse(record.closing.startedAt));
  assert.equal(record.activation.threshold, stack.fake.safeAt(circle.safeAddress).threshold);
  assert.equal(record.closing.cancelledAt != null, true, 'the attempt to close is kept, not erased');

  // And the Circle works again.
  const resumed = await contribute({ circles, circleId: circle.circleId, member: octane, amountAtomic: USD(100) });
  assert.equal(resumed.contribution.status, 'COMPLETED');
});
