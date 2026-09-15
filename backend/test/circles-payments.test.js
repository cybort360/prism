import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, encodeFunctionData } from 'viem';
import { circleStack, makeIdentity, acknowledgement, contribute, resolveRecipient } from './circles-harness.js';

/**
 * Money moving into and out of a Circle.
 *
 * The fake chain in `circles-harness.js` is what makes this suite worth reading: it implements
 * Safe's real `execTransaction` rules — it recomputes the digest from the arguments it is handed,
 * recovers every signature, requires ascending owner order and current ownership, and enforces its
 * own nonce — over a single USDC ledger shared with the payment router. So "1 of 2 cannot execute",
 * "a removed admin's approval stops counting" and "the relayer cannot redirect funds" are refusals
 * by a Safe, not by a Prism `if`.
 *
 * Amounts are USDC atomic units (6 decimals): $100 is 100_000000.
 */

const USD = (dollars) => String(BigInt(Math.round(dollars * 100)) * 10_000n);

/** A Circle of `n` admins at `threshold`, with the creator holding USDC to contribute. */
async function lagosTrip({ threshold = 2, admins = 2, funded = USD(500) } = {}) {
  const stack = await circleStack({ withPayments: true });
  const people = [];
  const names = [['Octane', 'octane'], ['Tobi', 'tobi'], ['Kemi', 'kemi']];
  for (let i = 0; i < admins; i++) {
    people.push(await makeIdentity(stack.identityService, { name: names[i][0], handle: names[i][1] }));
  }
  const [creator, ...rest] = people;
  const warnings = threshold === admins && admins >= 2 ? ['NO_SPARE_AUTHORITY'] : [];
  const circle = await stack.circles.createCircle({
    creatorPrismId: creator.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: rest.map((p) => ({ prismId: p.prismId })), threshold,
    policyAcknowledgement: acknowledgement({ threshold, adminCount: admins, warnings })
  });
  assert.equal(circle.status, 'ACTIVE', 'the Circle Safe deployed and verified');
  stack.fake.setBalance(creator.accountAddress, funded);
  return { ...stack, circle, creator, people, admins: people };
}

/** A recipient who is a Prism identity but not a member of the Circle. */
async function outsider(stack, { name = 'Zainab', handle = 'zainab' } = {}) {
  return makeIdentity(stack.identityService, { name, handle });
}

/** Propose a payment through the real Protected Alias Resolver, as the Send sheet would. */
async function proposeTo(stack, { circleId, from, to, dollars, memo = 'Dinner' }) {
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: from.prismId, target: to });
  return stack.circles.proposePayment({
    circleId, actorPrismId: from.prismId, resolution, amountAtomic: USD(dollars), memo
  });
}

const approve = (stack, circleId, payment, admin) =>
  admin.account.sign({ hash: payment.safeTxHash }).then((signature) =>
    stack.circles.approvePayment({ circleId, proposalId: payment.proposalId, prismId: admin.prismId, signature }));

// ===========================================================================
// Contributions — money in
// ===========================================================================

test('contribute: USDC moves from a personal Prism account into the Circle, and the balance rises', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;

  const before = await circles.getCircle(circle.circleId, creator.prismId);
  assert.equal(before.balance.amountAtomic, '0', 'a new Circle holds nothing');

  const result = await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(100) });

  assert.equal(result.contribution.status, 'COMPLETED');
  assert.equal(result.contribution.amount, USD(100));
  assert.equal(result.contribution.asset, 'USDC');
  assert.match(result.contribution.transactionHash, /^0x[0-9a-f]{64}$/, 'a real Monad transaction');

  // The balance is READ BACK from the token contract, not incremented by Prism.
  const after = await circles.getCircle(circle.circleId, creator.prismId);
  assert.equal(after.balance.amountAtomic, USD(100));
  assert.equal(after.balance.source, 'chain');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(100));
  assert.equal(fake.balanceOf(creator.accountAddress).toString(), USD(400), 'the contributor was debited');

  // Before/after reconciles: the recorded delta is the amount, and both ends came from the chain.
  assert.equal(result.contribution.balance.before, '0');
  assert.equal(result.contribution.balance.after, USD(100));
  assert.equal(result.contribution.balance.delta, USD(100));
});

