import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { circleStack, makeIdentity, acknowledgement, contribute, resolveRecipient } from './circles-harness.js';
import { ProofService } from '../src/services/proofService.js';
import { phoneLookupKey } from '../src/lib/crypto.js';

/**
 * Circle receipts, proof and canonical evidence.
 *
 * This suite asks the question a skeptic asks about a shared account: *does what the app says match
 * what the chain says?* So every assertion below compares a number Prism SHOWS against the same
 * number read independently from the fake chain's own state — `fake.safeAt()`, `fake.balanceOf()`,
 * `fake.allowanceOf()`, `fake.receiptFor()` — never against another Prism value.
 *
 * The separation of evidence sources is the other thing under test:
 *
 *   proposal / signature coordination   Safe Transaction Service   (coordination, never execution)
 *   owners / threshold                  the Safe contract
 *   USDC balance                        the USDC contract
 *   the payment itself                  the Monad receipt + its USDC Transfer log
 *   the human recipient                 Prism resolution
 *
 * Amounts are USDC atomic units (6 decimals): $100 is 100_000000.
 */

const USD = (dollars) => String(BigInt(Math.round(dollars * 100)) * 10_000n);
const PHONE = '+2348012345678';

function proofServiceFor(stack) {
  return new ProofService({
    paymentService: stack.paymentService,
    identityService: stack.identityService,
    circleService: stack.circles,
    config: stack.config
  });
}

/** A funded Circle of `admins` admins at `threshold`, with a non-member recipient waiting. */
async function lagosTrip({ threshold = 2, admins = 2, funded = USD(800), contribution = USD(500) } = {}) {
  const stack = await circleStack({ withPayments: true });
  const people = [];
  for (const [name, handle] of [['Octane', 'octane'], ['Tobi', 'tobi'], ['Kemi', 'kemi']].slice(0, admins)) {
    people.push(await makeIdentity(stack.identityService, { name, handle }));
  }
  const [creator, ...rest] = people;
  const circle = await stack.circles.createCircle({
    creatorPrismId: creator.prismId, name: 'Lagos Trip', template: 'TRIP',
    admins: rest.map((p) => ({ prismId: p.prismId })), threshold,
    policyAcknowledgement: acknowledgement({
      threshold, adminCount: admins,
      warnings: threshold === admins && admins >= 2 ? ['NO_SPARE_AUTHORITY'] : (threshold === 1 && admins >= 2 ? ['ANY_ADMIN_ALONE'] : [])
    })
  });
  stack.fake.setBalance(creator.accountAddress, funded);
  const contributed = await contribute({ circles: stack.circles, circleId: circle.circleId, member: creator, amountAtomic: contribution });

  const host = await makeIdentity(stack.identityService, { name: 'Airbnb Host', handle: 'airbnb' });
  return { ...stack, circle, people, creator, admins: people, host, contribution: contributed.contribution };
}

async function propose(stack, { from, to, dollars, memo = 'Airbnb' }) {
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: from.prismId, target: to });
  return stack.circles.proposePayment({
    circleId: stack.circle.circleId, actorPrismId: from.prismId, resolution, amountAtomic: USD(dollars), memo
  });
}

async function approve(stack, payment, admin) {
  const signature = await admin.account.sign({ hash: payment.safeTxHash });
  return stack.circles.approvePayment({
    circleId: stack.circle.circleId, proposalId: payment.proposalId, prismId: admin.prismId, signature
  });
}

/** Propose $480 to the host, approve with every admin, execute. Returns the completed payment. */
async function paidHost(stack, { dollars = 480 } = {}) {
  const payment = await propose(stack, { from: stack.creator, to: stack.host, dollars });
  for (const admin of stack.admins) await approve(stack, payment, admin);
  const executed = await stack.circles.executePayment({
    circleId: stack.circle.circleId, proposalId: payment.proposalId, actorPrismId: stack.creator.prismId
  });
  assert.equal(executed.lifecycle, 'COMPLETED', 'the payment settled');
  return executed;
}

// ===========================================================================
// The canonical payment model — one money object, with Circle context
// ===========================================================================

