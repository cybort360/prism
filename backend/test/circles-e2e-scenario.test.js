import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { circleStack, makeIdentity, acknowledgement, contribute, resolveRecipient } from './circles-harness.js';
import { CircleActivityService } from '../src/services/circleActivityService.js';

/**
 * THE END-TO-END SCENARIO — Octane, Tobi, Jayson, Sarah and the Lagos Trip.
 *
 * This is the scenario a judge would run by hand, executed as a test: four people, a 2-of-3 Circle,
 * $500 contributed by three of them, a $120 payment that one approval cannot send and two can, a
 * member spending inside her limit, the over-limit fork, a revoked limit, and finally a Circle wound
 * down to nothing and closed with its history intact.
 *
 * **Where this runs.** Against the in-memory Monad in `circles-harness.js`, which enforces Safe's
 * real `execTransaction` rules over one USDC ledger shared with the Prism router. It is a rehearsal
 * of the testnet run, not the testnet run: no transaction here was broadcast to a public chain.
 * The blocker for the live version is a funded Monad testnet key — `RELAYER_PRIVATE_KEY` is empty in
 * this checkout, and the Safe Allowance Module is not deployed on Monad at all, so the spending-limit
 * half could not run live even with a key. Both are recorded in `forge/PROOF_LEDGER.md`.
 *
 * Amounts are USDC atomic units (6 decimals): $100 is 100_000000.
 */

const USD = (dollars) => String(BigInt(Math.round(dollars * 100)) * 10_000n);
const dollars = (atomic) => `$${(Number(BigInt(atomic)) / 1e6).toFixed(2)}`;