test('contribute: reuses the existing Prism payment path rather than a contribution vault', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, creator, store, config } = stack;

  const prepared = await circles.prepareContribution({ circleId: circle.circleId, prismId: creator.prismId, amountAtomic: USD(100) });
  const operation = store.read().operations[prepared.paymentId];

  assert.equal(operation.kind, 'circle-contribution');
  assert.equal(getAddress(operation.env.recipient), getAddress(circle.safeAddress), 'the Circle Safe is the recipient');
  assert.equal(operation.env.amount, USD(100));
  // The ERC-3009 authorization is addressed to the audited router, exactly as a personal payment is.
  assert.equal(
    getAddress(prepared.typedData.tokenAuthorization.message.to),
    getAddress(config.chain.paymentRouter)
  );
  assert.equal(prepared.asset.symbol, 'USDC');
});

test('contribute: a contribution re-labelled after signing does not reconcile', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, creator, store } = stack;

  const prepared = await circles.prepareContribution({ circleId: circle.circleId, prismId: creator.prismId, amountAtomic: USD(100) });
  // The contributor signed "$100 into Lagos Trip". Rewrite the amount on the row afterwards.
  store.mutate((d) => { d.circleContributions[prepared.contribution.contributionId].amount = USD(900); });

  const settled = await circles.submitContribution({
    circleId: circle.circleId, contributionId: prepared.contribution.contributionId, prismId: creator.prismId,
    prismSignature: await creator.account.signTypedData(revive(prepared.typedData.envelope)),
    tokenSignature: await creator.account.signTypedData(revive(prepared.typedData.tokenAuthorization))
  });

  assert.equal(settled.contribution.status, 'FAILED');
  assert.match(settled.contribution.failureReason, /not the amount this contribution recorded/);
});

test('contribute: a VIEWER cannot add money, and a stranger cannot see the Circle at all', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, creator } = stack;
  const viewer = await outsider(stack, { name: 'Viewer', handle: 'viewer' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: creator.prismId, prismId: viewer.prismId, role: 'VIEWER' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: viewer.prismId });

  await assert.rejects(
    () => circles.prepareContribution({ circleId: circle.circleId, prismId: viewer.prismId, amountAtomic: USD(10) }),
    /does not let you add money/
  );
  const stranger = await outsider(stack, { name: 'Stranger', handle: 'stranger' });
  await assert.rejects(
    () => circles.prepareContribution({ circleId: circle.circleId, prismId: stranger.prismId, amountAtomic: USD(10) }),
    /circle not found/
  );
});

// ===========================================================================
// Proposing a payment
// ===========================================================================

test('propose: the recipient comes from the Protected Alias Resolver, and the Safe transaction is fixed in shape', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, creator, config } = stack;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const tobi = stack.people[1];

  const payment = await proposeTo(stack, { circleId: circle.circleId, from: creator, to: tobi, dollars: 40 });

  assert.equal(payment.lifecycle, 'APPROVAL_PENDING');
  assert.equal(payment.amount, USD(40));
  assert.equal(payment.asset, 'USDC');
  assert.equal(payment.memo, 'Dinner');
  assert.equal(payment.recipientPrismId, tobi.prismId);
  assert.equal(getAddress(payment.recipientAccount), getAddress(tobi.accountAddress));

  // to = the officially configured USDC contract. value = 0. data = USDC.transfer(recipient, amount).
  assert.equal(getAddress(payment.safeTransaction.to), getAddress(config.chain.usdc));
  assert.equal(payment.safeTransaction.value, '0');
  assert.equal(payment.safeTransaction.operation, 0, 'never delegatecall');
  assert.equal(
    payment.safeTransaction.data,
    encodeFunctionData({
      abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'transfer', args: [getAddress(tobi.accountAddress), BigInt(USD(40))]
    })
  );
  // Neutral gas refund: no second, unreviewed payment hiding inside the first.
  assert.equal(payment.safeTransaction.gasPrice, '0');
  assert.equal(payment.safeTransaction.baseGas, '0');
  assert.equal(payment.safeTransaction.gasToken, '0x0000000000000000000000000000000000000000');
  assert.equal(payment.safeTransaction.refundReceiver, '0x0000000000000000000000000000000000000000');

  assert.equal(payment.requiredApprovals, 2, 'the LIVE on-chain threshold');
  assert.equal(payment.collectedApprovals, 0);
  assert.equal(payment.binding.ok, true);
  assert.deepEqual(payment.trace.map((t) => t.state), ['CREATED', 'RESOLVING', 'RESOLVED', 'PROPOSED']);
});

