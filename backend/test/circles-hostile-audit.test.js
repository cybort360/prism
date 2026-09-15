import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, encodeFunctionData, keccak256, toHex } from 'viem';
import { circleStack, makeIdentity, acknowledgement, contribute, resolveRecipient, ALLOWANCE_MODULE } from './circles-harness.js';
import { readFileSync } from 'node:fs';
import { safeTransaction, safeTxHash, ZERO_ADDRESS } from '../src/circles/safeEncoding.js';

/**
 * HOSTILE AUDIT — Prism Circles.
 *
 * The posture of this file is that **Circle funds can be stolen until a test proves otherwise**.
 * Every test below is an attack, not a feature check, and each one is pushed to the layer that
 * actually decides:
 *
 *  - where the **Safe** decides (signatures, nonce, digest), the attack is submitted to the Safe
 *    itself through the adapter, bypassing CircleService entirely. The harness Safe implements
 *    Safe's real `execTransaction` rules — it recomputes the digest from the arguments it was
 *    handed, recovers every signature, requires ascending owner order, requires each signer to be
 *    an owner *right now*, and enforces its own nonce — so a rejection here is a rejection by a
 *    Safe, not by a Prism `if`.
 *  - where **Prism** decides (who may propose, what a view reports, what the app will sign), the
 *    attack goes through the service, and where useful the backend's own database row is edited
 *    first, to model a compromised backend rather than a polite one.
 *
 * The contract-level half of this matrix runs against Safe's REAL deployed bytecode and is not
 * re-asserted against a JavaScript imitation here; each test names its counterpart. See
 * `contracts/test/circles/CircleSafeOwnerCompat.t.sol` (a Monad fork, real Safe v1.4.1) and
 * `contracts/test/AllowanceModuleCompat.t.sol` (Safe's canonical Allowance Module runtime).
 *
 * Amounts are USDC atomic units (6 decimals): $100 is 100_000000.
 */

const USD = (dollars) => String(BigInt(Math.round(dollars * 100)) * 10_000n);
const HOSTILE_TOKEN = getAddress(`0x${'ba'.repeat(20)}`);

const TRANSFER_ABI = [{
  name: 'transfer', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }]
}];
const transferData = (to, atomic) =>
  encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [getAddress(to), BigInt(atomic)] });

/**
 * The audit fixture: a 2-of-3 Lagos Trip funded with $500, plus an outsider to pay and an attacker.
 * Sarah is a SPENDER (no Safe authority at all) and Mallory is in no Circle whatsoever.
 */
async function lagosTrip({ threshold = 2, admins = 3, funded = USD(500), limits = false } = {}) {
  const stack = await circleStack({ withPayments: true, withLimits: limits });
  const people = [];
  for (const [name, handle] of [['Octane', 'octane'], ['Tobi', 'tobi'], ['Jayson', 'jayson']].slice(0, admins)) {
    people.push(await makeIdentity(stack.identityService, { name, handle }));
  }
  const [octane, ...rest] = people;
  const warnings = threshold === admins && admins >= 2 ? ['NO_SPARE_AUTHORITY']
    : (threshold === 1 && admins >= 2 ? ['ANY_ADMIN_ALONE'] : []);
  const circle = await stack.circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: rest.map((p) => ({ prismId: p.prismId })), threshold,
    policyAcknowledgement: acknowledgement({ threshold, adminCount: admins, warnings })
  });
  assert.equal(circle.status, 'ACTIVE');

  stack.fake.setBalance(octane.accountAddress, USD(2000));
  if (funded !== '0') await contribute({ circles: stack.circles, circleId: circle.circleId, member: octane, amountAtomic: funded });

  const zainab = await makeIdentity(stack.identityService, { name: 'Zainab', handle: 'zainab' });
  const mallory = await makeIdentity(stack.identityService, { name: 'Mallory', handle: 'mallory' });
  const sarah = await makeIdentity(stack.identityService, { name: 'Sarah', handle: 'sarah' });
  return { ...stack, circle, people, octane, tobi: people[1], jayson: people[2], zainab, mallory, sarah };
}

async function propose(stack, { from, to, dollars, memo = 'Dinner' }) {
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: from.prismId, target: to });
  return stack.circles.proposePayment({
    circleId: stack.circle.circleId, actorPrismId: from.prismId, resolution, amountAtomic: USD(dollars), memo
  });
}

const approve = (stack, payment, admin) =>
  admin.account.sign({ hash: payment.safeTxHash }).then((signature) =>
    stack.circles.approvePayment({
      circleId: stack.circle.circleId, proposalId: payment.proposalId, prismId: admin.prismId, signature
    }));

/** The approval rows on file, in the shape the adapter hands to the Safe. */
const approvalsOf = (stack, proposalId) =>
  Object.values(stack.store.read().circleApprovals ?? {}).filter((a) => a.proposalId === proposalId);

/** Rebuild a Safe transaction object (bigints) from a stored proposal. */
const txOf = (proposal, overrides = {}) => safeTransaction({
  to: overrides.to ?? proposal.safeTransaction.to,
  value: BigInt(overrides.value ?? proposal.safeTransaction.value),
  data: overrides.data ?? proposal.safeTransaction.data,
  operation: Number(overrides.operation ?? proposal.safeTransaction.operation),
  safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS,
  nonce: BigInt(overrides.nonce ?? proposal.safeTransaction.nonce)
});

