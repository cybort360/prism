import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { circleStack, makeIdentity, acknowledgement } from './circles-harness.js';

/**
 * Circle creation, and the gate in front of ACTIVE.
 *
 * The property under test throughout: Prism may not *claim* a Circle exists, holds money, or has a
 * given admin set. Every one of those claims has to survive a read of the deployed Safe, and a
 * Circle that fails any single check never reaches ACTIVE.
 */

async function twoAdmins(threshold = 2, warnings = ['NO_SPARE_AUTHORITY']) {
  const stack = await circleStack();
  const ada = await makeIdentity(stack.identityService, { name: 'Ada', handle: 'ada' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const create = (overrides = {}) => stack.circles.createCircle({
    creatorPrismId: ada.prismId, name: 'Trip to Lagos', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }], threshold,
    policyAcknowledgement: acknowledgement({ threshold, adminCount: 2, warnings }),
    ...overrides
  });
  return { ...stack, ada, tobi, create };
}

test('create Circle: reaches ACTIVE only after the deployed Safe is read back', async () => {
  const { create, fake } = await twoAdmins();
  const circle = await create();

  assert.equal(circle.status, 'ACTIVE');
  assert.equal(circle.verifiedOnChain, true);
  assert.ok(circle.safeAddress, 'an active Circle has a Safe address');
  assert.equal(circle.asset, 'USDC');
  // The flow was walked in order, not jumped.
  const states = circle.events.filter((e) => e.state).map((e) => e.state);
  assert.deepEqual(states, [
    'MEMBERS_SELECTED', 'POLICY_REVIEWED', 'AWAITING_AUTHORIZATION', 'DEPLOYING', 'CONFIRMING', 'RECONCILING', 'ACTIVE'
  ]);
  assert.equal(fake.calls.deployments, 1);
});

test('predicted Safe address: the Circle deploys exactly where Prism said it would', async () => {
  const { create, store, fake } = await twoAdmins();
  const circle = await create();
  const record = store.read().circles[circle.circleId];

  assert.equal(getAddress(record.creation.predictedSafeAddress), getAddress(circle.safeAddress));
  assert.ok(fake.safeAt(circle.safeAddress), 'a Safe really exists at the predicted address');
  assert.equal(record.activation.safeAddress, getAddress(circle.safeAddress));
});

test('correct owners: the deployed owner set is exactly the admins that were authorized', async () => {
  const { create, ada, tobi, fake } = await twoAdmins();
  const circle = await create();

  const deployed = fake.safeAt(circle.safeAddress).owners.map((o) => o.toLowerCase()).sort();
  const expected = [ada.accountAddress, tobi.accountAddress].map((a) => getAddress(a).toLowerCase()).sort();
  assert.deepEqual(deployed, expected);
});

test('correct threshold: the Safe is deployed with the approvals the creator authorized', async () => {
  const { create, fake, store } = await twoAdmins();
  const circle = await create();

  assert.equal(fake.safeAt(circle.safeAddress).threshold, 2);
  // And the number Prism stores came from the chain read, not from the request.
  assert.equal(store.read().circles[circle.circleId].threshold, 2);
  assert.equal(store.read().circles[circle.circleId].activation.threshold, 2);
});

test('wrong owner set rejected: a Safe that deployed with different owners never becomes ACTIVE', async () => {
  const { create, fake } = await twoAdmins();
  // The chain deploys a Safe owned by someone else entirely.
  fake.knobs.overrideOwners = ['0x00000000000000000000000000000000000000aa'];
  const circle = await create();

  assert.equal(circle.status, 'VERIFICATION_FAILED');
  assert.equal(circle.verifiedOnChain, false);
  assert.match(circle.failureReason, /admin set/i);
});

test('wrong threshold rejected: a Safe deployed with a different threshold never becomes ACTIVE', async () => {
  const { create, fake } = await twoAdmins();
  fake.knobs.overrideThreshold = 1;
  const circle = await create();

  assert.equal(circle.status, 'VERIFICATION_FAILED');
  assert.match(circle.failureReason, /threshold is 1, expected 2/i);
});