test('propose: no caller can supply a target or calldata — the only payment intent is a USDC transfer', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, safeAdapter, circle } = stack;

  // The service method that turns an intent into a Safe call takes no target from anywhere. The
  // only shapes it accepts are Circles' own four intents; anything else is refused outright.
  await assert.rejects(
    () => safeAdapter.buildTransaction({ safeAddress: circle.safeAddress, intent: { kind: 'ARBITRARY', to: '0x' + '11'.repeat(20), data: '0xdeadbeef' }, nonce: 0 }),
    /unknown circle intent/
  );
  // And `proposePayment` itself has no parameter through which a target could arrive.
  assert.equal(
    /to\s*:|target|calldata|data\s*:/.test(circles.proposePayment.toString().split('\n')[0]),
    false,
    'proposePayment takes circleId, actor, resolution, amount and memo — nothing addressable'
  );
});

// ===========================================================================
// Threshold
// ===========================================================================

test('threshold: 1 of 2 cannot execute, 2 of 2 executes', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  const proposed = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });

  // --- 1 of 2 -------------------------------------------------------------
  const oneOfTwo = await approve(stack, circle.circleId, proposed, octane);
  assert.equal(oneOfTwo.payment.collectedApprovals, 1);
  assert.equal(oneOfTwo.payment.requiredApprovals, 2);
  assert.equal(oneOfTwo.payment.lifecycle, 'APPROVAL_PENDING');

  const blocked = await circles.executePayment({ circleId: circle.circleId, proposalId: proposed.proposalId, actorPrismId: octane.prismId });
  assert.equal(blocked.lifecycle, 'APPROVAL_PENDING');
  assert.match(blocked.blocked, /1 of 2 approvals/);
  assert.equal(fake.calls.executions.length, 0, 'nothing was broadcast');
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), '0', 'and no money moved');

  // --- 2 of 2 -------------------------------------------------------------
  const twoOfTwo = await approve(stack, circle.circleId, proposed, tobi);
  assert.equal(twoOfTwo.payment.collectedApprovals, 2);
  assert.equal(twoOfTwo.payment.lifecycle, 'APPROVED');

  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: proposed.proposalId, actorPrismId: octane.prismId });
  assert.equal(done.lifecycle, 'COMPLETED');
  assert.equal(done.evidence.safeExecutionSuccess, true);
  assert.equal(getAddress(done.evidence.transfer.from), getAddress(circle.safeAddress));
  assert.equal(getAddress(done.evidence.transfer.to), getAddress(zainab.accountAddress));
  assert.equal(done.evidence.transfer.amountAtomic, USD(40));
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40));
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(460));

  // Balance before/after reconciles against the amount that was approved.
  assert.equal(done.balance.before, USD(500));
  assert.equal(done.balance.after, USD(460));
  assert.equal(done.balance.delta, `-${USD(40)}`);

  assert.deepEqual(
    done.trace.map((x) => x.state),
    ['CREATED', 'RESOLVING', 'RESOLVED', 'PROPOSED', 'APPROVAL_PENDING', 'APPROVED', 'SUBMITTED', 'CONFIRMED', 'RECONCILED', 'COMPLETED']
  );
});

test('threshold: the required count comes from the Safe, never from a Prism row', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, store, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  const proposed = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, proposed, octane);

  // Rewrite Prism's own copies to claim this is already satisfied.
  store.mutate((d) => {
    d.circleProposals[proposed.proposalId].requiredApprovals = 1;
    d.circleProposals[proposed.proposalId].collectedApprovals = 99;
    d.circles[circle.circleId].threshold = 1;
  });

  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: proposed.proposalId, prismId: octane.prismId });
  assert.equal(view.requiredApprovals, 2, 'the Safe still requires two');
  assert.equal(view.collectedApprovals, 1, 'counted from signatures, not from the row');

  const blocked = await circles.executePayment({ circleId: circle.circleId, proposalId: proposed.proposalId, actorPrismId: octane.prismId });
  assert.match(blocked.blocked, /1 of 2 approvals/);
  assert.equal(fake.calls.executions.length, 0);
  await approve(stack, circle.circleId, proposed, tobi);
});

