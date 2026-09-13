import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { circleStack, makeIdentity, acknowledgement, contribute, resolveRecipient, ALLOWANCE_MODULE } from './circles-harness.js';

/**
 * Member spending limits — the BACKEND half.
 *
 * The division of labour is worth stating, because it is what keeps this suite honest. The
 * contract-level guarantees — replay, over-limit, wrong token, removed delegate, and the four
 * things a delegate structurally cannot do — are proven in
 * `contracts/test/AllowanceModuleCompat.t.sol`, against Safe's **actual deployed bytecode**. They
 * are not re-asserted here against a JavaScript imitation, which would prove only that the
 * imitation agrees with itself.
 *
 * What this suite proves is everything around the module that is Prism's own responsibility:
 * the version gate, that a limit can only be changed by the Circle, that "active" means a chain
 * readback, that the reported numbers come from the module, that authorization re-reads the chain
 * first, and that going over a limit routes to the Circle instead of dead-ending.
 */

const USD = (dollars) => String(BigInt(Math.round(dollars * 100)) * 10_000n);

/** A 2-of-2 Circle with limits available, funded, with Sarah as a spender. */
async function circleWithLimits({ threshold = 2, admins = 2 } = {}) {
  const stack = await circleStack({ withPayments: true, withLimits: true });
  const people = [];
  for (const [name, handle] of [['Octane', 'octane'], ['Tobi', 'tobi'], ['Kemi', 'kemi']].slice(0, admins)) {
    people.push(await makeIdentity(stack.identityService, { name, handle }));
  }
  const [creator, ...rest] = people;
  const circle = await stack.circles.createCircle({
    creatorPrismId: creator.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: rest.map((p) => ({ prismId: p.prismId })), threshold,
    policyAcknowledgement: acknowledgement({ threshold, adminCount: admins, warnings: threshold === admins ? ['NO_SPARE_AUTHORITY'] : [] })
  });
  stack.fake.setBalance(creator.accountAddress, USD(2000));
  await contribute({ circles: stack.circles, circleId: circle.circleId, member: creator, amountAtomic: USD(1000) });

  const sarah = await makeIdentity(stack.identityService, { name: 'Sarah', handle: 'sarah' });
  const invite = stack.circles.invite({ circleId: circle.circleId, actorPrismId: creator.prismId, prismId: sarah.prismId, role: 'SPENDER' });
  stack.circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: sarah.prismId });

  return { ...stack, circle, people, creator, sarah };
}

/** Approve a governance proposal with every admin, then execute it. */
async function approveAndExecute(stack, circleId, proposal, admins) {
  for (const admin of admins) {
    const signature = await admin.account.sign({ hash: proposal.safeTxHash });
    await stack.circles.recordApproval({ circleId, proposalId: proposal.proposalId, prismId: admin.prismId, signature });
  }
  return stack.circles.executeGovernance({ circleId, proposalId: proposal.proposalId, actorPrismId: admins[0].prismId });
}

/** Drive the whole "give Sarah $100/day" flow to completion, whatever steps it needs. */
async function grantLimit(stack, { circle, target, admins, amountAtomic, period }) {
  const results = [];
  for (let step = 0; step < 5; step++) {
    const prepared = await stack.circles.prepareSpendingLimit({
      circleId: circle.circleId, actorPrismId: admins[0].prismId, prismId: target.prismId, amountAtomic, period
    });
    if (prepared.complete) break;
    results.push(await approveAndExecute(stack, circle.circleId, prepared, admins));
  }
  return results;
}

// ===========================================================================
// The version gate
// ===========================================================================

test('gate: an old Allowance Module version fails the build/integration gate', async () => {
  const { assertCircleLimitsAreSafe, config } = await import('../src/config.js');
  const saved = { enabled: config.circles.limitsEnabled, module: config.circles.allowanceModule };
  try {
    // v0.1.1 — the release deployed on Monad, and the one the official package hands out unpinned.
    config.circles.limitsEnabled = true;
    config.circles.allowanceModule = '0xAA46724893dedD72658219405185Fb0Fc91e091C';
    const bad = assertCircleLimitsAreSafe([]);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /v0\.1\.1/);
    assert.match(bad[0], /replay/);

    // Limits on with no module named is equally refused — no silent default.
    config.circles.allowanceModule = '';
    assert.match(assertCircleLimitsAreSafe([])[0], /CIRCLE_ALLOWANCE_MODULE/);
  } finally {
    config.circles.limitsEnabled = saved.enabled;
    config.circles.allowanceModule = saved.module;
  }
});