const stored = (stack, proposalId) => stack.store.read().circleProposals[proposalId];

// ===========================================================================
// A. AUTHORITY — CIR-001 … CIR-010
// ===========================================================================

test('CIR-001: a non-admin signature is refused by Prism, ignored in the count, and rejected by the Safe', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, mallory, sarah, safeAdapter, fake } = stack;
  const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 40 });

  // 1. Mallory is in no Circle. A Circle she cannot see is not a Circle she can approve.
  const mallorySignature = await mallory.account.sign({ hash: payment.safeTxHash });
  await assert.rejects(
    () => circles.approvePayment({
      circleId: circle.circleId, proposalId: payment.proposalId, prismId: mallory.prismId, signature: mallorySignature
    }),
    /circle not found/
  );

  // 2. Sarah IS a member (invited as a SPENDER) but holds no Safe authority.
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, role: 'SPENDER' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: sarah.prismId });
  const sarahSignature = await sarah.account.sign({ hash: payment.safeTxHash });
  await assert.rejects(
    () => circles.approvePayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: sarah.prismId, signature: sarahSignature }),
    /only an admin/
  );

  // 3. A compromised backend writes the approval row anyway. It still does not count: approvals are
  //    re-verified against the Safe's live owner set on every read.
  stack.store.mutate((d) => {
    d.circleApprovals[`${payment.proposalId}:${sarah.prismId}`] = {
      proposalId: payment.proposalId, prismId: sarah.prismId,
      authorityAddress: getAddress(sarah.accountAddress), signatureType: 'ECDSA',
      signature: sarahSignature, approvedAt: new Date().toISOString()
    };
  });
  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(view.collectedApprovals, 0, 'a signature from a non-owner is not an approval');

  // 4. And the Safe itself refuses it. (Fork counterpart: CircleSafeOwnerCompat test_E_WrongP256Signer_Fails.)
  await assert.rejects(
    () => safeAdapter.executeTransaction({
      safeAddress: circle.safeAddress,
      tx: txOf(stored(stack, payment.proposalId)),
      approvals: [{ authorityAddress: getAddress(sarah.accountAddress), signature: sarahSignature }]
    }),
    /GS02[06]/
  );
  assert.equal(fake.calls.executions.length, 0);
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(500), 'the Circle is untouched');
});

test('CIR-002: one signature on a 2-of-3 Circle cannot execute, at Prism and at the Safe', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 3 });
  t.after(stack.restoreProvider);
  const { circles, circle, octane, safeAdapter, fake } = stack;

  const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 120 });
  await approve(stack, payment, octane);

  const blocked = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.match(blocked.blocked, /1 of 2 approvals/);
  assert.equal(blocked.lifecycle, 'APPROVAL_PENDING');
  assert.equal(blocked.executionTxHash, null);
  assert.equal(fake.calls.executions.length, 0, 'nothing was broadcast');

  // Straight to the Safe with the one genuine signature: Safe counts them itself.
  // (Fork counterpart: CircleSafeOwnerCompat test_D_TwoOfTwo_RejectsASingleApproval.)
  await assert.rejects(
    () => safeAdapter.executeTransaction({
      safeAddress: circle.safeAddress,
      tx: txOf(stored(stack, payment.proposalId)),
      approvals: approvalsOf(stack, payment.proposalId)
    }),
    /GS020/
  );
  assert.equal(fake.balanceOf(stack.zainab.accountAddress).toString(), '0');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(500));
});

/**
 * CIR-003 / CIR-004 / CIR-005 — the payment is altered AFTER the first admin has approved.
 *
 * Two separate claims are checked for each field, and the second is the one that matters:
 *   (a) Prism refuses to collect a second approval onto the altered payment, and will not send it;
 *   (b) even with Prism removed from the picture, the SAFE refuses — the first admin's signature
 *       covers a digest the altered transaction does not produce.
 */
for (const [id, field, mutate, expected] of [
  ['CIR-003', 'the recipient', (p, { mallory }) => {
    p.safeTransaction.data = transferData(mallory.accountAddress, p.amount);
    p.recipientAccount = getAddress(mallory.accountAddress);
  }, /not the digest of these fields/],
  ['CIR-004', 'the amount', (p) => {
    p.safeTransaction.data = transferData(p.recipientAccount, USD(480));
    p.amount = USD(480);
  }, /not the digest of these fields/],
  ['CIR-005', 'the USDC target', (p) => {
    p.safeTransaction.to = HOSTILE_TOKEN;
    p.token = HOSTILE_TOKEN;
  }, /not this deployment's USDC/]
]) {
  test(`${id}: changing ${field} after the first approval voids it`, async (t) => {
    const stack = await lagosTrip();
    t.after(stack.restoreProvider);
    const { circles, circle, octane, tobi, mallory, safeAdapter, fake } = stack;

    const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 40 });
    await approve(stack, payment, octane);
    const firstApproval = approvalsOf(stack, payment.proposalId);
    assert.equal(firstApproval.length, 1);

    stack.store.mutate((d) => mutate(d.circleProposals[payment.proposalId], { mallory }));

    // (a) Prism will not collect a second approval onto it, and will not send it.
    const tobiSignature = await tobi.account.sign({ hash: payment.safeTxHash });
    await assert.rejects(
      () => circles.approvePayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: tobi.prismId, signature: tobiSignature }),
      expected
    );
    await assert.rejects(
      () => circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId }),
      /will not be sent|can no longer be approved/
    );
    const view = await circles.getPayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
    assert.equal(view.lifecycle, 'INVALIDATED');

    // (b) With Prism bypassed entirely: the altered transaction, the genuine first signature, and a
    //     second genuine signature over the ORIGINAL digest — the Safe still refuses, because the
    //     digest it computes from what it was handed is not the digest either owner signed.
    const altered = stored(stack, payment.proposalId);
    await assert.rejects(
      () => safeAdapter.executeTransaction({
        safeAddress: circle.safeAddress,
        tx: txOf(altered),
        approvals: [...firstApproval, { authorityAddress: getAddress(tobi.accountAddress), signature: tobiSignature }]
      }),
      /GS02[06]/
    );
    assert.equal(fake.calls.executions.length, 0);
    assert.equal(fake.balanceOf(mallory.accountAddress).toString(), '0');
    assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(500));
  });
}