test('a Circle payment is an ordinary PrismPayment carrying Circle context, not a separate object', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const executed = await paidHost(stack);

  const { payment, receipt, events } = await stack.circles.canonicalFor(executed.proposalId, stack.creator.prismId);

  // The same canonical shape every Prism payment has.
  assert.equal(payment.paymentId, executed.proposalId);
  assert.equal(payment.kind, 'circlePayment');
  assert.equal(payment.lifecycleState, 'completed');
  assert.equal(payment.amountAtomic, USD(480));
  assert.equal(payment.asset, 'USDC');
  assert.equal(payment.entryMethod, 'circle');

  // Plus the block that says where the money came from and what released it.
  assert.equal(payment.sourceType, 'circle');
  assert.equal(payment.circle.circleId, stack.circle.circleId);
  assert.equal(payment.circle.circleName, 'Lagos Trip');
  assert.equal(payment.circle.circleSafeAddress, stack.circle.safeAddress);
  assert.equal(payment.circle.approvalPolicy, 'THRESHOLD');
  assert.equal(payment.circle.authority, 'Shared');
  assert.equal(payment.circle.requiredApprovals, 2);
  assert.equal(payment.circle.approvalRule, '2 approvals');
  assert.equal(payment.circle.proposalId, executed.proposalId);
  assert.equal(payment.circle.safeTxHash, executed.safeTxHash);

  // The payer is the Circle itself — not the admin who happened to tap send.
  assert.equal(payment.sender.displayName, 'Lagos Trip');
  assert.equal(payment.sender.accountAddress, stack.circle.safeAddress);
  assert.equal(payment.recipient.displayName, 'Airbnb Host');

  // The receipt is the ordinary receipt: paid from, requested by, approved by, under which rule.
  assert.equal(receipt.paymentId, executed.proposalId);
  assert.equal(receipt.sourceType, 'circle');
  assert.equal(receipt.circle.circleName, 'Lagos Trip');
  assert.equal(receipt.circle.proposer.displayName, 'Octane');
  assert.deepEqual(receipt.circle.approvers.map((a) => a.displayName).sort(), ['Octane', 'Tobi']);
  assert.equal(receipt.circle.approvalRule, '2 approvals');
  assert.equal(receipt.finalStatus, 'completed');
  assert.equal(receipt.transactionHash, executed.executionTxHash);

  // A real lifecycle history with real timestamps, ending in the state the chain put it in.
  assert.ok(events.length >= 5, 'the payment carries its lifecycle history');
  assert.equal(events.at(-1).state, 'completed');
  assert.ok(events.every((e) => Date.parse(e.occurredAt) > 0), 'every event has a real timestamp');
});

test('a contribution projects through the same canonical model, flowing into the Circle', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);

  const { payment, receipt } = await stack.circles.canonicalFor(stack.contribution.contributionId, stack.creator.prismId);
  assert.equal(payment.kind, 'circleContribution');
  assert.equal(payment.sourceType, 'circle');
  assert.equal(payment.circle.flow, 'in');
  assert.equal(payment.circle.approvalPolicy, 'CONTRIBUTION');
  // Money in: the person is the payer and the Circle is the recipient.
  assert.equal(payment.sender.displayName, 'Octane');
  assert.equal(payment.recipient.displayName, 'Lagos Trip');
  assert.equal(payment.recipient.accountAddress, stack.circle.safeAddress);
  assert.equal(receipt.circle.proposer.displayName, 'Octane', 'the receipt names who added the money');
  assert.equal(payment.lifecycleState, 'completed');
});

test('the person who was paid sees their own receipt, but not the Circle\'s governance', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const executed = await paidHost(stack);

  const { payment } = await stack.circles.canonicalFor(executed.proposalId, stack.host.prismId);
  assert.equal(payment.circle.circleName, 'Lagos Trip', 'they can see which Circle paid them');
  assert.equal(payment.circle.restricted, true);
  assert.deepEqual(payment.circle.approvers, [], 'who approved is the Circle\'s business, not the payee\'s');
  assert.equal(payment.circle.proposer, null);
  assert.equal(payment.circle.requiredApprovals, null);

  // And a stranger gets the same answer they get for any Circle they are not in.
  const stranger = await makeIdentity(stack.identityService, { name: 'Nosy', handle: 'nosy' });
  await assert.rejects(
    () => stack.circles.canonicalFor(executed.proposalId, stranger.prismId),
    /payment not found/
  );
});

// ===========================================================================
// The ten proofs
// ===========================================================================