async function cast(stack) {
  const octane = await makeIdentity(stack.identityService, { name: 'Octane', handle: 'octane' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const jayson = await makeIdentity(stack.identityService, { name: 'Jayson', handle: 'jayson' });
  const sarah = await makeIdentity(stack.identityService, { name: 'Sarah', handle: 'sarah' });
  // Everyone's personal Prism account holds test USDC and — as always in Prism — no MON.
  for (const person of [octane, tobi, jayson]) stack.fake.setBalance(person.accountAddress, USD(1000));
  return { octane, tobi, jayson, sarah };
}

const approveAll = async (stack, circleId, proposalId, safeTxHash, admins) => {
  for (const admin of admins) {
    const signature = await admin.account.sign({ hash: safeTxHash });
    await stack.circles.recordApproval({ circleId, proposalId, prismId: admin.prismId, signature });
  }
};

test('E2E: Lagos Trip — four people, 2 of 3, $500 in, a $120 payment, a limit, and an over-limit fork', async (t) => {
  const stack = await circleStack({ withPayments: true, withLimits: true });
  t.after(stack.restoreProvider);
  const { circles, fake, resolverService } = stack;
  const { octane, tobi, jayson, sarah } = await cast(stack);

  // --- SETUP: Lagos Trip, admins Octane/Tobi/Jayson, 2 of 3 -------------------
  const circle = await circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }, { prismId: jayson.prismId }], threshold: 2,
    policyAcknowledgement: acknowledgement({ threshold: 2, adminCount: 3 })
  });
  assert.equal(circle.status, 'ACTIVE', 'the Circle Safe deployed and was verified against the chain');
  const circleId = circle.circleId;

  // Sarah joins as a SPENDER — a member who can be given a limit, and who holds no Safe authority.
  const invite = circles.invite({ circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, role: 'SPENDER' });
  circles.acceptInvitation({ circleId, inviteId: invite.inviteId, prismId: sarah.prismId });

  // --- FUND: $200 + $200 + $100 = $500 ---------------------------------------
  await contribute({ circles, circleId, member: octane, amountAtomic: USD(200) });
  await contribute({ circles, circleId, member: tobi, amountAtomic: USD(200) });
  await contribute({ circles, circleId, member: jayson, amountAtomic: USD(100) });

  const funded = await circles.getCircle(circleId, octane.prismId);
  assert.equal(funded.balance.amountAtomic, USD(500), 'the Circle holds $500');
  assert.equal(funded.balance.source, 'chain');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(500), 'and the token contract agrees');
  assert.equal(fake.balanceOf(octane.accountAddress).toString(), USD(800), 'each contributor was debited');
  assert.equal(fake.balanceOf(jayson.accountAddress).toString(), USD(900));

  // --- THRESHOLD PAYMENT: $120, one approval is not enough --------------------
  const host = await makeIdentity(stack.identityService, { name: 'Airbnb Host', handle: 'airbnbhost' });
  const resolution = resolveRecipient({ resolverService, requesterPrismId: octane.prismId, target: host });
  const payment = await circles.proposePayment({
    circleId, actorPrismId: octane.prismId, resolution, amountAtomic: USD(120), memo: 'Apartment'
  });

  const octaneSig = await octane.account.sign({ hash: payment.safeTxHash });
  await circles.approvePayment({ circleId, proposalId: payment.proposalId, prismId: octane.prismId, signature: octaneSig });

  const tooFew = await circles.executePayment({ circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.match(tooFew.blocked, /1 of 2 approvals/, 'one approval cannot send a 2-of-3 payment');
  assert.equal(fake.calls.executions.length, 0);
  assert.equal(fake.balanceOf(host.accountAddress).toString(), '0');

  const tobiSig = await tobi.account.sign({ hash: payment.safeTxHash });
  await circles.approvePayment({ circleId, proposalId: payment.proposalId, prismId: tobi.prismId, signature: tobiSig });
  const sent = await circles.executePayment({ circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });

  assert.equal(sent.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(host.accountAddress).toString(), USD(120), 'the recipient received exactly $120');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(380), 'and the Circle is down to $380');
  const afterPayment = await circles.getCircle(circleId, octane.prismId);
  assert.equal(afterPayment.balance.amountAtomic, USD(380));

  // --- SPENDING LIMIT: Sarah, $100 a day --------------------------------------
  for (let step = 0; step < 5; step++) {
    const prepared = await circles.prepareSpendingLimit({
      circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, amountAtomic: USD(100), period: 'DAILY'
    });
    if (prepared.complete) break;
    await approveAll(stack, circleId, prepared.proposalId, prepared.safeTxHash, [octane, tobi]);
    const applied = await circles.executeGovernance({ circleId, proposalId: prepared.proposalId, actorPrismId: octane.prismId });
    assert.equal(applied.lifecycle, 'COMPLETED', `${prepared.kind} was applied and read back`);
  }
  const limit = await circles.spendingLimitFor(circleId, sarah.prismId);
  assert.equal(limit.limit.limitAtomic, USD(100));
  assert.equal(limit.limit.source, 'chain', 'the figure comes from the module, not from Prism');

  // Sarah pays $40 inside her limit — her own authorization, no approvals.
  const market = await makeIdentity(stack.identityService, { name: 'Market', handle: 'market' });
  const spendResolution = resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: market });
  const prepared = await circles.prepareSpend({
    circleId, actorPrismId: sarah.prismId, resolution: spendResolution, amountAtomic: USD(40), memo: 'Groceries'
  });
  const spendSig = await sarah.account.sign({ hash: prepared.transferHash });
  const spent = await circles.submitSpend({ circleId, spendId: prepared.spend.spendId, prismId: sarah.prismId, signature: spendSig });
  assert.equal(spent.spend.status, 'COMPLETED');
  assert.equal(fake.balanceOf(market.accountAddress).toString(), USD(40));
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(340));

  // --- OVER-LIMIT: refused as a direct spend, offered as a Circle decision -----
  const overResolution = resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: market });
  await assert.rejects(
    () => circles.prepareSpend({ circleId, actorPrismId: sarah.prismId, resolution: overResolution, amountAtomic: USD(80), memo: 'Supplies' }),
    /above your \$100\.00 limit|ask the Circle to approve it instead/,
    '$80 against $60 remaining is refused'
  );
  const fork = await circles.previewPayment({ circleId, actorPrismId: sarah.prismId, amountAtomic: USD(80) });
  assert.equal(fork.route, 'THRESHOLD');
  assert.equal(fork.requiresApproval, true, 'the answer is a fork: the Circle can still approve it');

  // Sarah takes the offered path: an ordinary threshold proposal, approved by two admins.
  const escalated = await circles.proposePayment({
    circleId, actorPrismId: sarah.prismId, resolution: overResolution, amountAtomic: USD(80), memo: 'Supplies'
  });
  for (const admin of [octane, jayson]) {
    const signature = await admin.account.sign({ hash: escalated.safeTxHash });
    await circles.approvePayment({ circleId, proposalId: escalated.proposalId, prismId: admin.prismId, signature });
  }
  const escalatedSent = await circles.executePayment({ circleId, proposalId: escalated.proposalId, actorPrismId: octane.prismId });
  assert.equal(escalatedSent.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(market.accountAddress).toString(), USD(120), 'the market has $40 + $80');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(260));

  // The escalated payment did NOT consume her allowance — it was the Circle's money by the Circle's
  // decision, not hers by hers.
  const afterEscalation = await circles.spendingLimitFor(circleId, sarah.prismId);
  assert.equal(afterEscalation.limit.spentAtomic, USD(40), 'only the in-limit spend counted against her limit');

  // --- REVOKE: her spending access ends on-chain, and Prism reads that back ----
  const revoke = await circles.prepareSpendingLimitRevoke({ circleId, actorPrismId: octane.prismId, prismId: sarah.prismId });
  await approveAll(stack, circleId, revoke.proposalId, revoke.safeTxHash, [octane, tobi]);
  await circles.executeGovernance({ circleId, proposalId: revoke.proposalId, actorPrismId: octane.prismId });
  assert.equal(fake.delegatesOf(circle.safeAddress).length, 0, 'the module no longer lists her');

  await assert.rejects(
    () => circles.prepareSpend({ circleId, actorPrismId: sarah.prismId, resolution: overResolution, amountAtomic: USD(10), memo: 'after' }),
    /do not have a spending limit/,
    'and she can no longer spend'
  );

  // --- THE LEDGER RECONCILES --------------------------------------------------
  // $500 in, $120 + $40 + $80 out, $260 left — and the Circle's own feed says the same.
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(260));
  const feed = await new CircleActivityService({
    store: stack.store, config: stack.config, circleService: circles, identityService: stack.identityService
  }).list(circleId, octane.prismId);
  const money = feed.activity.filter((a) => a.class === 'financial' && a.settled);
  const inbound = money.filter((m) => m.direction === 'in').reduce((sum, m) => sum + BigInt(m.amountAtomic), 0n);
  const outbound = money.filter((m) => m.direction === 'out').reduce((sum, m) => sum + BigInt(m.amountAtomic), 0n);
  assert.equal(inbound.toString(), USD(500));
  assert.equal(outbound.toString(), USD(240));
  assert.equal((inbound - outbound).toString(), fake.balanceOf(circle.safeAddress).toString());

  // Every person still holds zero MON. Nobody ever needed any.
  for (const person of [octane, tobi, jayson, sarah]) {
    assert.equal((await fake.chain.getBalance({ address: person.accountAddress })).toString(), '0');
  }
});