test('CIR-006: a completed Safe transaction cannot be replayed', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, zainab, safeAdapter, fake } = stack;

  const payment = await propose(stack, { from: octane, to: zainab, dollars: 40 });
  await approve(stack, payment, octane);
  await approve(stack, payment, tobi);
  const approvals = approvalsOf(stack, payment.proposalId);
  const executed = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(executed.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40));

  // 1. Through Prism: a second "send" reconciles the settled payment, it does not broadcast again.
  const again = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(again.lifecycle, 'COMPLETED');
  assert.equal(again.executionTxHash, executed.executionTxHash, 'the same transaction, not a new one');
  assert.equal(fake.calls.executions.length, 1, 'exactly one execution ever happened');

  // 2. Bypassing Prism: the exact same transaction and the exact same two genuine signatures.
  //    The Safe has consumed that nonce, so it now hashes with a different one and the signatures
  //    do not verify. (Fork counterpart: CircleSafeOwnerCompat test_E_ReplayOfExecutedTransaction_Fails.)
  await assert.rejects(
    () => safeAdapter.executeTransaction({ safeAddress: circle.safeAddress, tx: txOf(stored(stack, payment.proposalId)), approvals }),
    /GS02[06]/
  );
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40), 'paid exactly once');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(460));
});

test('CIR-007: a payment built against a stale Safe nonce is refused, and the Safe refuses it too', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, safeAdapter, fake } = stack;

  const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 40 });
  await approve(stack, payment, octane);
  await approve(stack, payment, tobi);
  const approvals = approvalsOf(stack, payment.proposalId);

  // The Safe moves on without Prism — another client executed something, or an owner did.
  fake.bumpNonce(circle.safeAddress, Number(payment.safeNonce) + 1);

  await assert.rejects(
    () => circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId }),
    /nonce that has already been used/
  );
  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(view.lifecycle, 'EXPIRED');

  // (Fork counterpart: CircleSafeOwnerCompat test_E_WrongSafeNonce_Fails.)
  await assert.rejects(
    () => safeAdapter.executeTransaction({ safeAddress: circle.safeAddress, tx: txOf(stored(stack, payment.proposalId)), approvals }),
    /GS02[06]/
  );
  assert.equal(fake.calls.executions.length, 0);
});

test('CIR-008: a removed admin\'s approval stops counting, and authority is re-read before every send', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 3 });
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, jayson, safeAdapter, fake } = stack;

  const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 40 });
  await approve(stack, payment, octane);
  await approve(stack, payment, tobi);
  const approvals = approvalsOf(stack, payment.proposalId);
  const ready = await circles.getPayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(ready.lifecycle, 'APPROVED', 'two of three, and ready');

  // Tobi stops being an owner on-chain, out from under Prism. Nobody tells the backend.
  fake.forceOwners(circle.safeAddress, [octane.accountAddress, jayson.accountAddress], 2);

  const after = await circles.getPayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(after.collectedApprovals, 1, 'his signature stopped counting by itself');
  assert.equal(after.lifecycle, 'APPROVAL_PENDING');

  const blocked = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.match(blocked.blocked, /1 of 2 approvals/, 'live authority is re-read, never assumed');
  assert.equal(fake.calls.executions.length, 0);

  // And the Safe agrees: a signature from someone who is not an owner right now is not an approval.
  await assert.rejects(
    () => safeAdapter.executeTransaction({ safeAddress: circle.safeAddress, tx: txOf(stored(stack, payment.proposalId)), approvals }),
    /GS026/
  );

  // The Circle is not stuck: the remaining admins can still approve and send.
  const jaysonSignature = await jayson.account.sign({ hash: payment.safeTxHash });
  await circles.approvePayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: jayson.prismId, signature: jaysonSignature });
  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(done.lifecycle, 'COMPLETED');
  assert.equal(fake.balanceOf(stack.zainab.accountAddress).toString(), USD(40));
});