test('wrong chain rejected: a Safe on another chain is not this Circle', async () => {
  const { create, fake } = await twoAdmins();
  fake.knobs.reportChainId = 1;                 // mainnet, not Monad testnet
  const circle = await create();

  assert.equal(circle.status, 'VERIFICATION_FAILED');
  assert.match(circle.failureReason, /chain 1, expected 10143/);
});

test('wrong Safe version rejected: only the audited v1.4.1 singleton backs a Circle', async () => {
  const { create, fake } = await twoAdmins();
  fake.knobs.overrideVersion = '1.3.0';
  const circle = await create();

  assert.equal(circle.status, 'VERIFICATION_FAILED');
  assert.match(circle.failureReason, /version is 1\.3\.0/);
});

test('duplicate creation is idempotent: the same Circle is never deployed twice', async () => {
  const { create, fake } = await twoAdmins();
  const first = await create();
  const second = await create();

  assert.equal(second.circleId, first.circleId);
  assert.equal(second.safeAddress, first.safeAddress);
  assert.equal(fake.calls.deployments, 1, 'the second request must not deploy a second Safe');
});

test('a fabricated threshold in Prism\'s own database loses to the chain', async () => {
  const { create, store, ada, circles, fake } = await twoAdmins();
  const circle = await create();

  // Rewrite Prism's mirror to claim this Circle only needs one approval — the single most valuable
  // lie a compromised backend could tell about a shared account.
  store.mutate((d) => {
    d.circles[circle.circleId].threshold = 1;
    d.circles[circle.circleId].adminCount = 9;
  });

  const read = await circles.getCircle(circle.circleId, ada.prismId);
  assert.equal(read.authority.threshold, 2, 'the answer comes from the Safe, not the row');
  assert.equal(read.authority.adminCount, 2);
  assert.equal(read.authority.source, 'chain');
  assert.equal(fake.safeAt(circle.safeAddress).threshold, 2);
  // ...and the mirror is corrected back to what the chain says, rather than left to drift.
  assert.equal(store.read().circles[circle.circleId].threshold, 2);
  assert.equal(store.read().circles[circle.circleId].adminCount, 2);
});

test('backend fake ACTIVE is rejected: the Circle is demoted out of ACTIVE, not quietly trusted', async () => {
  const { create, store, ada, circles } = await twoAdmins();
  const circle = await create();
  store.mutate((d) => { d.circles[circle.circleId].activation = null; });

  await assert.rejects(() => circles.getCircle(circle.circleId, ada.prismId), /verification receipt/);
  assert.equal(store.read().circles[circle.circleId].status, 'VERIFICATION_FAILED');
});

test('threshold cannot be zero', async () => {
  const { circles, ada, tobi } = await twoAdmins();
  await assert.rejects(
    () => circles.createCircle({
      creatorPrismId: ada.prismId, name: 'Zero', template: 'CUSTOM',
      admins: [{ prismId: tobi.prismId }], threshold: 0,
      policyAcknowledgement: acknowledgement({ threshold: 0, adminCount: 2 })
    }),
    /at least 1/
  );
});

test('threshold cannot exceed the number of admins', async () => {
  const { circles, ada, tobi } = await twoAdmins();
  await assert.rejects(
    () => circles.createCircle({
      creatorPrismId: ada.prismId, name: 'Too many', template: 'CUSTOM',
      admins: [{ prismId: tobi.prismId }], threshold: 3,
      policyAcknowledgement: acknowledgement({ threshold: 3, adminCount: 2 })
    }),
    /exceeds the 2 admins/
  );
});

