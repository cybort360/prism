import test from 'node:test';
import assert from 'node:assert/strict';
import { circleStack, makeIdentity, acknowledgement, resolveRecipient } from './circles-harness.js';
import { CircleMessageService } from '../src/services/circleMessageService.js';

const USD = (dollars) => String(BigInt(Math.round(dollars * 100)) * 10_000n);

/** 2-of-2 Circle with a threshold payment proposed to an outsider recipient. */
async function circleWithProposal() {
  const stack = await circleStack({ withPayments: true });
  const octane = await makeIdentity(stack.identityService, { name: 'Octane', handle: 'octane' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const zainab = await makeIdentity(stack.identityService, { name: 'Zainab', handle: 'zainab' });
  const circle = await stack.circles.createCircle({
    creatorPrismId: octane.prismId, name: 'Retreat', template: 'TRIP',
    admins: [{ prismId: tobi.prismId }], threshold: 2,
    policyAcknowledgement: acknowledgement({ threshold: 2, adminCount: 2, warnings: ['NO_SPARE_AUTHORITY'] })
  });
  const resolution = resolveRecipient({ resolverService: stack.resolverService, requesterPrismId: octane.prismId, target: zainab });
  const payment = await stack.circles.proposePayment({
    circleId: circle.circleId, actorPrismId: octane.prismId, resolution,
    amountAtomic: USD(140), memo: 'Hotel deposit for retreat'
  });
  const messages = new CircleMessageService({
    store: stack.store, config: stack.config,
    circleService: stack.circles, identityService: stack.identityService
  });
  return { ...stack, circle, octane, tobi, zainab, payment, messages };
}

function statusOf(e) {
  return e?.statusCode;
}

// --- member post + chronological read ------------------------------------------------

test('member posts a contextual message; thread reads back in order', async (t) => {
  const s = await circleWithProposal();
  t.after(s.restoreProvider);
  const posted = await s.messages.postProposalMessage({
    circleId: s.circle.circleId, proposalId: s.payment.proposalId,
    authorPrismId: s.octane.prismId,
    text: 'Hotel deposit for retreat — invoice INV-2041 attached by email'
  });
  assert.match(posted.messageId, /^msg_/);
  assert.equal(posted.authorPrismId, s.octane.prismId);
  assert.ok(posted.createdAt);

  await s.messages.postProposalMessage({
    circleId: s.circle.circleId, proposalId: s.payment.proposalId,
    authorPrismId: s.tobi.prismId, text: 'Seconding — venue holds the rooms until Friday'
  });
  await s.messages.postProposalMessage({
    circleId: s.circle.circleId, proposalId: s.payment.proposalId,
    authorPrismId: s.octane.prismId, text: 'Receipt will follow once paid',
    attachmentHash: `0x${'ab'.repeat(32)}`
  });

  const thread = await s.messages.getProposalMessages({
    circleId: s.circle.circleId, proposalId: s.payment.proposalId, requesterPrismId: s.tobi.prismId
  });
  assert.equal(thread.messages.length, 3);
  assert.deepEqual(
    thread.messages.map((m) => m.text),
    ['Hotel deposit for retreat — invoice INV-2041 attached by email', 'Seconding — venue holds the rooms until Friday', 'Receipt will follow once paid']
  );
  for (let i = 1; i < thread.messages.length; i++) {
    assert.ok(thread.messages[i].createdAt >= thread.messages[i - 1].createdAt, 'chronological');
  }
  assert.equal(thread.messages[2].attachmentHash, `0x${'ab'.repeat(32)}`);
});

// --- access control: non-members get 403 ------------------------------------------------

test('non-member post and read are forbidden (403)', async (t) => {
  const s = await circleWithProposal();
  t.after(s.restoreProvider);
  const stranger = await makeIdentity(s.identityService, { name: 'Stranger', handle: 'stranger' });
  await assert.rejects(
    () => s.messages.postProposalMessage({
      circleId: s.circle.circleId, proposalId: s.payment.proposalId,
      authorPrismId: stranger.prismId, text: 'let me in'
    }),
    (e) => statusOf(e) === 403
  );
  await assert.rejects(
    () => s.messages.getProposalMessages({
      circleId: s.circle.circleId, proposalId: s.payment.proposalId, requesterPrismId: stranger.prismId
    }),
    (e) => statusOf(e) === 403
  );
});

// --- privacy: phone numbers rejected ------------------------------------------------------

test('phone numbers in text or metadata are rejected (400, INV-P1)', async (t) => {
  const s = await circleWithProposal();
  t.after(s.restoreProvider);
  const post = (text, attachmentHash = null) => s.messages.postProposalMessage({
    circleId: s.circle.circleId, proposalId: s.payment.proposalId,
    authorPrismId: s.octane.prismId, text, attachmentHash
  });
  await assert.rejects(() => post('call the hotel on +15551234567'), /INV-P1/);
  await assert.rejects(() => post('venue line 415-555-1234'), /INV-P1/);
  await assert.rejects(() => post(''), /empty/);
  await assert.rejects(() => post('x'.repeat(1001)), /at most 1000/);
  await assert.rejects(() => post('ok text', 'not-a-hash'), /attachmentHash/);
  await assert.rejects(
    () => s.messages.postProposalMessage({
      circleId: s.circle.circleId, proposalId: 'prp_doesnotexist00000000',
      authorPrismId: s.octane.prismId, text: 'hello?'
    }),
    (e) => statusOf(e) === 404
  );
});

// --- INV-A1: context never becomes authority -----------------------------------------------

test('INV-A1: ten messages leave the proposal APPROVAL_PENDING with zero approvals', async (t) => {
  const s = await circleWithProposal();
  t.after(s.restoreProvider);
  for (let i = 0; i < 10; i++) {
    await s.messages.postProposalMessage({
      circleId: s.circle.circleId, proposalId: s.payment.proposalId,
      authorPrismId: i % 2 ? s.tobi.prismId : s.octane.prismId,
      text: `context note ${i + 1}: still just explaining the hotel deposit`
    });
  }
  const view = await s.circles.getPayment({
    circleId: s.circle.circleId, proposalId: s.payment.proposalId, prismId: s.octane.prismId
  });
  assert.equal(view.lifecycle, 'APPROVAL_PENDING');
  assert.equal(view.collectedApprovals ?? 0, 0);
  assert.equal(view.requiredApprovals, 2, 'threshold untouched by chatter');
  const thread = await s.messages.getProposalMessages({
    circleId: s.circle.circleId, proposalId: s.payment.proposalId, requesterPrismId: s.octane.prismId
  });
  assert.equal(thread.messages.length, 10);
});