test('CIR-009: when the backend claims the threshold is met and the Safe disagrees, the chain wins', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 3 });
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, mallory, fake } = stack;

  const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 40 });
  await approve(stack, payment, octane);

  // A compromised backend rewrites its own row to claim the payment is approved and ready, and
  // fabricates two approvals: one from an address that is not an owner at all, and — the sharper
  // attack — one claiming a REAL admin's authority address with a signature Tobi never produced.
  // Only re-verifying the signature itself catches the second one.
  stack.store.mutate((d) => {
    const p = d.circleProposals[payment.proposalId];
    p.collectedApprovals = 5;
    p.requiredApprovals = 1;
    p.lifecycle = 'APPROVED';
    p.status = 'READY';
    d.circleApprovals[`${payment.proposalId}:forged-outsider`] = {
      proposalId: payment.proposalId, prismId: mallory.prismId,
      authorityAddress: getAddress(mallory.accountAddress), signatureType: 'ECDSA',
      signature: `0x${'11'.repeat(65)}`, approvedAt: new Date().toISOString()
    };
    d.circleApprovals[`${payment.proposalId}:forged-admin`] = {
      proposalId: payment.proposalId, prismId: tobi.prismId,
      authorityAddress: getAddress(tobi.accountAddress), signatureType: 'ECDSA',
      signature: `0x${'22'.repeat(64)}1b`, approvedAt: new Date().toISOString()
    };
  });

  // Every number the view reports is recomputed from the chain and from verified signatures.
  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(view.requiredApprovals, 2, 'the required count comes from the Safe');
  assert.equal(view.collectedApprovals, 1, 'neither forged approval verifies — not even the one naming a real admin');
  assert.deepEqual(
    view.approvals.map((a) => getAddress(a.authorityAddress)),
    [getAddress(octane.accountAddress)],
    'only the signature a real admin actually produced is counted'
  );
  assert.equal(view.lifecycle, 'APPROVAL_PENDING');
  assert.equal(view.approvalsSource, 'verified signatures against the live owner set');

  const blocked = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.match(blocked.blocked, /1 of 2 approvals/);
  assert.equal(fake.calls.executions.length, 0, 'a backend that lies about approvals still cannot move money');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(500));
});

test('CIR-010: an altered safeTxHash is detectable from the approval payload alone', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane } = stack;

  const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 40 });

  // The payload the phone receives carries the ten fields the digest is over, plus the Safe and the
  // chain. Re-deriving the digest from those fields is what the device does before Face ID, and it
  // is the reason a backend cannot swap in a digest of its own: the payload contradicts itself.
  const recomputed = safeTxHash({
    chainId: payment.chainId, safeAddress: payment.safeAddress, tx: txOf(stored(stack, payment.proposalId))
  });
  assert.equal(recomputed.toLowerCase(), String(payment.safeTxHash).toLowerCase(),
    'the payload is self-describing: its digest is the digest of its own fields');

  // A backend that alters the digest produces a payload whose own fields disagree with it.
  const tampered = keccak256(toHex('a digest of the attacker\'s choosing'));
  assert.notEqual(tampered.toLowerCase(), recomputed.toLowerCase());

  // And a signature over that tampered digest is worthless: the Safe hashes the fields, not the
  // number it was handed.
  const signature = await octane.account.sign({ hash: tampered });
  await assert.rejects(
    () => stack.safeAdapter.executeTransaction({
      safeAddress: circle.safeAddress,
      tx: txOf(stored(stack, payment.proposalId)),
      approvals: [{ authorityAddress: getAddress(octane.accountAddress), signature }]
    }),
    /GS02[06]/
  );
  // Prism refuses it too, before the chain ever sees it.
  await assert.rejects(
    () => circles.approvePayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId, signature }),
    /different account than your Prism authority|not signed/
  );
});

// ===========================================================================
// B. SPENDING LIMITS — CIR-011 … CIR-017
// ===========================================================================

/** A Circle with limits available and Sarah holding a $100/day allowance. */
async function circleWithSarahsLimit({ dollars = 100, period = 'DAILY' } = {}) {
  const stack = await lagosTrip({ threshold: 2, admins: 2, funded: USD(500), limits: true });
  const { circles, circle, octane, tobi, sarah } = stack;
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, role: 'SPENDER' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: sarah.prismId });

  for (let step = 0; step < 5; step++) {
    const prepared = await circles.prepareSpendingLimit({
      circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId,
      amountAtomic: USD(dollars), period
    });
    if (prepared.complete) break;
    for (const admin of [octane, tobi]) {
      const signature = await admin.account.sign({ hash: prepared.safeTxHash });
      await circles.recordApproval({ circleId: circle.circleId, proposalId: prepared.proposalId, prismId: admin.prismId, signature });
    }
    await circles.executeGovernance({ circleId: circle.circleId, proposalId: prepared.proposalId, actorPrismId: octane.prismId });
  }
  return stack;
}

const spend = async (stack, { dollars, to, memo = 'Groceries' }) => {
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: stack.sarah.prismId, target: to });
  const prepared = await stack.circles.prepareSpend({
    circleId: stack.circle.circleId, actorPrismId: stack.sarah.prismId, resolution, amountAtomic: USD(dollars), memo
  });
  const signature = await stack.sarah.account.sign({ hash: prepared.transferHash });
  return { prepared, signature, submit: () => stack.circles.submitSpend({
    circleId: stack.circle.circleId, spendId: prepared.spend.spendId, prismId: stack.sarah.prismId, signature
  }) };
};

