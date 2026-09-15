import test from 'node:test';
import assert from 'node:assert/strict';
import { circleStack, makeIdentity, acknowledgement, contribute, resolveRecipient } from './circles-harness.js';
import { CircleActivityService } from '../src/services/circleActivityService.js';
import { ActivityService } from '../src/services/activityService.js';

/**
 * Circle Activity.
 *
 * The property under test is the one the design is named for: **there is no separate Circle
 * transaction history.** Every financial row in the feed is a projection of a record that was
 * already reconciled against the chain, and the way this suite proves it is by counting: the feed's
 * money rows must correspond exactly to the contributions, payments and spends that exist, and the
 * amounts in them must reconcile with `USDC.balanceOf(safe)`.
 *
 * The second property is separability: a limit change and a payment are different kinds of event and
 * must never be able to be summed, sorted or rendered as if they were the same thing.
 */

const USD = (dollars) => String(BigInt(Math.round(dollars * 100)) * 10_000n);

function activityFor(stack) {
  return new CircleActivityService({
    store: stack.store, config: stack.config, circleService: stack.circles, identityService: stack.identityService
  });
}

async function lagosTrip({ threshold = 2 } = {}) {
  const stack = await circleStack({ withPayments: true });
  const octane = await makeIdentity(stack.identityService, { name: 'Octane', handle: 'octane' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const circle = await stack.circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }], threshold,
    policyAcknowledgement: acknowledgement({ threshold, adminCount: 2, warnings: threshold === 2 ? ['NO_SPARE_AUTHORITY'] : ['ANY_ADMIN_ALONE'] })
  });
  stack.fake.setBalance(octane.accountAddress, USD(1000));
  stack.fake.setBalance(tobi.accountAddress, USD(1000));
  return { ...stack, circle, octane, tobi, admins: [octane, tobi] };
}

async function payTo(stack, { to, dollars, memo, admins }) {
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: stack.octane.prismId, target: to });
  const payment = await stack.circles.proposePayment({
    circleId: stack.circle.circleId, actorPrismId: stack.octane.prismId, resolution, amountAtomic: USD(dollars), memo
  });
  for (const admin of admins) {
    const signature = await admin.account.sign({ hash: payment.safeTxHash });
    await stack.circles.approvePayment({ circleId: stack.circle.circleId, proposalId: payment.proposalId, prismId: admin.prismId, signature });
  }
  return stack.circles.executePayment({ circleId: stack.circle.circleId, proposalId: payment.proposalId, actorPrismId: stack.octane.prismId });
}

test('the feed shows money and governance as distinguishable kinds of event', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi } = stack;

  await contribute({ circles, circleId: circle.circleId, member: tobi, amountAtomic: USD(100) });
  await contribute({ circles, circleId: circle.circleId, member: octane, amountAtomic: USD(500) });
  const host = await makeIdentity(stack.identityService, { name: 'Airbnb', handle: 'airbnbhost' });
  const paid = await payTo(stack, { to: host, dollars: 480, memo: 'Apartment', admins: [octane, tobi] });
  assert.equal(paid.lifecycle, 'COMPLETED');

  const { activity } = await activityFor(stack).list(circle.circleId, octane.prismId);
  const money = activity.filter((a) => a.class === 'financial');
  const governance = activity.filter((a) => a.class === 'governance');

  // "Tobi added / +$100.00"
  const contribution = money.find((a) => a.type === 'CONTRIBUTION' && a.actor.displayName === 'Tobi');
  assert.equal(contribution.title, 'Tobi added');
  assert.equal(contribution.signedAmountDisplay, '+$100.00');
  assert.equal(contribution.direction, 'in');
  assert.equal(contribution.settled, true);

  // "Airbnb / Apartment / -$480.00"
  const payment = money.find((a) => a.type === 'PAYMENT');
  assert.equal(payment.title, 'Airbnb');
  assert.equal(payment.subtitle, 'Apartment');
  assert.equal(payment.signedAmountDisplay, '-$480.00');
  assert.equal(payment.direction, 'out');
  assert.equal(payment.approvalRule, '2 approvals');
  assert.ok(payment.transactionHash, 'a settled payment row names its transaction');

  // "Tobi joined" — a governance event, carrying no money fields at all, so nothing can sum it.
  const joined = governance.find((a) => a.type === 'MEMBER_JOINED' && a.subject.displayName === 'Tobi');
  assert.ok(joined, 'the feed records who joined');
  assert.equal(joined.amountAtomic, null);
  assert.equal(joined.direction, null);
  assert.equal(joined.signedAmountDisplay, null);
  for (const item of governance) {
    assert.equal(item.amountAtomic, null, `${item.type} must carry no amount`);
    assert.equal(item.direction, null);
  }

  // The Circle's own life is in the feed too.
  assert.ok(governance.some((a) => a.type === 'CIRCLE_CREATED'));
  assert.ok(governance.some((a) => a.type === 'CIRCLE_ACTIVE'));

  // Newest first, and every row has a real time.
  const times = activity.map((a) => Date.parse(a.occurredAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.ok(times.every((t) => Number.isFinite(t) && t > 0));
});