test('PROOF 1-3: displayed balance, owners and threshold equal what the chain says', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 3 });
  t.after(stack.restoreProvider);
  const view = await stack.circles.getCircle(stack.circle.circleId, stack.creator.prismId);

  // 1. balance == USDC.balanceOf(safe)
  assert.equal(view.balance.amountAtomic, stack.fake.balanceOf(stack.circle.safeAddress).toString());
  assert.equal(view.balance.source, 'chain');

  // 2. owners == the Safe's own owner set
  const onchain = stack.fake.safeAt(stack.circle.safeAddress);
  assert.deepEqual(
    view.authority.owners.map((o) => getAddress(o)).sort(),
    onchain.owners.map((o) => getAddress(o)).sort()
  );

  // 3. threshold == the Safe's own threshold
  assert.equal(view.authority.threshold, onchain.threshold);
  assert.equal(view.authority.source, 'chain');

  // And the proof surface reports the same three, attributed to the contracts they came from.
  const executed = await paidHost(stack, { dollars: 100 });
  const proof = await proofServiceFor(stack).canonical(executed.proposalId, stack.creator.prismId);
  assert.equal(proof.circle.threshold, onchain.threshold);
  assert.deepEqual(proof.circle.owners.map(getAddress).sort(), onchain.owners.map(getAddress).sort());
  assert.equal(proof.circle.policySource, 'safe contract');
  assert.equal(proof.circle.policy, '2 of 3 admins');
  assert.equal(proof.circle.balance.source, 'usdc contract');
  assert.equal(proof.circle.balance.current, stack.fake.balanceOf(stack.circle.safeAddress).toString());
  assert.equal(proof.verification.ownersReadback, 'pass');
  assert.equal(proof.verification.thresholdReadback, 'pass');
  assert.equal(proof.verification.balanceReadback, 'pass');
});

test('PROOF 4: a reported spending limit equals the allowance the module holds', async (t) => {
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

  // Grant Sarah $100/day — however many Safe transactions that takes.
  for (let step = 0; step < 5; step++) {
    const prepared = await stack.circles.prepareSpendingLimit({
      circleId: circle.circleId, actorPrismId: octane.prismId, prismId: sarah.prismId,
      amountAtomic: USD(100), period: 'DAILY'
    });
    if (prepared.complete) break;
    for (const admin of [octane, tobi]) {
      const signature = await admin.account.sign({ hash: prepared.safeTxHash });
      await stack.circles.recordApproval({ circleId: circle.circleId, proposalId: prepared.proposalId, prismId: admin.prismId, signature });
    }
    await stack.circles.executeGovernance({ circleId: circle.circleId, proposalId: prepared.proposalId, actorPrismId: octane.prismId });
  }

  const reported = await stack.circles.spendingLimitFor(circle.circleId, octane.prismId, sarah.prismId);
  const onchain = stack.fake.allowanceOf(circle.safeAddress, sarah.accountAddress, stack.config.chain.usdc);
  assert.equal(reported.limit.limitAtomic, onchain.amount.toString(), 'the displayed limit is the module\'s');
  assert.equal(reported.limit.spentAtomic, onchain.spent.toString());
  assert.equal(reported.limit.source, 'chain');

  // A spend inside it settles, and its proof reports the module's own figures back.
  const merchant = await makeIdentity(stack.identityService, { name: 'Groceries', handle: 'groceries' });
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: sarah.prismId, target: merchant });
  const prepared = await stack.circles.prepareSpend({
    circleId: circle.circleId, actorPrismId: sarah.prismId, resolution, amountAtomic: USD(42), memo: 'Groceries'
  });
  const signature = await sarah.account.sign({ hash: prepared.transferHash });
  const submitted = await stack.circles.submitSpend({
    circleId: circle.circleId, spendId: prepared.spend.spendId, prismId: sarah.prismId, signature
  });
  assert.equal(submitted.spend.status, 'COMPLETED');

  const proof = await proofServiceFor({ ...stack, circle }).canonical(prepared.spend.spendId, sarah.prismId);
  const after = stack.fake.allowanceOf(circle.safeAddress, sarah.accountAddress, stack.config.chain.usdc);
  assert.equal(proof.circle.authority, 'Delegated', 'a limit spend is not the Circle deciding together');
  assert.equal(proof.circle.allowance.limitAtomic, after.amount.toString());
  assert.equal(proof.circle.allowance.spentAtomic, after.spent.toString());
  assert.equal(proof.verification.allowanceReadback, 'pass');
  assert.equal(proof.circle.approvals.length, 0, 'nobody approved this — the limit did');

  // The canonical payment names the limit it was authorized against.
  const { payment } = await stack.circles.canonicalFor(prepared.spend.spendId, sarah.prismId);
  assert.equal(payment.kind, 'circleSpend');
  assert.equal(payment.circle.approvalPolicy, 'SPENDING_LIMIT');
  assert.equal(payment.circle.spendingLimitReference.limitAtomic, USD(100));
  assert.equal(payment.circle.spendingLimitReference.source, 'chain');
});

