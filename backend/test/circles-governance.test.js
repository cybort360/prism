import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress } from 'viem';
import { circleStack, makeIdentity, acknowledgement } from './circles-harness.js';

/**
 * Governance: changing who the admins are, and how many of them a payment needs.
 *
 * Nothing here moves authority. These endpoints PREPARE a Safe transaction — they produce the digest
 * the current admins must sign. The tests assert two things: that the calldata really does what the
 * Circle was told it does, and that Prism refuses to prepare a change that would leave the Circle in
 * a state Safe itself would reject (or that would quietly brick it).
 */

const OWNER_ABI = [
  { name: 'addOwnerWithThreshold', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'owner', type: 'address' }, { name: '_threshold', type: 'uint256' }] },
  { name: 'removeOwner', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'prevOwner', type: 'address' }, { name: 'owner', type: 'address' }, { name: '_threshold', type: 'uint256' }] },
  { name: 'changeThreshold', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: '_threshold', type: 'uint256' }] }
];

/** A 2-of-3 Circle: enough admins to remove one without immediately hitting the floor. */
async function circleOfThree({ threshold = 2 } = {}) {
  const stack = await circleStack();
  const ada = await makeIdentity(stack.identityService, { name: 'Ada', handle: 'ada' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const kemi = await makeIdentity(stack.identityService, { name: 'Kemi', handle: 'kemi' });
  const warnings = threshold === 3 ? ['NO_SPARE_AUTHORITY'] : [];
  const circle = await stack.circles.createCircle({
    creatorPrismId: ada.prismId, name: 'Community pot', template: 'COMMUNITY',
    admins: [{ prismId: tobi.prismId }, { prismId: kemi.prismId }], threshold,
    policyAcknowledgement: acknowledgement({ threshold, adminCount: 3, warnings })
  });
  return { ...stack, ada, tobi, kemi, circle };
}

test('prepare-add: builds addOwnerWithThreshold against the Circle\'s own Safe', async () => {
  const { circles, ada, circle, identityService } = await circleOfThree();
  const zainab = await makeIdentity(identityService, { name: 'Zainab', handle: 'zainab' });

  const proposal = await circles.prepareAddAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, handle: '@zainab' });

  assert.equal(proposal.kind, 'OWNER_ADD');
  assert.equal(proposal.status, 'PENDING');
  assert.equal(proposal.collectedApprovals, 0);
  assert.equal(proposal.requiredApprovals, 2, 'the current on-chain threshold is what Safe will enforce');
  assert.match(proposal.safeTxHash, /^0x[0-9a-f]{64}$/);

  // Owner management is the Safe calling itself.
  assert.equal(getAddress(proposal.safeTransaction.to), getAddress(circle.safeAddress));
  assert.equal(proposal.safeTransaction.operation, 0, 'never delegatecall');
  assert.equal(proposal.safeTransaction.value, '0');
  const { functionName, args } = decodeFunctionData({ abi: OWNER_ABI, data: proposal.safeTransaction.data });
  assert.equal(functionName, 'addOwnerWithThreshold');
  assert.equal(getAddress(args[0]), getAddress(zainab.accountAddress));
  assert.equal(args[1], 2n);
});

test('prepare-add: the gas-refund fields are neutral, so no second payment hides inside the first', async () => {
  const { circles, ada, circle, identityService } = await circleOfThree();
  await makeIdentity(identityService, { name: 'Zainab', handle: 'zainab' });
  const proposal = await circles.prepareAddAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, handle: '@zainab' });

  const tx = proposal.safeTransaction;
  assert.equal(tx.gasPrice, '0');
  assert.equal(tx.baseGas, '0');
  assert.equal(tx.safeTxGas, '0');
  assert.equal(tx.gasToken, '0x0000000000000000000000000000000000000000');
  assert.equal(tx.refundReceiver, '0x0000000000000000000000000000000000000000');
});

test('prepare-remove: derives the predecessor from the live owner list', async () => {
  const { circles, ada, tobi, circle, fake } = await circleOfThree();
  const owners = fake.safeAt(circle.safeAddress).owners;
  const index = owners.findIndex((o) => o.toLowerCase() === tobi.accountAddress.toLowerCase());
  const expectedPrev = index === 0 ? '0x0000000000000000000000000000000000000001' : owners[index - 1];

  const proposal = await circles.prepareRemoveAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: tobi.prismId });

  const { functionName, args } = decodeFunctionData({ abi: OWNER_ABI, data: proposal.safeTransaction.data });
  assert.equal(functionName, 'removeOwner');
  assert.equal(getAddress(args[0]), getAddress(expectedPrev), 'prevOwner comes from the live linked list');
  assert.equal(getAddress(args[1]), getAddress(tobi.accountAddress));
  assert.equal(args[2], 2n);
});