test('gate: the runtime gate identifies the module by CODE, not by address', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);

  const good = await stack.circles.limitsStatus();
  assert.equal(good.enabled, true, 'canonical bytecode at the canonical address');
  assert.equal(good.module.version, '1.0.0');
  assert.equal(good.module.codeHash, '0xfafc86ce3000fbdc8ad155875c0b3b5a20d17662e7c2cdbf3e95f15945a46657');

  // An impostor at the right address, with a real contract's worth of code, is refused.
  stack.fake.knobs.moduleCodeOverride = `0x60806040${'ab'.repeat(4000)}`;
  stack.limitGate._cache = null;
  const bad = await stack.circles.limitsStatus();
  assert.equal(bad.enabled, false);
  assert.match(bad.reason, /not Safe's canonical Allowance Module/);
});

test('gate: when the module cannot be verified, limits are simply unavailable', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  stack.fake.knobs.moduleCodeOverride = '0x';   // nothing deployed
  stack.limitGate._cache = null;

  const status = await stack.circles.limitsStatus();
  assert.equal(status.enabled, false);
  assert.match(status.reason, /no contract at/);

  // And the Circle keeps working: a payment routes to the threshold, which always exists.
  const preview = await stack.circles.previewPayment({
    circleId: stack.circle.circleId, actorPrismId: stack.creator.prismId, amountAtomic: USD(40)
  });
  assert.equal(preview.route, 'THRESHOLD');
  assert.equal(preview.requiresApproval, true);
});

test('gate: a Circle with limits off never offers a limit to configure', async (t) => {
  const stack = await circleStack({ withPayments: true });          // withLimits omitted
  t.after(stack.restoreProvider);
  const ada = await makeIdentity(stack.identityService, { name: 'Ada', handle: 'ada' });
  const circle = await stack.circles.createCircle({
    creatorPrismId: ada.prismId, name: 'Solo', template: 'CUSTOM', admins: [], threshold: 1,
    policyAcknowledgement: acknowledgement({ threshold: 1, adminCount: 1 })
  });
  const status = await stack.circles.limitsStatus();
  assert.equal(status.enabled, false);
  await assert.rejects(
    () => stack.circles.prepareSpendingLimit({
      circleId: circle.circleId, actorPrismId: ada.prismId, prismId: ada.prismId, amountAtomic: USD(100), period: 'DAILY'
    }),
    /not available|unavailable/
  );
});

// ===========================================================================
// Changing a limit is a Circle governance action
// ===========================================================================

test('limits: setting a limit needs the admin threshold, and is Active only after a chain readback', async (t) => {
  const stack = await circleWithLimits({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, fake } = stack;
  const admins = stack.people;

  // Step 1 — enable the module on this Circle.
  const enable = await circles.prepareSpendingLimit({
    circleId: circle.circleId, actorPrismId: admins[0].prismId, prismId: sarah.prismId,
    amountAtomic: USD(100), period: 'DAILY'
  });
  assert.equal(enable.kind, 'MODULE_ENABLE');
  assert.deepEqual(enable.remainingSteps, ['SPEND_DELEGATE_ADD', 'SPEND_LIMIT_SET']);
  assert.equal(enable.requiredApprovals, 2);
  assert.equal(enable.isSpendingLimitChange, true);

  // One approval is not enough — the Circle's threshold governs a limit exactly as it governs money.
  await circles.recordApproval({
    circleId: circle.circleId, proposalId: enable.proposalId, prismId: admins[0].prismId,
    signature: await admins[0].account.sign({ hash: enable.safeTxHash })
  });
  const blocked = await circles.executeGovernance({ circleId: circle.circleId, proposalId: enable.proposalId, actorPrismId: admins[0].prismId });
  assert.match(blocked.blocked, /1 of 2 approvals/);
  assert.equal(fake.moduleEnabledOn(circle.safeAddress), false, 'nothing changed on-chain');

  await approveAndExecute(stack, circle.circleId, enable, [admins[1]]);
  assert.equal(fake.moduleEnabledOn(circle.safeAddress), true);

  // Steps 2 and 3.
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });

  const { limit } = await circles.spendingLimitFor(circle.circleId, admins[0].prismId, sarah.prismId);
  assert.equal(limit.hasSpendingAccess, true);
  assert.equal(limit.limitDisplay, '$100.00');
  assert.equal(limit.period, 'DAILY');
  assert.equal(limit.summary, '$100.00 per day');
  assert.equal(limit.source, 'chain');

  // The delegate is the member's EXISTING Prism authority address — no new credential was minted.
  assert.equal(getAddress(limit.authorityAddress), getAddress(sarah.accountAddress));
  assert.deepEqual(fake.delegatesOf(circle.safeAddress), [getAddress(sarah.accountAddress)]);
});