// ===========================================================================
// Who may approve
// ===========================================================================

test('approval: a signature from someone who is not an admin never counts', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, store, fake } = stack;
  const [octane] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);
  const mallory = await outsider(stack, { name: 'Mallory', handle: 'mallory' });

  const proposed = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, proposed, octane);

  const forged = await mallory.account.sign({ hash: proposed.safeTxHash });

  // (a) through the API: a stranger cannot even reach the approval path.
  await assert.rejects(
    () => circles.approvePayment({
      circleId: circle.circleId, proposalId: proposed.proposalId, prismId: mallory.prismId, signature: forged
    }),
    /circle not found/
  );

  // (b) past the API: a perfectly valid signature from a non-owner, written straight into Prism's
  // database, still does not count — approvals are re-verified against the LIVE owner set.
  store.mutate((d) => {
    d.circleApprovals[`${proposed.proposalId}:${mallory.prismId}`] = {
      proposalId: proposed.proposalId, prismId: mallory.prismId,
      authorityAddress: getAddress(mallory.accountAddress), signatureType: 'ECDSA',
      signature: forged, approvedAt: new Date().toISOString()
    };
  });

  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: proposed.proposalId, prismId: octane.prismId });
  assert.equal(view.collectedApprovals, 1, 'still one — the stranger is not an owner');
  const blocked = await circles.executePayment({ circleId: circle.circleId, proposalId: proposed.proposalId, actorPrismId: octane.prismId });
  assert.match(blocked.blocked, /1 of 2 approvals/);
  assert.equal(fake.calls.executions.length, 0);
});

test('approval: an approval from an admin removed on-chain stops counting, and the payment un-approves itself', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 3 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;
  const [octane, tobi, kemi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  const proposed = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, proposed, octane);
  const ready = await approve(stack, circle.circleId, proposed, tobi);
  assert.equal(ready.payment.lifecycle, 'APPROVED', '2 of 3, ready to send');

  // The Circle removes Tobi through an approved owner change. Prism is not told; it simply reads.
  fake.forceOwners(circle.safeAddress, [octane.accountAddress, kemi.accountAddress], 2);

  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: proposed.proposalId, prismId: octane.prismId });
  assert.equal(view.collectedApprovals, 1, "Tobi's signature is still valid, but he is no longer an owner");
  assert.equal(view.lifecycle, 'APPROVAL_PENDING', 'APPROVED reverts by itself');

  const blocked = await circles.executePayment({ circleId: circle.circleId, proposalId: proposed.proposalId, actorPrismId: octane.prismId });
  assert.match(blocked.blocked, /1 of 2 approvals/);
  assert.equal(fake.calls.executions.length, 0);
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), '0');
});

test('approval: approving twice is refused, and could not have raised the count anyway', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;
  const [octane] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  const proposed = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, proposed, octane);

  await assert.rejects(() => approve(stack, circle.circleId, proposed, octane), /already approved/);

  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: proposed.proposalId, prismId: octane.prismId });
  assert.equal(view.collectedApprovals, 1);
  assert.equal(fake.calls.executions.length, 0);
});

// ===========================================================================
// Mutation security — changing any bound field voids the approvals
// ===========================================================================

/** Approve a payment to the threshold, then hand the caller a tampering hook. */
async function approvedPayment(t, mutate) {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);
  const mallory = await outsider(stack, { name: 'Mallory', handle: 'mallory' });

  const proposed = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, proposed, octane);
  await approve(stack, circle.circleId, proposed, tobi);

  stack.store.mutate((d) => mutate(d.circleProposals[proposed.proposalId], { stack, mallory, zainab }));
  return { ...stack, proposed, octane, tobi, zainab, mallory };
}