test('CIR-011: an old, vulnerable Allowance Module version fails the gate and limits stay unavailable', async () => {
  const { assertCircleLimitsAreSafe, config } = await import('../src/config.js');
  const saved = { enabled: config.circles.limitsEnabled, module: config.circles.allowanceModule };
  try {
    // v0.1.1 — the release actually deployed on Monad, and the one an unpinned install hands out.
    config.circles.limitsEnabled = true;
    config.circles.allowanceModule = '0xAA46724893dedD72658219405185Fb0Fc91e091C';
    const problems = assertCircleLimitsAreSafe([]);
    assert.ok(problems.length > 0, 'the startup gate refuses the old module');
    assert.ok(problems.join(' ').includes('1.0.0'), 'and says which version is required');
  } finally {
    config.circles.limitsEnabled = saved.enabled;
    config.circles.allowanceModule = saved.module;
  }

  // The runtime gate identifies the module by the CODE at the address, not by the address, so a
  // different contract sitting at the canonical address is refused as well.
  const stack = await circleStack({ withPayments: true, withLimits: true });
  try {
    const verdict = await stack.limitGate.verify();
    assert.equal(verdict.usable, true, 'the canonical runtime passes');
    assert.match(String(verdict.codeHash ?? verdict.reason ?? ''), /0x[0-9a-f]{8}|verified|canonical/i);
  } finally {
    stack.restoreProvider();
  }
});

test('CIR-012: a spend above the remaining limit is refused and routed to the Circle', async (t) => {
  const stack = await circleWithSarahsLimit({ dollars: 100 });
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, zainab, fake } = stack;

  // $101 against $100 available: refused, by a number read from the module on this call.
  await assert.rejects(
    () => spend(stack, { dollars: 101, to: zainab }),
    /above your \$100\.00 limit|ask the Circle to approve it instead/
  );

  // And the honest alternative is offered rather than a dead end: the same payment, routed to the
  // Circle for approval, with the limit that stopped it named.
  const preview = await circles.previewPayment({ circleId: circle.circleId, actorPrismId: sarah.prismId, amountAtomic: USD(101) });
  assert.equal(preview.route, 'THRESHOLD');
  assert.equal(preview.requiresApproval, true);
  assert.match(JSON.stringify(preview), /100\.00/, 'the answer names the limit rather than just refusing');

  // Cumulative, not per-transaction: $60 then $50 is $110 and the second one is refused too.
  await (await spend(stack, { dollars: 60, to: zainab })).submit();
  await assert.rejects(() => spend(stack, { dollars: 50, to: zainab }), /limit|available/);
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(60), 'only the in-limit spend moved');
});

test('CIR-013: a delegate authorization cannot be replayed', async (t) => {
  const stack = await circleWithSarahsLimit();
  t.after(stack.restoreProvider);
  const { circle, sarah, zainab, safeAdapter, fake } = stack;

  const first = await spend(stack, { dollars: 40, to: zainab });
  const done = await first.submit();
  assert.equal(done.spend.status, 'COMPLETED');
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40));

  // The same signature, submitted again straight at the module. Its nonce is spent.
  // (Contract counterpart, against Safe's real module runtime:
  //  AllowanceModuleCompat testTheSameTransferSignatureCannotBeReused.)
  await assert.rejects(
    () => safeAdapter.submitAllowanceTransfer({
      safeAddress: circle.safeAddress, recipient: zainab.accountAddress,
      amountAtomic: USD(40), delegate: getAddress(sarah.accountAddress), signature: first.signature
    }),
    /signature|nonce|delegate/i
  );
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40), 'paid exactly once');
});

test('CIR-014: a delegate whose access was revoked cannot spend, and Prism says so from the chain', async (t) => {
  const stack = await circleWithSarahsLimit();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, sarah, zainab, safeAdapter, fake } = stack;

  // A spend prepared and signed BEFORE the revoke — the most dangerous shape.
  const inFlight = await spend(stack, { dollars: 40, to: zainab });

  const revoke = await circles.prepareSpendingLimitRevoke({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId });
  for (const admin of [octane, tobi]) {
    const signature = await admin.account.sign({ hash: revoke.safeTxHash });
    await circles.recordApproval({ circleId: circle.circleId, proposalId: revoke.proposalId, prismId: admin.prismId, signature });
  }
  await circles.executeGovernance({ circleId: circle.circleId, proposalId: revoke.proposalId, actorPrismId: octane.prismId });
  assert.equal(fake.delegatesOf(circle.safeAddress).length, 0, 'the module no longer knows her');

  await assert.rejects(() => inFlight.submit(), /spending access|removed/i);
  await assert.rejects(() => spend(stack, { dollars: 10, to: zainab }), /do not have a spending limit|spending access/i);

  // (Contract counterpart: AllowanceModuleCompat testARemovedDelegateCannotSpend.)
  await assert.rejects(
    () => safeAdapter.submitAllowanceTransfer({
      safeAddress: circle.safeAddress, recipient: zainab.accountAddress,
      amountAtomic: USD(10), delegate: getAddress(sarah.accountAddress), signature: inFlight.signature
    }),
    /delegate|allowance|signature/i
  );
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), '0');
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(500), 'the Circle kept every cent');
});