test('limits: the backend cannot change a limit by itself', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, store, fake } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });

  // Rewrite every Prism-side record that mentions the limit.
  store.mutate((d) => {
    for (const proposal of Object.values(d.circleProposals ?? {})) {
      if (proposal.governance) proposal.governance.amountAtomic = USD(5000);
      if (proposal.subject?.amount) proposal.subject.amount = USD(5000);
    }
  });

  // The reported limit is unchanged, because it was never read from those rows.
  const { limit } = await circles.spendingLimitFor(circle.circleId, admins[0].prismId, sarah.prismId);
  assert.equal(limit.limitAtomic, USD(100));
  assert.equal(fake.allowanceOf(circle.safeAddress, sarah.accountAddress, stack.config.chain.usdc).amount, BigInt(USD(100)));
});

test('limits: a member cannot raise their own limit', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });

  // Sarah is a SPENDER, not an admin: preparing a limit change is not offered to her at all.
  await assert.rejects(
    () => circles.prepareSpendingLimit({
      circleId: circle.circleId, actorPrismId: sarah.prismId, prismId: sarah.prismId,
      amountAtomic: USD(5000), period: 'DAILY'
    }),
    /only an admin/
  );
});

test('limits: a governance change recorded as applied without a readback reads back as INVALIDATED', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, store } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });

  const applied = Object.values(store.read().circleProposals).find((p) => p.kind === 'SPEND_LIMIT_SET');
  assert.equal(applied.lifecycle, 'COMPLETED');
  assert.ok(applied.evidence.readback, 'completion carried a module readback');

  store.mutate((d) => { d.circleProposals[applied.proposalId].evidence = { transactionHash: '0x' + 'ab'.repeat(32) }; });
  const view = await circles.reconcileGovernance({ circleId: circle.circleId, proposalId: applied.proposalId, prismId: admins[0].prismId });
  assert.equal(view.lifecycle, 'INVALIDATED');
  assert.equal(view.storedLifecycle, 'COMPLETED');
});

test('limits: only USDC — there is no token parameter anywhere on the limit surface', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, config } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });

  const { limit } = await circles.spendingLimitFor(circle.circleId, admins[0].prismId, sarah.prismId);
  assert.equal(limit.asset, 'USDC');
  assert.equal(getAddress(limit.token), getAddress(config.chain.usdc));

  // A caller cannot name a token: the method signature has no such parameter, and the encoder
  // takes the token from configuration.
  assert.equal(/token/.test(circles.prepareSpendingLimit.toString().split('\n')[0]), false);
  const { encodeSetAllowance } = await import('../src/circles/allowanceModule.js');
  assert.throws(() => encodeSetAllowance({ delegate: sarah.accountAddress, token: 'not-an-address', amountAtomic: '1', period: 'DAILY' }), /must be an address/);
});

// ===========================================================================
// Allowance truth
// ===========================================================================