/** Every bound field, mutated after approval, must void the approvals and stop the payment. */
for (const [name, mutate, expected] of [
  [
    'recipient',
    (p, { mallory }) => {
      // The attack in its purest form: rewrite the calldata so the money goes somewhere else.
      p.safeTransaction.data = encodeFunctionData({
        abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
        functionName: 'transfer', args: [getAddress(mallory.accountAddress), BigInt(USD(40))]
      });
      p.recipientAccount = getAddress(mallory.accountAddress);
    },
    /not the digest of these fields/
  ],
  [
    'amount',
    (p) => {
      p.safeTransaction.data = encodeFunctionData({
        abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
        functionName: 'transfer', args: [getAddress(p.recipientAccount), BigInt(USD(480))]
      });
      p.amount = USD(480);
    },
    /not the digest of these fields/
  ],
  [
    'the USDC target',
    (p) => { p.safeTransaction.to = getAddress(`0x${'ba'.repeat(20)}`); p.token = getAddress(`0x${'ba'.repeat(20)}`); },
    /not this deployment's USDC/
  ],
  [
    'the Safe nonce',
    (p) => { p.safeTransaction.nonce = '7'; p.safeNonce = '7'; },
    /not the digest of these fields/
  ],
  [
    'the Safe',
    (p) => { p.safeAddress = getAddress(`0x${'5a'.repeat(20)}`); },
    /not the Safe this payment was approved for/
  ],
  [
    'the chain',
    (p) => { p.chainId = '1'; },
    /not the chain this payment was approved for/
  ]
]) {
  test(`mutation: changing ${name} after approval invalidates it`, async (t) => {
    const stack = await approvedPayment(t, mutate);
    const { circles, circle, proposed, octane, tobi, fake, mallory } = stack;

    // The approval that was on file is void: it cannot be re-affirmed onto the mutated payment.
    const signature = await tobi.account.sign({ hash: proposed.safeTxHash });
    await assert.rejects(
      () => circles.approvePayment({
        circleId: circle.circleId, proposalId: proposed.proposalId, prismId: tobi.prismId, signature
      }),
      expected
    );
    // And nothing is sent.
    await assert.rejects(
      () => circles.executePayment({ circleId: circle.circleId, proposalId: proposed.proposalId, actorPrismId: octane.prismId }),
      /will not be sent|can no longer be approved/
    );
    const view = await circles.getPayment({ circleId: circle.circleId, proposalId: proposed.proposalId, prismId: octane.prismId });
    assert.equal(view.lifecycle, 'INVALIDATED');
    assert.equal(view.binding.ok, false);
    assert.equal(fake.calls.executions.length, 0);
    assert.equal(fake.balanceOf(mallory.accountAddress).toString(), '0');
  });
}

test('mutation: the six bound fields are exactly the fields a Safe signature covers', async () => {
  const { APPROVAL_BOUND_FIELDS } = await import('../src/circles/model.js');
  assert.deepEqual([...APPROVAL_BOUND_FIELDS].sort(), [
    'amount', 'chainId', 'recipientAccount', 'safeAddress', 'safeNonce', 'token'
  ]);
});

// ===========================================================================
// Replay, relayer, and evidence
// ===========================================================================

test('nonce: a payment built against a nonce the Safe has already used cannot be replayed', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  // Two payments proposed against the SAME Safe nonce, before either has executed. The amounts
  // differ so these really are two transactions: a memo lives only in Prism and is not part of what
  // is signed, so two proposals identical on-chain would share one digest — correctly.
  const first = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  const second = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 25, memo: 'Taxi' });
  assert.equal(first.safeNonce, second.safeNonce, 'both were built at nonce 0');
  assert.notEqual(first.safeTxHash, second.safeTxHash, 'and they are different transactions');

  for (const payment of [first, second]) {
    await approve(stack, circle.circleId, payment, octane);
    await approve(stack, circle.circleId, payment, tobi);
  }

  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: first.proposalId, actorPrismId: octane.prismId });
  assert.equal(done.lifecycle, 'COMPLETED');

  await assert.rejects(
    () => circles.executePayment({ circleId: circle.circleId, proposalId: second.proposalId, actorPrismId: octane.prismId }),
    /nonce that has already been used/
  );
  const stale = await circles.getPayment({ circleId: circle.circleId, proposalId: second.proposalId, prismId: octane.prismId });
  assert.equal(stale.lifecycle, 'EXPIRED');
  assert.equal(fake.calls.executions.length, 1, 'exactly one execution reached the Safe');
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40), 'paid once, not twice');
});

test('nonce: re-executing a completed payment reconciles instead of broadcasting again', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  const payment = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, payment, octane);
  await approve(stack, circle.circleId, payment, tobi);
  await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });

  const again = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(again.lifecycle, 'COMPLETED');
  assert.equal(fake.calls.executions.length, 1);
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40));
});