test('CIR-015 / CIR-016 / CIR-017: a delegate has no surface for another token, owner management, or an approval', async (t) => {
  const stack = await circleWithSarahsLimit();
  t.after(stack.restoreProvider);
  const { circles, circle, sarah, safeAdapter } = stack;

  // CIR-015 — there is no token parameter anywhere on the limit surface. The token is taken from
  // configuration in every method, so "spend a different token" is not a request that can be made.
  const limitSurface = [
    circles.prepareSpendingLimit, circles.prepareSpendingLimitRevoke, circles.prepareSpend,
    circles.submitSpend, circles.previewPayment
  ];
  for (const method of limitSurface) {
    assert.ok(!/\btoken\b/.test(method.toString().split('\n')[0]), `${method.name} takes no token argument`);
  }
  const prepared = await circles.prepareSpend({
    circleId: circle.circleId, actorPrismId: sarah.prismId,
    resolution: resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: sarah.prismId, target: stack.zainab }),
    amountAtomic: USD(10), memo: 'x',
    // A caller trying to smuggle a token through anyway.
    token: HOSTILE_TOKEN
  });
  assert.equal(getAddress(prepared.spend.asset === 'USDC' ? stack.config.chain.usdc : ZERO_ADDRESS), getAddress(stack.config.chain.usdc));
  assert.notEqual(getAddress(stack.store.read().circleSpends[prepared.spend.spendId].token), HOSTILE_TOKEN);

  // CIR-016 / CIR-017 — the only Safe calls Prism will ever build are the eight Circle intents.
  // Owner management, an ERC-20 approval, or any other call is not expressible.
  for (const intent of [
    { kind: 'APPROVE', spender: HOSTILE_TOKEN, amountAtomic: USD(1000) },
    { kind: 'ARBITRARY', to: HOSTILE_TOKEN, data: '0xdeadbeef' },
    { kind: 'ADD_OWNER_DIRECT', owner: getAddress(stack.mallory.accountAddress) },
    { kind: 'SWAP_OWNER', owner: getAddress(stack.mallory.accountAddress) }
  ]) {
    await assert.rejects(
      () => safeAdapter.buildTransaction({ safeAddress: circle.safeAddress, intent, nonce: 0 }),
      /unknown circle intent/
    );
  }

  // And the module route carries no calldata at all: `executeAllowanceTransfer` moves a token amount
  // to a recipient, and that is the whole of what a delegate can cause.
  // (Contract counterparts, against the real module runtime: AllowanceModuleCompat
  //  testTheOnlyCallADelegateCanCauseIsAPlainTransfer, testADelegateCannotMakeAnArbitrarySafeCall,
  //  testADelegateCannotChangeTheOwnerSet, testADelegateCannotEnableAnotherModule,
  //  testADelegateCannotGrantAnUnlimitedTokenApproval, testWrongTokenFails.)
  assert.ok(!/data|calldata/.test(safeAdapter.submitAllowanceTransfer.toString().split('{')[0]),
    'submitAllowanceTransfer has no calldata parameter');
});

// ===========================================================================
// C. MEMBERSHIP
// ===========================================================================

test('membership: an invitation is single-use, and an expired one is refused', async (t) => {
  const stack = await lagosTrip({ funded: '0' });
  t.after(stack.restoreProvider);
  const { circles, circle, octane, sarah, mallory } = stack;

  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, role: 'CONTRIBUTOR' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: sarah.prismId });
  // Replay.
  assert.throws(() => circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: sarah.prismId }), /already accepted/);
  // Someone else's invitation.
  const second = circles.invite({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: mallory.prismId, role: 'VIEWER' });
  assert.throws(() => circles.acceptInvitation({ circleId: circle.circleId, inviteId: second.inviteId, prismId: sarah.prismId }), /belongs to someone else/);
  // Expiry is enforced on redemption, not merely displayed.
  stack.store.mutate((d) => { d.circleInvitations[second.inviteId].expiresAt = new Date(Date.now() - 1000).toISOString(); });
  assert.throws(() => circles.acceptInvitation({ circleId: circle.circleId, inviteId: second.inviteId, prismId: mallory.prismId }), /expired/);
});

test('membership: a reassigned phone alias gains no financial authority in an existing Circle', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, mallory, identityService, fake } = stack;

  // Tobi is reachable by phone, and is an admin of the Circle.
  const NUMBER = '+2348012345678';
  identityService.bindVerifiedPhone(tobi.prismId, NUMBER);
  const before = await circles.getCircle(circle.circleId, octane.prismId);
  const ownersBefore = before.authority.owners.map((o) => getAddress(o)).sort();

  // First protection: while the number still reaches Tobi, nobody else can claim it.
  assert.throws(() => identityService.bindVerifiedPhone(mallory.prismId, NUMBER),
    /already belongs to another Prism identity/);

  // Now the real-world event: Tobi moves to a new number, the carrier reassigns the old one, and
  // Mallory verifies it. She now holds an alias that used to reach an admin of this Circle. Prism
  // moves the reachability route; it does not move the money.
  identityService.bindVerifiedPhone(tobi.prismId, '+2348099999999');
  identityService.bindVerifiedPhone(mallory.prismId, NUMBER);
  assert.equal(stack.store.read().phoneIndex[Object.keys(stack.store.read().phoneIndex).find((k) =>
    stack.store.read().phoneIndex[k] === mallory.prismId)], mallory.prismId, 'the alias now resolves to her');

  const after = await circles.getCircle(circle.circleId, octane.prismId);
  assert.deepEqual(after.authority.owners.map((o) => getAddress(o)).sort(), ownersBefore,
    'the Safe owner set is unchanged, because a phone number is not authority');
  assert.ok(!after.members.some((m) => m.prismId === mallory.prismId), 'and she is not in the Circle');

  // She cannot approve anything either: she is a different PrismIdentity with a different account.
  const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 10 });
  const signature = await mallory.account.sign({ hash: payment.safeTxHash });
  await assert.rejects(
    () => circles.approvePayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: mallory.prismId, signature }),
    /circle not found/
  );
  assert.equal(fake.calls.executions.length, 0);
});