test('truth: limit, spent and available all come from the module, not from Prism activity', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, fake, resolverService } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });
  const shop = await makeIdentity(stack.identityService, { name: 'Shop', handle: 'shop' });

  // Spend $42 of the $100.
  const resolution = resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: shop });
  const prepared = await circles.prepareSpend({
    circleId: circle.circleId, actorPrismId: sarah.prismId, resolution, amountAtomic: USD(42), memo: 'Lunch'
  });
  const signature = await sarah.account.sign({ hash: prepared.transferHash });
  const settled = await circles.submitSpend({ circleId: circle.circleId, spendId: prepared.spend.spendId, prismId: sarah.prismId, signature });
  assert.equal(settled.spend.status, 'COMPLETED');

  const { limit } = await circles.spendingLimitFor(circle.circleId, sarah.prismId);
  assert.equal(limit.limitDisplay, '$100.00');
  assert.equal(limit.spentDisplay, '$42.00');
  assert.equal(limit.availableDisplay, '$58.00');
  assert.equal(limit.source, 'chain');

  // Deleting Prism's record of the spend changes none of those numbers.
  stack.store.mutate((d) => { d.circleSpends = {}; });
  const again = await circles.spendingLimitFor(circle.circleId, sarah.prismId);
  assert.equal(again.limit.spentDisplay, '$42.00', 'spent is the module\'s figure, not a sum of Prism rows');
  assert.equal(fake.balanceOf(shop.accountAddress).toString(), USD(42));
});

test('truth: the window rolls over on-chain, with nothing from Prism', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, fake, resolverService } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });
  const shop = await makeIdentity(stack.identityService, { name: 'Shop', handle: 'shop' });

  const spend = async (dollars) => {
    const resolution = resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: shop });
    const prepared = await circles.prepareSpend({ circleId: circle.circleId, actorPrismId: sarah.prismId, resolution, amountAtomic: USD(dollars) });
    const signature = await sarah.account.sign({ hash: prepared.transferHash });
    return circles.submitSpend({ circleId: circle.circleId, spendId: prepared.spend.spendId, prismId: sarah.prismId, signature });
  };

  await spend(100);
  assert.equal((await circles.spendingLimitFor(circle.circleId, sarah.prismId)).limit.availableDisplay, '$0.00');
  await assert.rejects(() => spend(10), /above your \$100\.00 limit/);

  fake.warp(24 * 3600 + 60);
  const rolled = await circles.spendingLimitFor(circle.circleId, sarah.prismId);
  assert.equal(rolled.limit.availableDisplay, '$100.00', 'the module reset the window');
  const after = await spend(10);
  assert.equal(after.spend.status, 'COMPLETED');
});

// ===========================================================================
// Authorization freshness
// ===========================================================================

test('freshness: a spend authorized before the Circle cut the limit is refused', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, fake, resolverService } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });
  const shop = await makeIdentity(stack.identityService, { name: 'Shop', handle: 'shop' });

  // Sarah prepares and signs $80 while her limit is $100.
  const resolution = resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: shop });
  const prepared = await circles.prepareSpend({ circleId: circle.circleId, actorPrismId: sarah.prismId, resolution, amountAtomic: USD(80) });
  const signature = await sarah.account.sign({ hash: prepared.transferHash });

  // Meanwhile the Circle cuts it to $20.
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(20), period: 'DAILY' });

  await assert.rejects(
    () => circles.submitSpend({ circleId: circle.circleId, spendId: prepared.spend.spendId, prismId: sarah.prismId, signature }),
    /your limit changed/
  );
  assert.equal(fake.balanceOf(shop.accountAddress).toString(), '0');
  assert.equal(fake.calls.allowanceTransfers.length, 0, 'nothing was broadcast');
});