test('owner removal cannot leave an invalid threshold', async () => {
  // A 3-of-3 Circle: removing anyone would leave 3-of-2, which Safe rejects outright.
  const { circles, ada, tobi, circle } = await circleOfThree({ threshold: 3 });

  await assert.rejects(
    () => circles.prepareRemoveAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: tobi.prismId }),
    /must also choose a new approvals-required value of at most 2/
  );

  // Naming a valid new threshold in the same proposal is the way through.
  const ok = await circles.prepareRemoveAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: tobi.prismId, threshold: 2 });
  const { args } = decodeFunctionData({ abi: OWNER_ABI, data: ok.safeTransaction.data });
  assert.equal(args[2], 2n);

  // And a still-impossible threshold is refused.
  await assert.rejects(
    () => circles.prepareRemoveAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: tobi.prismId, threshold: 3 }),
    /exceeds the 2 admins/
  );
});

test('a Circle must keep at least one admin', async () => {
  const stack = await circleStack();
  const solo = await makeIdentity(stack.identityService, { name: 'Solo' });
  const circle = await stack.circles.createCircle({
    creatorPrismId: solo.prismId, name: 'Just me', template: 'CUSTOM', admins: [], threshold: 1,
    policyAcknowledgement: acknowledgement({ threshold: 1, adminCount: 1 })
  });
  assert.equal(circle.status, 'ACTIVE');

  await assert.rejects(
    () => stack.circles.prepareRemoveAdmin({ circleId: circle.circleId, actorPrismId: solo.prismId, prismId: solo.prismId }),
    /must keep at least one admin/
  );
});

test('threshold cannot be set to zero, or above the admin count', async () => {
  const { circles, ada, circle } = await circleOfThree();

  await assert.rejects(() => circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 0 }), /at least 1/);
  await assert.rejects(() => circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 4 }), /exceeds the 3 admins/);
  await assert.rejects(() => circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 2 }), /already the number of approvals/);

  const ok = await circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 3 });
  const { functionName, args } = decodeFunctionData({ abi: OWNER_ABI, data: ok.safeTransaction.data });
  assert.equal(functionName, 'changeThreshold');
  assert.equal(args[0], 3n);
});

test('adding an admin who is already one is refused', async () => {
  const { circles, ada, tobi, circle } = await circleOfThree();
  await assert.rejects(
    () => circles.prepareAddAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: tobi.prismId }),
    /already an admin/
  );
});

test('growing the Circle may raise the threshold in the same transaction', async () => {
  const { circles, ada, circle, identityService } = await circleOfThree();
  await makeIdentity(identityService, { name: 'Zainab', handle: 'zainab' });

  const proposal = await circles.prepareAddAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, handle: '@zainab', threshold: 3 });
  const { args } = decodeFunctionData({ abi: OWNER_ABI, data: proposal.safeTransaction.data });
  assert.equal(args[1], 3n);
  assert.equal(proposal.subject.ownerCountAfter, 4);

  // A threshold above the post-change owner count is still impossible.
  await assert.rejects(
    () => circles.prepareAddAdmin({ circleId: circle.circleId, actorPrismId: ada.prismId, handle: '@zainab', threshold: 5 }),
    /exceeds the 4 admins/
  );
});

test('only an admin may prepare a governance change', async () => {
  const { circles, ada, circle, identityService } = await circleOfThree();
  const viewer = await makeIdentity(identityService, { name: 'Viewer' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: viewer.prismId, role: 'VIEWER' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: viewer.prismId });

  await assert.rejects(() => circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: viewer.prismId, threshold: 3 }), /only an admin/);

  const stranger = await makeIdentity(identityService, { name: 'Stranger' });
  await assert.rejects(() => circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: stranger.prismId, threshold: 3 }), /circle not found/);
});

test('pending: approvals are counted from verified signatures, never from a Prism counter', async () => {
  const { circles, ada, tobi, circle, store } = await circleOfThree();
  await circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 3 });

  let pending = await circles.listPending(circle.circleId, ada.prismId);
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].collectedApprovals, 0);
  assert.equal(pending.pending[0].status, 'PENDING');

  // Inflate the stored counter, exactly as a buggy or compromised backend would.
  const proposalId = pending.pending[0].proposalId;
  store.mutate((d) => { d.circleProposals[proposalId].collectedApprovals = 99; });

  pending = await circles.listPending(circle.circleId, ada.prismId);
  assert.equal(pending.pending[0].collectedApprovals, 0, 'the count comes from signature evidence');
  assert.equal(pending.pending[0].status, 'PENDING');
});