test('the feed is a projection of reconciled records, not a second ledger', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, fake } = stack;

  await contribute({ circles, circleId: circle.circleId, member: octane, amountAtomic: USD(500) });
  await contribute({ circles, circleId: circle.circleId, member: tobi, amountAtomic: USD(300) });
  const host = await makeIdentity(stack.identityService, { name: 'Airbnb', handle: 'airbnbhost' });
  await payTo(stack, { to: host, dollars: 480, memo: 'Apartment', admins: [octane, tobi] });

  const { activity, source } = await activityFor(stack).list(circle.circleId, octane.prismId);
  assert.equal(source, 'reconciled');
  const money = activity.filter((a) => a.class === 'financial' && a.settled);

  // Every money row corresponds to exactly one record that exists, and to nothing else.
  const contributions = circles.listContributions(circle.circleId, octane.prismId).contributions;
  const payments = (await circles.listPayments(circle.circleId, octane.prismId)).payments;
  assert.equal(money.length, contributions.length + payments.length);
  for (const row of money) {
    const backing = [...contributions.map((c) => c.contributionId), ...payments.map((p) => p.proposalId)];
    assert.ok(backing.includes(row.paymentId), 'every money row is backed by a real record');
  }

  // And the rows reconcile with the chain: in − out == balanceOf(safe).
  const inbound = money.filter((m) => m.direction === 'in').reduce((sum, m) => sum + BigInt(m.amountAtomic), 0n);
  const outbound = money.filter((m) => m.direction === 'out').reduce((sum, m) => sum + BigInt(m.amountAtomic), 0n);
  assert.equal((inbound - outbound).toString(), fake.balanceOf(circle.safeAddress).toString());
});

test('an unsettled payment appears with its approval progress and is never marked settled', async (t) => {
  const stack = await lagosTrip({ threshold: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, octane } = stack;
  await contribute({ circles, circleId: circle.circleId, member: octane, amountAtomic: USD(500) });

  const host = await makeIdentity(stack.identityService, { name: 'Airbnb', handle: 'airbnbhost' });
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: octane.prismId, target: host });
  const payment = await circles.proposePayment({
    circleId: circle.circleId, actorPrismId: octane.prismId, resolution, amountAtomic: USD(480), memo: 'Apartment'
  });
  const signature = await octane.account.sign({ hash: payment.safeTxHash });
  await circles.approvePayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId, signature });

  const { activity } = await activityFor(stack).list(circle.circleId, octane.prismId);
  const row = activity.find((a) => a.paymentId === payment.proposalId);
  assert.equal(row.settled, false);
  assert.equal(row.status, 'APPROVAL_PENDING');
  assert.equal(row.detail, '1 of 2 approvals');
  assert.equal(row.transactionHash, null, 'nothing was broadcast, so no transaction is named');
});