test('freshness: a stale authorization cannot be replayed after the nonce moves', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, fake, resolverService } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });
  const shop = await makeIdentity(stack.identityService, { name: 'Shop', handle: 'shop' });

  const resolution = () => resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: shop });
  const first = await circles.prepareSpend({ circleId: circle.circleId, actorPrismId: sarah.prismId, resolution: resolution(), amountAtomic: USD(10) });
  const second = await circles.prepareSpend({ circleId: circle.circleId, actorPrismId: sarah.prismId, resolution: resolution(), amountAtomic: USD(10) });
  assert.equal(first.spend.allowanceNonce, second.spend.allowanceNonce, 'both were prepared against the same module nonce');

  const sigA = await sarah.account.sign({ hash: first.transferHash });
  await circles.submitSpend({ circleId: circle.circleId, spendId: first.spend.spendId, prismId: sarah.prismId, signature: sigA });

  // The second carries the now-consumed nonce. Refused before anything reaches the chain.
  const sigB = await sarah.account.sign({ hash: second.transferHash });
  await assert.rejects(
    () => circles.submitSpend({ circleId: circle.circleId, spendId: second.spend.spendId, prismId: sarah.prismId, signature: sigB }),
    /stale/
  );
  // Re-submitting the FIRST one is idempotent: it reports the spend that already happened rather
  // than spending again. The module's nonce would refuse it anyway; this stops it reaching the chain.
  const again = await circles.submitSpend({ circleId: circle.circleId, spendId: first.spend.spendId, prismId: sarah.prismId, signature: sigA });
  assert.equal(again.spend.status, 'COMPLETED');
  assert.equal(fake.calls.allowanceTransfers.length, 1, 'exactly one transfer reached the module');
  assert.equal(fake.balanceOf(shop.accountAddress).toString(), USD(10), 'paid once');
});

test('freshness: someone else cannot authorize a spend against your limit', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, resolverService } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });
  const shop = await makeIdentity(stack.identityService, { name: 'Shop', handle: 'shop' });

  const resolution = resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: shop });
  const prepared = await circles.prepareSpend({ circleId: circle.circleId, actorPrismId: sarah.prismId, resolution, amountAtomic: USD(10) });

  // An admin's signature over Sarah's transfer hash is not Sarah's authorization.
  const wrong = await admins[0].account.sign({ hash: prepared.transferHash });
  await assert.rejects(
    () => circles.submitSpend({ circleId: circle.circleId, spendId: prepared.spend.spendId, prismId: sarah.prismId, signature: wrong }),
    /not signed by your Prism account/
  );
});

// ===========================================================================
// Revoke
// ===========================================================================

test('revoke: spending access ends on-chain, and a stale session cannot preserve it', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, fake, resolverService } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });
  const shop = await makeIdentity(stack.identityService, { name: 'Shop', handle: 'shop' });

  // Sarah signs an authorization BEFORE the revoke — the "stale app session" case.
  const resolution = resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: shop });
  const prepared = await circles.prepareSpend({ circleId: circle.circleId, actorPrismId: sarah.prismId, resolution, amountAtomic: USD(10) });
  const signature = await sarah.account.sign({ hash: prepared.transferHash });

  const revoke = await circles.prepareSpendingLimitRevoke({
    circleId: circle.circleId, actorPrismId: admins[0].prismId, prismId: sarah.prismId
  });
  assert.equal(revoke.kind, 'SPEND_DELEGATE_REMOVE');
  const done = await approveAndExecute(stack, circle.circleId, revoke, admins);
  assert.equal(done.lifecycle, 'COMPLETED');
  assert.equal(done.evidence.readback.registered, false);
  assert.equal(done.evidence.readback.amountAtomic, '0', 'the figures were cleared too');

  // Only NOW does the app show no access — and it shows it because the chain says so.
  const { limit } = await circles.spendingLimitFor(circle.circleId, admins[0].prismId, sarah.prismId);
  assert.equal(limit.hasSpendingAccess, false);
  assert.equal(limit.summary, 'No spending access');

  await assert.rejects(
    () => circles.submitSpend({ circleId: circle.circleId, spendId: prepared.spend.spendId, prismId: sarah.prismId, signature }),
    /spending access/
  );
  assert.equal(fake.balanceOf(shop.accountAddress).toString(), '0');
  assert.deepEqual(fake.delegatesOf(circle.safeAddress), []);
});