test('membership: changing your own phone keeps your Prism identity and your Circle authority', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, identityService, fake } = stack;

  identityService.bindVerifiedPhone(tobi.prismId, '+2348011111111');
  const payment = await propose(stack, { from: octane, to: stack.zainab, dollars: 40 });
  await approve(stack, payment, octane);

  // Tobi changes number between the proposal and his approval. Same human, same PrismIdentity, same
  // Mera account — so the same authority.
  identityService.bindVerifiedPhone(tobi.prismId, '+2348022222222');
  assert.equal(identityService.get(tobi.prismId).accountAddress, tobi.accountAddress, 'the account did not move');

  await approve(stack, payment, tobi);
  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(done.lifecycle, 'COMPLETED', 'continuity preserved: a reachability change is not an authority change');
  assert.equal(fake.balanceOf(stack.zainab.accountAddress).toString(), USD(40));
});

test('membership: removal takes the app away immediately; taking authority away needs the chain', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 3 });
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, sarah } = stack;

  // An ordinary member: Prism decides, and removal is immediate and total.
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId, role: 'CONTRIBUTOR' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: sarah.prismId });
  await circles.removeMember({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId });
  await assert.rejects(() => circles.getCircle(circle.circleId, sarah.prismId), /circle not found/);
  await assert.rejects(
    () => circles.prepareContribution({ circleId: circle.circleId, prismId: sarah.prismId, amountAtomic: USD(10) }),
    /circle not found/
  );

  // An admin: Prism refuses to pretend. It names the governance act instead of faking a removal.
  await assert.rejects(
    () => circles.removeMember({ circleId: circle.circleId, actorPrismId: octane.prismId, prismId: tobi.prismId }),
    /approved on Monad/
  );
  const members = circles.listMembers(circle.circleId, octane.prismId);
  const tobiRow = members.find((m) => m.prismId === tobi.prismId);
  assert.equal(tobiRow.status, 'ACTIVE');
  assert.equal(tobiRow.authorityConfirmedOnChain, true, 'still an admin, because the chain still says so');
});

// ===========================================================================
// D. MONEY
// ===========================================================================

test('money: a contribution debits the person and credits the Circle by exactly the amount', async (t) => {
  const stack = await lagosTrip({ funded: '0' });
  t.after(stack.restoreProvider);
  const { circles, circle, octane, fake } = stack;

  const personBefore = fake.balanceOf(octane.accountAddress);
  const circleBefore = fake.balanceOf(circle.safeAddress);
  const result = await contribute({ circles, circleId: circle.circleId, member: octane, amountAtomic: USD(200) });

  assert.equal(result.contribution.status, 'COMPLETED');
  assert.equal((personBefore - fake.balanceOf(octane.accountAddress)).toString(), USD(200));
  assert.equal((fake.balanceOf(circle.safeAddress) - circleBefore).toString(), USD(200));
  assert.equal(result.contribution.balance.delta, USD(200), 'and the recorded delta is a chain read, not the amount asserted');
});

test('money: a payment debits the Circle and credits the recipient by exactly the amount', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, zainab, fake } = stack;

  const circleBefore = fake.balanceOf(circle.safeAddress);
  const payment = await propose(stack, { from: octane, to: zainab, dollars: 120 });
  await approve(stack, payment, octane);
  await approve(stack, payment, tobi);
  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });

  assert.equal(done.lifecycle, 'COMPLETED');
  assert.equal((circleBefore - fake.balanceOf(circle.safeAddress)).toString(), USD(120));
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(120));
  assert.equal(done.evidence.transfer.amountAtomic, USD(120));
  assert.equal(getAddress(done.evidence.transfer.to), getAddress(zainab.accountAddress));
});

test('money: the backend cannot manufacture a settlement without a Monad receipt', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, zainab, fake } = stack;

  const payment = await propose(stack, { from: octane, to: zainab, dollars: 40 });
  await approve(stack, payment, octane);
  await approve(stack, payment, tobi);

  // A compromised backend marks it done, with a transaction hash it made up.
  stack.store.mutate((d) => {
    const p = d.circleProposals[payment.proposalId];
    p.lifecycle = 'COMPLETED';
    p.status = 'EXECUTED';
    p.executionTxHash = `0x${'ab'.repeat(32)}`;
    p.executedAt = new Date().toISOString();
  });

  const view = await circles.getPayment({ circleId: circle.circleId, proposalId: payment.proposalId, prismId: octane.prismId });
  assert.equal(view.lifecycle, 'INVALIDATED', 'a settlement with no evidence reads back as a forgery');
  assert.equal(view.storedLifecycle, 'COMPLETED', 'and what it claimed is still visible');

  const { payment: canonical, receipt } = await circles.canonicalFor(payment.proposalId, octane.prismId);
  assert.notEqual(canonical.lifecycleState, 'completed');
  assert.equal(receipt.settledAt, null, 'no receipt claims a settlement time it does not have');
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), '0', 'and no money moved');
});