test('a spending limit change reads as a change, and only after the chain confirmed it', async (t) => {
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
  await contribute({ circles: stack.circles, circleId: circle.circleId, member: octane, amountAtomic: USD(1000) });
  const sarah = await makeIdentity(stack.identityService, { name: 'Sarah', handle: 'sarah' });
  const invite = stack.circles.invite({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, role: 'SPENDER' });
  stack.circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: sarah.prismId });

  const grant = async (dollars) => {
    for (let step = 0; step < 5; step++) {
      const prepared = await stack.circles.prepareSpendingLimit({
        circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId,
        amountAtomic: USD(dollars), period: 'DAILY'
      });
      if (prepared.complete) break;
      for (const admin of [octane, tobi]) {
        const signature = await admin.account.sign({ hash: prepared.safeTxHash });
        await stack.circles.recordApproval({ circleId: circle.circleId, proposalId: prepared.proposalId, prismId: admin.prismId, signature });
      }
      await stack.circles.executeGovernance({ circleId: circle.circleId, proposalId: prepared.proposalId, actorPrismId: octane.prismId });
    }
  };

  await grant(50);
  let feed = await activityFor(stack).list(circle.circleId, octane.prismId);
  const first = feed.activity.find((a) => a.type === 'SPENDING_LIMIT_CHANGED');
  // No previous limit existed, so the feed says it was set — it does not invent a starting point.
  assert.equal(first.title, "Sarah's spending limit was set");
  assert.equal(first.subtitle, '$50.00 per day');
  assert.equal(first.class, 'governance');
  assert.ok(first.transactionHash, 'the change names the transaction that applied it');
  assert.equal(first.readback.amountAtomic, USD(50), 'and the module was read back afterwards');

  await grant(100);
  feed = await activityFor(stack).list(circle.circleId, octane.prismId);
  const changed = feed.activity.filter((a) => a.type === 'SPENDING_LIMIT_CHANGED');
  assert.equal(changed.length, 2);
  // "Sarah's spending limit changed  $50 per day → $100 per day"
  assert.equal(changed[0].title, "Sarah's spending limit changed");
  assert.equal(changed[0].subtitle, '$50.00 per day → $100.00 per day');

  // A limit change that was proposed but never executed is NOT in the feed at all.
  const proposed = await stack.circles.prepareSpendingLimit({
    circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, amountAtomic: USD(250), period: 'DAILY'
  });
  const after = await activityFor(stack).list(circle.circleId, octane.prismId);
  assert.ok(!after.activity.some((a) => a.proposalId === proposed.proposalId),
    'a change nobody applied is not an event that happened');
});

test('a Circle payment reaches the recipient\'s own Activity, paid by the Circle', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi } = stack;
  await contribute({ circles, circleId: circle.circleId, member: octane, amountAtomic: USD(500) });
  const host = await makeIdentity(stack.identityService, { name: 'Airbnb', handle: 'airbnbhost' });
  const executed = await payTo(stack, { to: host, dollars: 480, memo: 'Apartment', admins: [octane, tobi] });

  const activity = new ActivityService({ store: stack.store, identityService: stack.identityService });

  // The person who was paid sees it as money in, from the Circle.
  const received = activity.list(host.prismId).find((row) => row.id === executed.proposalId);
  assert.ok(received, 'money out of a Circle lands in the recipient\'s Activity');
  assert.equal(received.direction, 'incoming');
  assert.equal(received.kind, 'circle-received');
  assert.equal(received.sourceType, 'circle');
  assert.equal(received.counterpartyHandle, 'Lagos Trip');
  assert.equal(received.amountAtomic, USD(480));
  assert.equal(received.status, 'COMPLETED');

  // The contributor sees their contribution as an ordinary payment they made, labelled with the
  // Circle — one operation, appearing in the one Activity that operation belongs to.
  const contributed = activity.list(octane.prismId).filter((row) => row.kind === 'circle-contribution');
  assert.equal(contributed.length, 1);
  assert.equal(contributed[0].direction, 'outgoing');
  assert.equal(contributed[0].circleName, 'Lagos Trip');
  assert.equal(contributed[0].amountAtomic, USD(500));

  // And an admin who was neither payer nor payee has no personal row for the Circle's payment: it is
  // the Circle's money, and it belongs in the Circle's feed.
  assert.ok(!activity.list(tobi.prismId).some((row) => row.id === executed.proposalId));
});