test('revoke: a revoke is itself a threshold decision', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, fake } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });

  const revoke = await circles.prepareSpendingLimitRevoke({
    circleId: circle.circleId, actorPrismId: admins[0].prismId, prismId: sarah.prismId
  });
  await circles.recordApproval({
    circleId: circle.circleId, proposalId: revoke.proposalId, prismId: admins[0].prismId,
    signature: await admins[0].account.sign({ hash: revoke.safeTxHash })
  });
  const blocked = await circles.executeGovernance({ circleId: circle.circleId, proposalId: revoke.proposalId, actorPrismId: admins[0].prismId });
  assert.match(blocked.blocked, /1 of 2 approvals/);
  assert.deepEqual(fake.delegatesOf(circle.safeAddress), [getAddress(sarah.accountAddress)], 'still a spender');
});

// ===========================================================================
// Over-limit UX
// ===========================================================================

test('over limit: the answer is a fork, not a dead end', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });

  const within = await circles.previewPayment({ circleId: circle.circleId, actorPrismId: sarah.prismId, amountAtomic: USD(40) });
  assert.equal(within.route, 'ALLOWANCE');
  assert.equal(within.requiresApproval, false);
  assert.equal(within.limit.availableDisplay, '$100.00');

  const over = await circles.previewPayment({ circleId: circle.circleId, actorPrismId: sarah.prismId, amountAtomic: USD(140) });
  assert.equal(over.route, 'THRESHOLD');
  assert.equal(over.overLimit, true);
  assert.equal(over.requiresApproval, true);
  assert.equal(over.reason, 'This is above your $100.00 daily limit.');
  assert.equal(over.prompt, 'Request approval from the Circle?');
  assert.equal(over.requiredApprovals, 2, 'and it says how many admins would have to agree');
  assert.equal(over.limit.availableDisplay, '$100.00');
});

test('over limit: choosing "request approval" produces an ordinary threshold payment', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, fake, resolverService } = stack;
  const admins = stack.people;
  await grantLimit(stack, { circle, target: sarah, admins, amountAtomic: USD(100), period: 'DAILY' });
  const airbnb = await makeIdentity(stack.identityService, { name: 'Airbnb', handle: 'airbnb' });

  // Over her limit, Sarah cannot authorize it alone.
  const resolution = resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: airbnb });
  await assert.rejects(
    () => circles.prepareSpend({ circleId: circle.circleId, actorPrismId: sarah.prismId, resolution, amountAtomic: USD(480) }),
    /above your \$100\.00 limit/
  );

  // So it becomes an ordinary Circle payment — the same threshold path a Circle without limits uses.
  const proposal = await circles.proposePayment({
    circleId: circle.circleId, actorPrismId: sarah.prismId,
    resolution: resolveRecipient({ resolverService, requesterPrismId: sarah.prismId, target: airbnb }),
    amountAtomic: USD(480), memo: 'AIRBNB'
  });
  assert.equal(proposal.lifecycle, 'APPROVAL_PENDING');
  assert.equal(proposal.requiredApprovals, 2);

  for (const admin of admins) {
    await circles.approvePayment({
      circleId: circle.circleId, proposalId: proposal.proposalId, prismId: admin.prismId,
      signature: await admin.account.sign({ hash: proposal.safeTxHash })
    });
  }
  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: proposal.proposalId, actorPrismId: admins[0].prismId });
  assert.equal(done.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(airbnb.accountAddress).toString(), USD(480));

  // And it did NOT come out of Sarah's limit — a threshold payment is the Circle's, not a member's.
  const { limit } = await circles.spendingLimitFor(circle.circleId, sarah.prismId);
  assert.equal(limit.spentDisplay, '$0.00');
});

test('over limit: a member with no spending access is routed to the Circle, not refused', async (t) => {
  const stack = await circleWithLimits();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah } = stack;

  const preview = await circles.previewPayment({ circleId: circle.circleId, actorPrismId: sarah.prismId, amountAtomic: USD(40) });
  assert.equal(preview.route, 'THRESHOLD');
  assert.match(preview.reason, /has not turned on spending limits|do not have a spending limit/);
  assert.equal(preview.limit, null);
});

// ===========================================================================
// The examples from the brief
// ===========================================================================