test('nonce: two simultaneous sends produce exactly one broadcast', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  const payment = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, payment, octane);
  await approve(stack, circle.circleId, payment, tobi);

  // Two admins tap "send" at the same moment. Both pass every check; only one may broadcast.
  const send = () => circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  const [first, second] = await Promise.all([send(), send()]);

  const outcomes = [first, second];
  assert.equal(fake.calls.executions.length, 1, 'exactly one execTransaction reached the Safe');
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40), 'paid once');
  assert.ok(
    outcomes.some((o) => o.lifecycle === 'COMPLETED'),
    'one call completed the payment'
  );
  assert.ok(
    outcomes.every((o) => o.lifecycle === 'COMPLETED' || o.blocked === 'this payment is already being sent'),
    'the other either joined the completed payment or was told it is already being sent'
  );
});

test('relayer: a relayer that rewrites the transaction cannot redirect the funds', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, safeAdapter, store, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);
  const mallory = await outsider(stack, { name: 'Mallory', handle: 'mallory' });

  const payment = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, payment, octane);
  await approve(stack, circle.circleId, payment, tobi);

  // A hostile relayer holds the two genuine approvals and submits a transaction of its own choosing.
  const approvals = Object.values(store.read().circleApprovals).filter((a) => a.proposalId === payment.proposalId);
  const redirected = {
    to: getAddress(stack.config.chain.usdc), value: 0n, operation: 0,
    data: encodeFunctionData({
      abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'transfer', args: [getAddress(mallory.accountAddress), BigInt(USD(480))]
    }),
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: 0n
  };

  // The Safe recomputes the digest from what it was actually handed. The signatures authorize a
  // different transaction, so they recover to addresses that are not owners.
  await assert.rejects(
    () => safeAdapter.executeTransaction({ safeAddress: circle.safeAddress, tx: redirected, approvals }),
    /GS026/
  );
  await assert.rejects(
    () => safeAdapter.simulateExecution({ safeAddress: circle.safeAddress, tx: redirected, approvals })
      .then((r) => { if (!r.ok) throw new Error(r.reason); }),
    /GS026/
  );
  assert.equal(fake.balanceOf(mallory.accountAddress).toString(), '0');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(500), 'the Circle is untouched');

  // The honest transaction, with the same signatures, still works.
  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(done.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40));
});

test('evidence: a simulation that fails is never broadcast', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2, funded: USD(10) });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(10) });
  const zainab = await outsider(stack);

  // Fully approved, but the Circle does not hold enough USDC to pay it.
  const payment = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 400 });
  assert.equal(payment.sufficientBalance, false, 'stated up front, not hidden');
  await approve(stack, circle.circleId, payment, octane);
  await approve(stack, circle.circleId, payment, tobi);

  const result = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(result.simulation.ok, false);
  assert.match(result.blocked, /was not sent because it would fail/);
  assert.equal(result.lifecycle, 'APPROVED', 'still approved, simply not sent');
  assert.equal(fake.calls.executions.length, 0, 'nothing reached the network');
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), '0');
});

test('evidence: a receipt with no USDC Transfer never becomes COMPLETED', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  const payment = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, payment, octane);
  await approve(stack, circle.circleId, payment, tobi);

  // Broadcast, but the receipt has not arrived. "Submitted" is never "completed".
  fake.knobs.receiptPending = true;
  const confirming = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(confirming.lifecycle, 'CONFIRMING');
  assert.match(confirming.executionTxHash, /^0x[0-9a-f]{64}$/);

  // Now the receipt arrives — successful, with the Safe's ExecutionSuccess, but the USDC Transfer
  // is missing. Prism must report a failure with a reason, not round it up.
  fake.knobs.receiptPending = false;
  const receipt = fake.receiptFor(confirming.executionTxHash);
  receipt.logs = receipt.logs.filter((log) => getAddress(log.address) !== getAddress(stack.config.chain.usdc));

  const reconciled = await circles.reconcilePayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(reconciled.lifecycle, 'FAILED');
  assert.match(reconciled.failureReason, /no USDC Transfer from this Circle to the reviewed recipient/);
});