test('E2E: a Circle is wound down — blocked while anything is open, then closed with its history intact', async (t) => {
  const stack = await circleStack({ withPayments: true, withLimits: true });
  t.after(stack.restoreProvider);
  const { circles, fake, resolverService } = stack;
  const { octane, tobi, sarah } = await cast(stack);

  const circle = await circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Beach House', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }], threshold: 2,
    policyAcknowledgement: acknowledgement({ threshold: 2, adminCount: 2, warnings: ['NO_SPARE_AUTHORITY'] })
  });
  const circleId = circle.circleId;

  // Funds, a member, a spending delegate, and a proposal nobody will approve.
  await contribute({ circles, circleId, member: octane, amountAtomic: USD(300) });
  const invite = circles.invite({ circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, role: 'SPENDER' });
  circles.acceptInvitation({ circleId, inviteId: invite.inviteId, prismId: sarah.prismId });
  for (let step = 0; step < 5; step++) {
    const prepared = await circles.prepareSpendingLimit({
      circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, amountAtomic: USD(50), period: 'DAILY'
    });
    if (prepared.complete) break;
    await approveAll(stack, circleId, prepared.proposalId, prepared.safeTxHash, [octane, tobi]);
    await circles.executeGovernance({ circleId, proposalId: prepared.proposalId, actorPrismId: octane.prismId });
  }
  const kemi = await makeIdentity(stack.identityService, { name: 'Kemi', handle: 'kemi' });
  const resolution = resolveRecipient({ resolverService, requesterPrismId: octane.prismId, target: kemi });
  const orphan = await circles.proposePayment({ circleId, actorPrismId: octane.prismId, resolution, amountAtomic: USD(25), memo: 'Never approved' });

  // --- ATTEMPT TO CLOSE: blocked, with every reason named ---------------------
  await circles.beginClose({ circleId, actorPrismId: octane.prismId, reason: 'the trip is over' });
  const blocked = await circles.closePreflight(circleId, octane.prismId);
  assert.equal(blocked.canClose, false);
  const codes = blocked.blockers.map((b) => b.code).sort();
  assert.deepEqual(codes, ['OPEN_PROPOSALS', 'REMAINING_FUNDS', 'SPENDING_ACCESS']);
  assert.match(blocked.blockers.find((b) => b.code === 'REMAINING_FUNDS').detail, /will not split it or return it automatically/);
  await assert.rejects(
    () => circles.finalizeClose({ circleId, actorPrismId: octane.prismId, acknowledgement: { balanceAtomic: USD(300) } }),
    /cannot be closed yet/
  );

  // --- RESOLVE EACH ONE -------------------------------------------------------
  // 1. The open decision is cancelled — recorded as cancelled, not deleted.
  const cancelled = await circles.cancelProposal({ circleId, proposalId: orphan.proposalId, actorPrismId: octane.prismId });
  assert.equal(cancelled.lifecycle, 'CANCELLED');

  // 2. Sarah's spending access is revoked on-chain (governance still works while closing).
  const revoke = await circles.prepareSpendingLimitRevoke({ circleId, actorPrismId: octane.prismId, prismId: sarah.prismId });
  await approveAll(stack, circleId, revoke.proposalId, revoke.safeTxHash, [octane, tobi]);
  await circles.executeGovernance({ circleId, proposalId: revoke.proposalId, actorPrismId: octane.prismId });
  assert.equal(fake.delegatesOf(circle.safeAddress).length, 0);

  // 3. The remaining money goes where the members decided — an ordinary approved payment.
  const payout = await circles.proposePayment({
    circleId, actorPrismId: octane.prismId, resolution, amountAtomic: USD(300), memo: 'Closing the Circle'
  });
  for (const admin of [octane, tobi]) {
    const signature = await admin.account.sign({ hash: payout.safeTxHash });
    await circles.approvePayment({ circleId, proposalId: payout.proposalId, prismId: admin.prismId, signature });
  }
  const paidOut = await circles.executePayment({ circleId, proposalId: payout.proposalId, actorPrismId: octane.prismId });
  assert.equal(paidOut.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), '0');
  assert.equal(fake.balanceOf(kemi.accountAddress).toString(), USD(300));

  // --- CLOSE ------------------------------------------------------------------
  const ready = await circles.closePreflight(circleId, octane.prismId);
  assert.equal(ready.canClose, true);
  const closed = await circles.finalizeClose({
    circleId, actorPrismId: octane.prismId, acknowledgement: { balanceAtomic: ready.balance.amountAtomic }
  });
  assert.equal(closed.status, 'CLOSED');

  // --- THE HISTORY IS STILL THERE ---------------------------------------------
  const record = circles.getCircleRecord(circleId);
  assert.equal(record.historyRetained, true);
  assert.equal(record.closing.evidence.balanceAtomic, '0');
  assert.equal(record.closing.evidence.withdrawals.length, 1);
  assert.equal(record.closing.evidence.withdrawals[0].amount, USD(300));
  assert.equal(getAddress(record.closing.evidence.withdrawals[0].recipientAccount), getAddress(kemi.accountAddress));

  const feed = await new CircleActivityService({
    store: stack.store, config: stack.config, circleService: circles, identityService: stack.identityService
  }).list(circleId, octane.prismId);
  assert.ok(feed.activity.some((a) => a.type === 'CONTRIBUTION' && a.amountAtomic === USD(300)));
  assert.ok(feed.activity.some((a) => a.paymentId === payout.proposalId));
  assert.ok(feed.activity.some((a) => a.type === 'SPENDING_ACCESS_REMOVED'));
  assert.ok(feed.activity.some((a) => a.type === 'CIRCLE_CLOSED'));

  // Receipts and proofs from a closed Circle still read true.
  const { payment, receipt } = await circles.canonicalFor(payout.proposalId, octane.prismId);
  assert.equal(payment.lifecycleState, 'completed');
  assert.equal(receipt.transactionHash, paidOut.executionTxHash);
  assert.equal(dollars(receipt.amountAtomic), '$300.00');

  // And nothing more can happen in it.
  await assert.rejects(() => circles.prepareContribution({ circleId, prismId: octane.prismId, amountAtomic: USD(1) }), /closed/);
});