test('limits: Sarah $100/day, David $500 total, Jayson $250/week', async (t) => {
  const stack = await circleWithLimits({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle } = stack;
  const admins = stack.people;

  const people = {};
  for (const [name, handle, amount, period] of [
    ['Sarah', 'sarah2', USD(100), 'DAILY'],
    ['David', 'david', USD(500), 'TOTAL'],
    ['Jayson', 'jayson', USD(250), 'WEEKLY']
  ]) {
    const person = await makeIdentity(stack.identityService, { name, handle });
    const invite = circles.invite({ circleId: circle.circleId, actorPrismId: admins[0].prismId, prismId: person.prismId, role: 'SPENDER' });
    circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: person.prismId });
    await grantLimit(stack, { circle, target: person, admins, amountAtomic: amount, period });
    people[name] = person;
  }

  const { limits } = await circles.listSpendingLimits(circle.circleId, admins[0].prismId);
  const byName = Object.fromEntries(limits.filter((l) => l.hasSpendingAccess).map((l) => [l.displayName, l.summary]));
  assert.equal(byName.Sarah, '$100.00 per day');
  assert.equal(byName.David, '$500.00 total');
  assert.equal(byName.Jayson, '$250.00 per week');

  // A one-off "total" budget never resets, however long you wait.
  stack.fake.warp(400 * 24 * 3600);
  const david = (await circles.spendingLimitFor(circle.circleId, admins[0].prismId, people.David.prismId)).limit;
  assert.equal(david.period, 'TOTAL');
  assert.equal(david.resetsAt, null, 'a total budget has no reset');
});

// ===========================================================================
// Cross-implementation agreement
// ===========================================================================

test('vectors: the backend computes the same transfer hash the deployed module does', async () => {
  const fs = await import('node:fs');
  const { allowanceTransferHash } = await import('../src/circles/allowanceModule.js');
  // Written by AllowanceModuleCompat.t.sol from the REAL module's own `generateTransferHash`,
  // running against Safe's deployed bytecode. Same discipline as safe-tx-vectors.json: the value a
  // compromised backend would have to lie with must be checkable against something it did not produce.
  const vectors = JSON.parse(fs.readFileSync(new URL('../../proof/circles/allowance-transfer-vectors.json', import.meta.url), 'utf8'));
  assert.ok(vectors.length >= 3);
  for (const v of vectors) {
    const mine = allowanceTransferHash({
      chainId: v.chainId, moduleAddress: v.module, safeAddress: v.safe,
      token: v.token, recipient: v.to, amountAtomic: v.amount, nonce: v.nonce
    });
    assert.equal(mine.toLowerCase(), v.transferHash.toLowerCase(), `nonce ${v.nonce}, amount ${v.amount}`);
  }
});

test('vectors: the version floor and the canonical module are stated once and agree everywhere', async () => {
  const backend = await import('../src/circles/allowanceModule.js');
  const config = await import('../src/config.js');
  const gate = await import('../../tools/circles/verify-allowance-module.mjs');

  assert.equal(backend.MINIMUM_ALLOWANCE_MODULE_VERSION, '1.0.0');
  assert.equal(gate.MINIMUM_ALLOWANCE_MODULE_VERSION, backend.MINIMUM_ALLOWANCE_MODULE_VERSION);
  assert.equal(config.MINIMUM_ALLOWANCE_MODULE_VERSION, backend.MINIMUM_ALLOWANCE_MODULE_VERSION);
  assert.equal(gate.CANONICAL_V1.codeHash, backend.CANONICAL_ALLOWANCE_MODULE.codeHash);
  assert.equal(config.CANONICAL_ALLOWANCE_MODULE_CODEHASH, backend.CANONICAL_ALLOWANCE_MODULE.codeHash);
  assert.equal(getAddress(gate.CANONICAL_V1.address), getAddress(backend.CANONICAL_ALLOWANCE_MODULE.address));

  // And every vulnerable release is refused by the shared version test.
  for (const version of backend.VULNERABLE_ALLOWANCE_MODULE_VERSIONS) {
    assert.equal(backend.meetsMinimumModuleVersion(version), false, `v${version} must never pass`);
    assert.equal(gate.meetsMinimum(version), false, `v${version} must never pass the build gate either`);
  }
});