test('admin addresses are never invented: someone without a Prism account cannot be an admin', async () => {
  const { circles, ada, store, identityService } = await twoAdmins();
  const ghost = await makeIdentity(identityService, { name: 'Ghost' });
  store.mutate((d) => { d.identities[ghost.prismId].accountAddress = null; });

  await assert.rejects(
    () => circles.createCircle({
      creatorPrismId: ada.prismId, name: 'Ghosts', template: 'CUSTOM',
      admins: [{ prismId: ghost.prismId }], threshold: 1,
      policyAcknowledgement: acknowledgement({ threshold: 1, adminCount: 2 })
    }),
    /has not finished setting up their Prism account/
  );
});

test('the two-person trade-off must be acknowledged explicitly, with the numbers the creator saw', async () => {
  const { circles, ada, tobi } = await twoAdmins();

  // Acknowledgement missing entirely.
  await assert.rejects(() => circles.createCircle({
    creatorPrismId: ada.prismId, name: 'A', template: 'CUSTOM', admins: [{ prismId: tobi.prismId }], threshold: 2,
    policyAcknowledgement: null
  }), /must be acknowledged/);

  // Acknowledgement for a different policy than the one being deployed.
  await assert.rejects(() => circles.createCircle({
    creatorPrismId: ada.prismId, name: 'B', template: 'CUSTOM', admins: [{ prismId: tobi.prismId }], threshold: 2,
    policyAcknowledgement: acknowledgement({ threshold: 1, adminCount: 2, warnings: ['NO_SPARE_AUTHORITY'] })
  }), /does not match this Circle/);

  // The 2-of-2 freeze warning specifically was not acknowledged.
  await assert.rejects(() => circles.createCircle({
    creatorPrismId: ada.prismId, name: 'C', template: 'CUSTOM', admins: [{ prismId: tobi.prismId }], threshold: 2,
    policyAcknowledgement: acknowledgement({ threshold: 2, adminCount: 2, warnings: [] })
  }), /Losing access to either authority can block spending/);
});

test('a Circle still confirming reports its real state, never an optimistic ACTIVE', async () => {
  const { create, fake, ada, circles } = await twoAdmins();
  fake.knobs.receiptPending = true;             // broadcast, not yet mined
  const circle = await create();

  assert.equal(circle.status, 'DEPLOYING');
  assert.equal(circle.verifiedOnChain, false);

  const read = await circles.getCircle(circle.circleId, ada.prismId);
  assert.equal(read.authority.unavailable, true);
  assert.equal(read.balance.unavailable, true);
  assert.ok(!('amountAtomic' in read.balance), 'an unknown balance is never reported as a number');

  // Once the receipt lands, simply reading the Circle finishes the flow.
  fake.knobs.receiptPending = false;
  const after = await circles.getCircle(circle.circleId, ada.prismId);
  assert.equal(after.status, 'ACTIVE');
  assert.equal(after.verifiedOnChain, true);
});

test('a reverted deployment fails verification instead of producing a Circle', async () => {
  const { create, fake } = await twoAdmins();
  fake.knobs.deploymentReverts = true;
  const circle = await create();

  assert.equal(circle.status, 'VERIFICATION_FAILED');
  assert.match(circle.failureReason, /reverted/);
});

test('balance is never fabricated: an unreadable chain yields "unknown", not zero', async () => {
  const { create, fake, ada, circles } = await twoAdmins();
  const circle = await create();
  fake.setBalance(circle.safeAddress, 5_000_000n);

  const funded = await circles.getCircle(circle.circleId, ada.prismId);
  assert.equal(funded.balance.amountAtomic, '5000000');
  assert.equal(funded.balance.source, 'chain');

  fake.knobs.readFails = true;
  const dark = await circles.getCircle(circle.circleId, ada.prismId);
  assert.equal(dark.balance.unavailable, true);
  assert.equal(dark.authority.unavailable, true);
  assert.equal(dark.balance.amountAtomic, undefined, 'no cached number is substituted for the real one');
});