test('evidence: a payment hand-marked COMPLETED in the database reads back as INVALIDATED', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, store, fake } = stack;
  const [octane] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);

  const payment = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });

  // The most direct forgery available to a compromised backend: say it happened.
  store.mutate((d) => {
    const p = d.circleProposals[payment.proposalId];
    p.lifecycle = 'COMPLETED';
    p.status = 'EXECUTED';
    p.executionTxHash = `0x${'ab'.repeat(32)}`;
    p.executedAt = new Date().toISOString();
  });

  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(view.lifecycle, 'INVALIDATED');
  assert.equal(view.storedLifecycle, 'COMPLETED', 'what it claimed is still visible');
  assert.match(view.binding.reasons[0], /no on-chain evidence/);
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), '0');
});

// ===========================================================================
// Continuity — a Circle payment is a Prism payment
// ===========================================================================

test('continuity: a recipient whose account changed without an authenticated rotation blocks the payment', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, creator, store, fake } = stack;
  const [octane, tobi] = stack.people;
  await contribute({ circles, circleId: circle.circleId, member: creator, amountAtomic: USD(500) });
  const zainab = await outsider(stack);
  const mallory = await outsider(stack, { name: 'Mallory', handle: 'mallory' });

  const payment = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: zainab, dollars: 40 });
  await approve(stack, circle.circleId, payment, octane);

  // Zainab's identity now points at a different account, with no version advance to authenticate it.
  store.mutate((d) => { d.identities[zainab.prismId].accountAddress = getAddress(mallory.accountAddress); });

  await assert.rejects(
    () => approve(stack, circle.circleId, payment, tobi),
    /recipient identity has changed|resolves to a different person/
  );
  await assert.rejects(
    () => circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId }),
    /recipient identity has changed|resolves to a different person/
  );
  assert.equal(fake.calls.executions.length, 0);
  assert.equal(fake.balanceOf(mallory.accountAddress).toString(), '0');
});

// ===========================================================================
// End to end
// ===========================================================================

test('end to end: contribute, propose, approve 2 of 2, execute, and the ledger reconciles', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const { circles, circle, fake } = stack;
  const [octane, tobi] = stack.people;
  stack.fake.setBalance(tobi.accountAddress, USD(300));
  const airbnb = await outsider(stack, { name: 'Airbnb Host', handle: 'host' });

  await contribute({ circles, circleId: circle.circleId, member: octane, amountAtomic: USD(500) });
  await contribute({ circles, circleId: circle.circleId, member: tobi, amountAtomic: USD(300) });

  const funded = await circles.getCircle(circle.circleId, octane.prismId);
  assert.equal(funded.balance.amountAtomic, USD(800));

  const payment = await proposeTo(stack, { circleId: circle.circleId, from: octane, to: airbnb, dollars: 480, memo: 'AIRBNB' });
  await approve(stack, circle.circleId, payment, octane);
  await approve(stack, circle.circleId, payment, tobi);
  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: tobi.prismId });

  assert.equal(done.lifecycle, 'COMPLETED');
  assert.equal(done.memo, 'AIRBNB');

  // Contributions in, one payment out, and the Circle's own balance agrees with the arithmetic.
  const contributions = circles.listContributions(circle.circleId, octane.prismId);
  const contributed = contributions.contributions.reduce((sum, c) => sum + BigInt(c.amount), 0n);
  const paid = (await circles.listPayments(circle.circleId, octane.prismId)).payments
    .filter((p) => p.lifecycle === 'COMPLETED')
    .reduce((sum, p) => sum + BigInt(p.amount), 0n);

  const finalBalance = (await circles.getCircle(circle.circleId, octane.prismId)).balance;
  assert.equal(BigInt(finalBalance.amountAtomic), contributed - paid);
  assert.equal(finalBalance.amountAtomic, USD(320));
  assert.equal(fake.balanceOf(airbnb.accountAddress).toString(), USD(480));
  assert.equal(fake.balanceOf(octane.accountAddress).toString(), '0');
});

/** Typed data crosses the API as JSON; numeric fields come back as strings. viem wants bigints. */
function revive(typed) {
  const message = { ...typed.message };
  for (const field of typed.types[typed.primaryType] ?? []) {
    if (/^uint/.test(field.type)) message[field.name] = BigInt(message[field.name]);
  }
  return { ...typed, domain: { ...typed.domain, chainId: Number(typed.domain.chainId) }, message };
}