test('money: with the Safe Transaction Service down, approvals still work and no funds are lost', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, zainab, safeAdapter, fake } = stack;

  // The coordination service is unreachable for the whole flow.
  const realPending = safeAdapter.getPendingTransactions.bind(safeAdapter);
  const realPropose = safeAdapter.proposeTransaction.bind(safeAdapter);
  const realConfirm = safeAdapter.addConfirmation.bind(safeAdapter);
  safeAdapter.getPendingTransactions = async () => { throw new Error('safe transaction service unavailable'); };
  safeAdapter.proposeTransaction = async () => { throw new Error('safe transaction service unavailable'); };
  safeAdapter.addConfirmation = async () => { throw new Error('safe transaction service unavailable'); };

  try {
    // Proposing routes through the service; when it is down, the attempt fails rather than
    // pretending. Nothing is lost — the Circle still holds every cent.
    await assert.rejects(() => propose(stack, { from: octane, to: zainab, dollars: 40 }), /unavailable/);
    assert.equal(fake.balanceOf(circle.safeAddress).toString(), USD(500));

    // The recovery path does not depend on that service at all: the owners can build, sign and
    // execute a Safe transaction directly, exactly as any Safe client would.
    const tx = safeTransaction({
      to: getAddress(stack.config.chain.usdc), value: 0n, data: transferData(zainab.accountAddress, USD(40)),
      operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
      gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS,
      nonce: BigInt((await safeAdapter.getCircleState(circle.safeAddress)).nonce)
    });
    const digest = safeTxHash({ chainId: circle.chainId, safeAddress: circle.safeAddress, tx });
    const approvals = await Promise.all([octane, tobi].map(async (owner) => ({
      authorityAddress: getAddress(owner.accountAddress),
      signature: await owner.account.sign({ hash: digest })
    })));
    const { txHash } = await safeAdapter.executeTransaction({ safeAddress: circle.safeAddress, tx, approvals });
    assert.ok(txHash, 'the owners moved their own money with the service offline');
    assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(40));
  } finally {
    safeAdapter.getPendingTransactions = realPending;
    safeAdapter.proposeTransaction = realPropose;
    safeAdapter.addConfirmation = realConfirm;
  }
});

test('money: with Prism entirely gone, the Safe owners still control the funds', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const { circle, octane, tobi, zainab, safeAdapter, fake } = stack;

  // Nothing in this test touches CircleService. Two owners, a Safe transaction they built
  // themselves, and the chain. This is what "Prism holds no custody" means operationally.
  const state = await safeAdapter.getCircleState(circle.safeAddress);
  const tx = safeTransaction({
    to: getAddress(stack.config.chain.usdc), value: 0n, data: transferData(zainab.accountAddress, USD(500)),
    operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS, nonce: BigInt(state.nonce)
  });
  const digest = safeTxHash({ chainId: circle.chainId, safeAddress: circle.safeAddress, tx });
  const approvals = await Promise.all([octane, tobi].map(async (owner) => ({
    authorityAddress: getAddress(owner.accountAddress),
    signature: await owner.account.sign({ hash: digest })
  })));

  await safeAdapter.executeTransaction({ safeAddress: circle.safeAddress, tx, approvals });
  assert.equal(fake.balanceOf(zainab.accountAddress).toString(), USD(500));
  assert.equal(fake.balanceOf(circle.safeAddress).toString(), '0', 'the Circle was emptied without Prism');
});

// ===========================================================================
// E. ZERO-MON
// ===========================================================================

test('zero-MON: members hold no MON, and every on-chain write is sent by the relayer', async (t) => {
  const stack = await circleWithSarahsLimit();
  t.after(stack.restoreProvider);
  const { circles, circle, octane, tobi, sarah, zainab, fake, config } = stack;

  // A full flow: contribute, propose, approve twice, execute, and a within-limit spend.
  await contribute({ circles, circleId: circle.circleId, member: octane, amountAtomic: USD(100) });
  const payment = await propose(stack, { from: octane, to: zainab, dollars: 40 });
  await approve(stack, payment, octane);
  await approve(stack, payment, tobi);
  const done = await circles.executePayment({ circleId: circle.circleId, proposalId: payment.proposalId, actorPrismId: octane.prismId });
  assert.equal(done.lifecycle, 'COMPLETED');
  const s = await spend(stack, { dollars: 25, to: zainab });
  assert.equal((await s.submit()).spend.status, 'COMPLETED');

  // Not one of those people has any MON.
  for (const person of [octane, tobi, sarah]) {
    assert.equal((await fake.chain.getBalance({ address: person.accountAddress })).toString(), '0');
  }
  assert.equal((await fake.chain.getBalance({ address: circle.safeAddress })).toString(), '0',
    'the Circle Safe holds no MON either');

  // Structural, and the reason the above is possible: the backend has exactly one wallet, and it is
  // the relayer's. Members sign typed data; they never sign a transaction.
  const providerSource = readFileSync(new URL('../src/providers/alchemyProvider.js', import.meta.url), 'utf8');
  assert.match(providerSource, /writeContract\(request\)\s*\{\s*return relayerWallet\(\)\.writeContract\(request\)/,
    'every on-chain write goes through the relayer wallet');
  assert.equal((providerSource.match(/createWalletClient\(/g) ?? []).length, 1, 'there is exactly one wallet in the backend');
  assert.match(providerSource, /createWalletClient\(\{\s*account: relayerAccount\(\)/, 'and its account is the relayer');
  assert.ok(config.chain.usdc, 'USDC is configured, and it is the only asset a Circle moves');
});