test('membership is the read boundary: a stranger cannot see a Circle at all', async () => {
  const { create, circles, identityService } = await twoAdmins();
  const circle = await create();
  const stranger = await makeIdentity(identityService, { name: 'Stranger' });

  await assert.rejects(() => circles.getCircle(circle.circleId, stranger.prismId), /circle not found/);
  assert.equal(circles.listCircles(stranger.prismId).length, 0);
});

test('a rejected creation leaves no trace: no half-built Circle appears in anyone\'s list', async () => {
  const { circles, ada, tobi } = await twoAdmins();

  // Each of these fails a different gate, and none of them may leave a row behind.
  const rejected = [
    { name: '', threshold: 2, ack: acknowledgement({ threshold: 2, adminCount: 2, warnings: ['NO_SPARE_AUTHORITY'] }) },
    { name: 'Bad threshold', threshold: 9, ack: acknowledgement({ threshold: 9, adminCount: 2 }) },
    { name: 'No acknowledgement', threshold: 2, ack: null },
    { name: 'Wrong acknowledgement', threshold: 2, ack: acknowledgement({ threshold: 1, adminCount: 2 }) },
    { name: 'Unacknowledged warning', threshold: 2, ack: acknowledgement({ threshold: 2, adminCount: 2, warnings: [] }) }
  ];
  for (const attempt of rejected) {
    await assert.rejects(() => circles.createCircle({
      creatorPrismId: ada.prismId, name: attempt.name, template: 'CUSTOM',
      admins: [{ prismId: tobi.prismId }], threshold: attempt.threshold, policyAcknowledgement: attempt.ack
    }));
  }

  assert.deepEqual(circles.listCircles(ada.prismId), [], 'the creator sees no ghost Circles');
  assert.deepEqual(circles.listCircles(tobi.prismId), [], 'nor does anyone who was named as an admin');
});

test('a creation interrupted after authorization resumes instead of deploying a second Safe', async () => {
  const { create, fake, circles, ada } = await twoAdmins();

  // The deployment broadcast fails — the network was down, the relayer was unfunded, anything.
  const realWrite = fake.chain.writeContract;
  fake.chain.writeContract = async () => { throw new Error('relayer unavailable'); };
  await assert.rejects(() => create(), /relayer unavailable/);

  // The Circle is parked at the point it got to, honestly, and is not active.
  const parked = circles.listCircles(ada.prismId);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].status, 'AWAITING_AUTHORIZATION');
  assert.equal(parked[0].verifiedOnChain, false);

  // Retrying the same request resumes that Circle rather than starting another.
  fake.chain.writeContract = realWrite;
  const resumed = await create();
  assert.equal(resumed.circleId, parked[0].circleId);
  assert.equal(resumed.status, 'ACTIVE');
  assert.equal(fake.calls.deployments, 1);
  assert.equal(circles.listCircles(ada.prismId).length, 1);
});

test('a Circle that failed verification can be created again at a fresh address', async () => {
  const { create, fake, circles, ada } = await twoAdmins();

  // The first attempt deploys a Safe whose owner set is not what was authorized.
  fake.knobs.overrideOwners = ['0x00000000000000000000000000000000000000aa'];
  const failed = await create();
  assert.equal(failed.status, 'VERIFICATION_FAILED');

  // Whatever went wrong is fixed, and the same Circle is attempted again. It must not resume the
  // failed one: that Safe address is already occupied, so redeploying there would simply revert.
  fake.knobs.overrideOwners = null;
  const retried = await create();

  assert.equal(retried.status, 'ACTIVE');
  assert.notEqual(retried.circleId, failed.circleId);
  assert.notEqual(retried.safeAddress, failed.safeAddress, 'a fresh salt means a fresh address');
  assert.equal(fake.calls.deployments, 2);

  // The failed attempt does not linger in the list alongside the real one.
  const listed = circles.listCircles(ada.prismId);
  assert.equal(listed.filter((c) => c.status === 'ACTIVE').length, 1);
});