test('E2E: a backend restart loses nothing — the Circle, its money and its receipts come back', async (t) => {
  const stack = await circleStack({ withPayments: true });
  t.after(stack.restoreProvider);
  const { circles, fake, resolverService } = stack;
  const { octane, tobi } = await cast(stack);

  const circle = await circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }], threshold: 2,
    policyAcknowledgement: acknowledgement({ threshold: 2, adminCount: 2, warnings: ['NO_SPARE_AUTHORITY'] })
  });
  const circleId = circle.circleId;
  await contribute({ circles, circleId, member: octane, amountAtomic: USD(200) });

  const kemi = await makeIdentity(stack.identityService, { name: 'Kemi', handle: 'kemi' });
  const resolution = resolveRecipient({ resolverService, requesterPrismId: octane.prismId, target: kemi });
  const payment = await circles.proposePayment({ circleId, actorPrismId: octane.prismId, resolution, amountAtomic: USD(50), memo: 'Dinner' });
  for (const admin of [octane, tobi]) {
    const signature = await admin.account.sign({ hash: payment.safeTxHash });
    await circles.approvePayment({ circleId, proposalId: payment.proposalId, prismId: admin.prismId, signature });
  }
  const sent = await circles.executePayment({ circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(sent.lifecycle, 'COMPLETED');

  // --- the process dies. A new one starts over the same store file and the same chain. ----------
  const { JsonStore } = await import('../src/lib/jsonStore.js');
  const { IdentityService } = await import('../src/services/identityService.js');
  const { CircleService } = await import('../src/services/circleService.js');
  const { SafeCircleAdapter } = await import('../src/circles/safeCircleAdapter.js');
  const reopenedStore = new JsonStore(stack.store.filePath);
  const reopened = new CircleService({
    store: reopenedStore,
    config: stack.config,
    identityService: new IdentityService({ store: reopenedStore, config: stack.config }),
    safeAdapter: new SafeCircleAdapter({ config: stack.config, chain: stack.fake.chain, txService: null }),
    paymentService: stack.paymentService,
    limitGate: null
  });

  // The Circle is still there, still ACTIVE, and its balance is read from the chain — not from a
  // number the dead process was holding.
  const after = await reopened.getCircle(circleId, octane.prismId);
  assert.equal(after.status, 'ACTIVE');
  assert.equal(after.name, 'Lagos Trip');
  assert.equal(after.balance.amountAtomic, USD(150));
  assert.equal(after.balance.amountAtomic, fake.balanceOf(circle.safeAddress).toString());
  assert.equal(after.authority.threshold, 2);
  assert.equal(after.members.length, 2);

  // The payment, its evidence and its receipt survive intact.
  const restored = await reopened.getPayment({ circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(restored.lifecycle, 'COMPLETED');
  assert.equal(restored.executionTxHash, sent.executionTxHash);
  assert.equal(restored.evidence.transfer.amountAtomic, USD(50));
  const { receipt } = await reopened.canonicalFor(payment.proposalId, octane.prismId);
  assert.equal(receipt.transactionHash, sent.executionTxHash);
  assert.deepEqual(receipt.circle.approvers.map((a) => a.displayName).sort(), ['Octane', 'Tobi']);

  // And the new process can carry on: a second payment approves and executes normally.
  const next = await reopened.proposePayment({ circleId, actorPrismId: octane.prismId, resolution, amountAtomic: USD(25), memo: 'Breakfast' });
  for (const admin of [octane, tobi]) {
    const signature = await admin.account.sign({ hash: next.safeTxHash });
    await reopened.approvePayment({ circleId, proposalId: next.proposalId, prismId: admin.prismId, signature });
  }
  const done = await reopened.executePayment({ circleId, proposalId: next.proposalId, actorPrismId: octane.prismId });
  assert.equal(done.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(125));
});