test('pending: an approval from a since-removed admin stops counting', async () => {
  const { circles, ada, tobi, circle, store, fake } = await circleOfThree();
  const prepared = await circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 3 });

  // Two genuine approvals are on record.
  store.mutate((d) => {
    for (const who of [ada, tobi]) {
      d.circleApprovals[`${prepared.proposalId}:${who.prismId}`] = {
        proposalId: prepared.proposalId, prismId: who.prismId,
        authorityAddress: getAddress(who.accountAddress), signatureType: 'ECDSA',
        signature: `0x${'11'.repeat(65)}`, approvedAt: new Date().toISOString()
      };
    }
  });
  let pending = await circles.listPending(circle.circleId, ada.prismId);
  assert.equal(pending.pending[0].collectedApprovals, 2);
  assert.equal(pending.pending[0].status, 'READY');

  // Tobi is removed from the Safe. His signature is still on file, but he is no longer an owner, so
  // Safe would not honour it — and neither does Prism.
  const remaining = fake.safeAt(circle.safeAddress).owners.filter((o) => o.toLowerCase() !== tobi.accountAddress.toLowerCase());
  fake.forceOwners(circle.safeAddress, remaining, 2);

  pending = await circles.listPending(circle.circleId, ada.prismId);
  assert.equal(pending.pending[0].collectedApprovals, 1);
  assert.equal(pending.pending[0].status, 'PENDING');
});

test('pending: a proposal built against a spent nonce can never execute and says so', async () => {
  const { circles, ada, circle, fake } = await circleOfThree();
  await circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 3 });

  // Some other Circle transaction executed first, consuming the nonce this proposal was built on.
  fake.bumpNonce(circle.safeAddress, 5);

  const pending = await circles.listPending(circle.circleId, ada.prismId);
  assert.equal(pending.pending[0].staleNonce, true);
  assert.equal(pending.pending[0].status, 'EXPIRED');
});

test('pending: when Monad cannot be read, approvals are unknown rather than assumed', async () => {
  const { circles, ada, circle, fake } = await circleOfThree();
  await circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 3 });

  fake.knobs.readFails = true;
  const pending = await circles.listPending(circle.circleId, ada.prismId);
  assert.equal(pending.pending.length, 0);
  assert.match(pending.unavailable, /could not be read/);
});

test('governance is refused on a Circle that is not verified on-chain', async () => {
  const { circles, ada, circle, store } = await circleOfThree();
  store.mutate((d) => { d.circles[circle.circleId].status = 'CONFIRMING'; });

  await assert.rejects(
    () => circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 3 }),
    /not active on-chain yet/
  );
});

test('recording an approval requires a real signature from the approver\'s own authority', async () => {
  const { circles, ada, tobi, circle, store } = await circleOfThree();
  const proposal = await circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 3 });

  // Ada approves with her real Prism authority key, over the real digest.
  const signature = await ada.account.sign({ hash: proposal.safeTxHash });
  const recorded = await circles.recordApproval({ circleId: circle.circleId, proposalId: proposal.proposalId, prismId: ada.prismId, signature });
  assert.equal(recorded.approvedBy, ada.prismId);
  assert.equal(recorded.signatureType, 'ECDSA');

  const pending = await circles.listPending(circle.circleId, ada.prismId);
  assert.equal(pending.pending[0].collectedApprovals, 1);
  assert.equal(pending.pending[0].status, 'PENDING', 'one of two is not enough');

  // Tobi cannot approve using Ada's signature: the recovered address is not his authority.
  await assert.rejects(
    () => circles.recordApproval({ circleId: circle.circleId, proposalId: proposal.proposalId, prismId: tobi.prismId, signature }),
    /signed by a different account than your Prism authority/
  );

  // A signature over a different digest does not recover to any admin.
  const wrongDigest = await ada.account.sign({ hash: `0x${'99'.repeat(32)}` });
  await assert.rejects(
    () => circles.recordApproval({ circleId: circle.circleId, proposalId: proposal.proposalId, prismId: ada.prismId, signature: wrongDigest }),
    /not signed by a current admin/
  );

  // Tobi's own approval reaches the threshold, and READY is derived, never stored.
  const tobiSignature = await tobi.account.sign({ hash: proposal.safeTxHash });
  await circles.recordApproval({ circleId: circle.circleId, proposalId: proposal.proposalId, prismId: tobi.prismId, signature: tobiSignature });
  const ready = await circles.listPending(circle.circleId, ada.prismId);
  assert.equal(ready.pending[0].collectedApprovals, 2);
  assert.equal(ready.pending[0].status, 'READY');
  assert.equal(store.read().circleProposals[proposal.proposalId].status, 'PENDING', 'the stored status is not what READY is read from');
});

test('a non-admin cannot record an approval even with a valid signature', async () => {
  const { circles, ada, circle, identityService } = await circleOfThree();
  const proposal = await circles.prepareThresholdChange({ circleId: circle.circleId, actorPrismId: ada.prismId, threshold: 3 });
  const viewer = await makeIdentity(identityService, { name: 'Viewer' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: viewer.prismId, role: 'VIEWER' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: viewer.prismId });

  const signature = await viewer.account.sign({ hash: proposal.safeTxHash });
  await assert.rejects(
    () => circles.recordApproval({ circleId: circle.circleId, proposalId: proposal.proposalId, prismId: viewer.prismId, signature }),
    /only an admin/
  );
});