test('PROOF 5-6: the Safe really executed, and the USDC Transfer names the right recipient and amount', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const executed = await paidHost(stack);
  const proof = await proofServiceFor(stack).canonical(executed.proposalId, stack.creator.prismId);

  // 5. The Safe's own ExecutionSuccess for this exact digest — not merely a successful transaction.
  assert.equal(proof.verification.safeExecution, 'pass');
  const receipt = stack.fake.receiptFor(executed.executionTxHash);
  assert.equal(receipt.status, 'success');
  assert.equal(proof.settlement.txHash, executed.executionTxHash);
  assert.equal(proof.settlement.blockNumber, String(receipt.blockNumber));

  // 6. A USDC Transfer from this Circle to the reviewed recipient, for the exact amount.
  assert.equal(proof.verification.usdcTransfer, 'pass');
  assert.equal(getAddress(proof.circle.transfer.from), getAddress(stack.circle.safeAddress));
  assert.equal(getAddress(proof.circle.transfer.to), getAddress(stack.host.accountAddress));
  assert.equal(proof.circle.transfer.amountAtomic, USD(480));
  // And the host's balance moved by exactly that much, read from the ledger itself.
  assert.equal(stack.fake.balanceOf(stack.host.accountAddress).toString(), USD(480));

  // Everything that could be established was. `proofStatus` stays short of "verified" here for one
  // honest reason: neither party has a phone bound, so there is no prohibited identifier to search
  // for and the privacy detector cannot PROVE absence. The next test binds phones and gets there.
  assert.equal(proof.proofStatus, 'partially_verified');
  assert.equal(proof.privacy.calldataCheck, 'unknown');
  assert.equal(proof.evidenceLevel, 'E3');

  // The Transaction Service is present as coordination and is never counted as execution evidence.
  const coordination = proof.evidence.find((e) => e.type === 'proposalCoordination');
  assert.equal(coordination.status, 'coordination');
  assert.equal(coordination.source, 'safe transaction service');
  assert.match(coordination.detail, /never treated as evidence of execution/);
  const execution = proof.evidence.find((e) => e.type === 'safeExecutionSuccess');
  assert.equal(execution.source, 'safe contract');
  assert.equal(proof.evidence.find((e) => e.type === 'usdcTransfer').source, 'usdc contract');
  // A Safe transfer is not a router PaymentSettled event: Prism's index has no row to be missing.
  assert.equal(proof.verification.envioIndex, 'not_applicable');
});

test('PROOF 7: no phone number reaches the Circle\'s public transaction data, receipt or proof', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  // Both people in this payment are reachable by phone — the thing that must never go on-chain.
  stack.identityService.bindVerifiedPhone(stack.host.prismId, PHONE);
  stack.identityService.bindVerifiedPhone(stack.creator.prismId, '+2348099999999');
  const hash = phoneLookupKey(PHONE, stack.config.resolverPepper).replace(/^0x/i, '').toLowerCase();
  const digits = PHONE.replace(/\D/g, '');

  const executed = await paidHost(stack);
  const proof = await proofServiceFor(stack).canonical(executed.proposalId, stack.creator.prismId);
  const canonical = await stack.circles.canonicalFor(executed.proposalId, stack.creator.prismId);

  const clean = (label, value) => {
    const s = JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase();
    assert.ok(!s.includes(PHONE.toLowerCase()), `${label} leaked the raw phone`);
    assert.ok(!s.includes(digits), `${label} leaked the phone digits`);
    assert.ok(!s.includes(hash), `${label} leaked the phone-derived key`);
  };

  // The Safe transaction itself, as it went to the chain.
  clean('the Safe transaction', executed.safeTransaction);
  clean('the execution receipt logs', stack.fake.receiptFor(executed.executionTxHash));
  clean('the Circle payment proof', proof);
  clean('the canonical payment and receipt', canonical);
  clean('the Circle payment view', executed);

  // And the detector actually ran, over real fields, rather than defaulting to a clean answer.
  assert.equal(proof.privacy.calldataCheck, 'pass');
  assert.equal(proof.privacy.rawPhoneInCalldata, 'no');
  assert.equal(proof.privacy.sensitiveOnchain, 'no');
  assert.ok(proof.privacy.detail.calldataFieldsScanned >= 8, 'the Safe transaction fields were scanned');
  assert.ok(proof.privacy.detail.prohibitedValueCount >= 2, 'both people\'s identifiers were searched for');
  assert.equal(proof.privacy.detail.matches.length, 0);
  // With an identifier to hunt for and none found, the whole proof reaches "verified".
  assert.equal(proof.proofStatus, 'verified');
  assert.equal(proof.evidenceLevel, 'E3');
});

test('PROOF 8-9: approvals are signatures from CURRENT owners, and a removed admin\'s stops counting', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const payment = await propose(stack, { from: stack.creator, to: stack.host, dollars: 480 });
  for (const admin of stack.admins) await approve(stack, payment, admin);

  // 8. Every approval the proof reports recovers to an address that is an owner right now.
  const beforeRemoval = await stack.circles.getPayment({
    circleId: stack.circle.circleId, proposalId: payment.proposalId, prismId: stack.creator.prismId
  });
  const owners = stack.fake.safeAt(stack.circle.safeAddress).owners.map((o) => getAddress(o));
  assert.equal(beforeRemoval.collectedApprovals, 2);
  assert.equal(beforeRemoval.lifecycle, 'APPROVED');
  for (const approval of beforeRemoval.approvals) {
    assert.ok(owners.includes(getAddress(approval.authorityAddress)), 'an approval came from a current owner');
  }
  assert.equal(beforeRemoval.approvalsSource, 'verified signatures against the live owner set');

  // 9. Tobi stops being an owner on-chain, out from under Prism. His signature is still a real
  //    signature over the same digest — and it stops counting, with nobody telling Prism.
  const [octane] = stack.admins;
  stack.fake.forceOwners(stack.circle.safeAddress, [octane.accountAddress], 1);

  const afterRemoval = await stack.circles.getPayment({
    circleId: stack.circle.circleId, proposalId: payment.proposalId, prismId: stack.creator.prismId
  });
  assert.equal(afterRemoval.collectedApprovals, 1, 'the removed admin\'s approval no longer counts');
  assert.deepEqual(
    afterRemoval.approvals.map((a) => getAddress(a.authorityAddress)),
    [getAddress(octane.accountAddress)]
  );

  const { payment: canonical } = await stack.circles.canonicalFor(payment.proposalId, stack.creator.prismId);
  assert.deepEqual(
    canonical.circle.approvers.map((a) => getAddress(a.authorityAddress)),
    [getAddress(octane.accountAddress)],
    'the receipt does not list an approval from someone who is no longer an admin'
  );
});

test('PROOF 10: a receipt references the execution that actually happened, and cannot be forged', async (t) => {
  const stack = await lagosTrip();
  t.after(stack.restoreProvider);
  const executed = await paidHost(stack);

  const { receipt } = await stack.circles.canonicalFor(executed.proposalId, stack.creator.prismId);
  const onchain = stack.fake.receiptFor(receipt.transactionHash);
  assert.ok(onchain, 'the receipt names a transaction that exists on-chain');
  assert.equal(onchain.status, 'success');
  assert.equal(receipt.blockNumber, String(onchain.blockNumber));
  assert.equal(receipt.finalStatus, 'completed');
  assert.ok(receipt.settledAt, 'a settled receipt carries the time it settled');

  // A row hand-edited to look complete, with the evidence removed, reads back as invalidated —
  // the receipt cannot claim a settlement that has no execution behind it.
  stack.store.mutate((d) => { d.circleProposals[executed.proposalId].evidence = null; });
  const forged = await stack.circles.canonicalFor(executed.proposalId, stack.creator.prismId);
  assert.notEqual(forged.payment.lifecycleState, 'completed');
  assert.equal(forged.payment.circle.state, 'INVALIDATED');
  assert.equal(forged.receipt.settledAt, null, 'a forged receipt never reports a settlement time');
});

test('an unsettled Circle payment never reports itself as paid', async (t) => {
  const stack = await lagosTrip({ threshold: 2, admins: 2 });
  t.after(stack.restoreProvider);
  const payment = await propose(stack, { from: stack.creator, to: stack.host, dollars: 480 });
  await approve(stack, payment, stack.admins[0]);

  const { payment: canonical, receipt } = await stack.circles.canonicalFor(payment.proposalId, stack.creator.prismId);
  assert.equal(canonical.lifecycleState, 'created', 'one of two approvals is not a payment');
  assert.equal(canonical.circle.state, 'APPROVAL_PENDING');
  assert.equal(canonical.transactionHash, null);
  assert.equal(receipt.settledAt, null);
  assert.equal(receipt.finalStatus, 'created');

  const proof = await proofServiceFor(stack).canonical(payment.proposalId, stack.creator.prismId);
  assert.equal(proof.proofStatus, 'pending');
  assert.equal(proof.evidenceLevel, 'E0');
  assert.equal(proof.verification.usdcTransfer, 'unknown');
  assert.equal(proof.verification.safeExecution, 'unknown');
});
