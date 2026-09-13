import test from 'node:test';
import assert from 'node:assert/strict';
import { circleStack, makeIdentity, acknowledgement } from './circles-harness.js';

/**
 * Membership and invitations.
 *
 * The load-bearing rule: an invitation is a Prism fact, and admin authority is a Monad fact. Prism
 * can record that someone accepted; only the Safe's owner set can make them an admin. Every test
 * below is an attempt to blur that line, and an assertion that it does not blur.
 */

async function circleOfTwo() {
  const stack = await circleStack();
  const ada = await makeIdentity(stack.identityService, { name: 'Ada', handle: 'ada' });
  const tobi = await makeIdentity(stack.identityService, { name: 'Tobi', handle: 'tobi' });
  const circle = await stack.circles.createCircle({
    creatorPrismId: ada.prismId, name: 'Household', template: 'FAMILY',
    admins: [{ prismId: tobi.prismId }], threshold: 1,
    policyAcknowledgement: acknowledgement({ threshold: 1, adminCount: 2, warnings: ['ANY_ADMIN_ALONE'] })
  });
  return { ...stack, ada, tobi, circle };
}

test('member invitation: an admin can invite by @handle, and the invitee becomes a member on accept', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });

  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, handle: '@kemi', role: 'CONTRIBUTOR' });
  assert.equal(invite.status, 'PENDING');
  assert.equal(invite.role, 'CONTRIBUTOR');

  // Before accepting, they are INVITED — visible, but not a participant.
  const invited = circles.listMembers(circle.circleId, ada.prismId).find((m) => m.prismId === kemi.prismId);
  assert.equal(invited.status, 'INVITED');

  const accepted = circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });
  assert.equal(accepted.status, 'ACTIVE');
  const member = circles.listMembers(circle.circleId, ada.prismId).find((m) => m.prismId === kemi.prismId);
  assert.equal(member.role, 'CONTRIBUTOR');
  assert.equal(member.status, 'ACTIVE');
});

test('accepting an ADMIN invitation does NOT grant admin authority', async () => {
  const { circles, ada, circle, identityService, fake } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });

  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'ADMIN' });
  const accepted = circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });

  assert.equal(accepted.status, 'PENDING_ACTIVATION');
  assert.equal(accepted.authorityConfirmedOnChain, false);
  assert.match(accepted.note, /only once the Circle approves adding you on Monad/);

  // And the chain agrees: they are not an owner of the Safe.
  const owners = fake.safeAt(circle.safeAddress).owners.map((o) => o.toLowerCase());
  assert.ok(!owners.includes(kemi.accountAddress.toLowerCase()), 'accepting must not touch the Safe');

  const member = circles.listMembers(circle.circleId, ada.prismId).find((m) => m.prismId === kemi.prismId);
  assert.equal(member.authorityConfirmedOnChain, false);
});

test('admin authority turns ACTIVE only when the Safe owner set confirms it', async () => {
  const { circles, ada, circle, identityService, fake } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'ADMIN' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });

  // The owner-add proposal is approved and executes on-chain — simulated here as the Safe's owner
  // set simply changing, which is all Prism ever gets to observe.
  const owners = fake.safeAt(circle.safeAddress).owners;
  fake.forceOwners(circle.safeAddress, [...owners, kemi.accountAddress], 1);

  const read = await circles.getCircle(circle.circleId, ada.prismId);
  const member = read.members.find((m) => m.prismId === kemi.prismId);
  assert.equal(member.status, 'ACTIVE');
  assert.equal(member.authorityConfirmedOnChain, true);
  assert.equal(read.authority.adminCount, 3);
});

test('an admin removed on-chain stops being an admin in Prism', async () => {
  const { circles, ada, tobi, circle, fake } = await circleOfTwo();

  // Tobi is removed by an approved Safe transaction; Prism only learns by reading the owner set.
  fake.forceOwners(circle.safeAddress, [ada.accountAddress], 1);

  const read = await circles.getCircle(circle.circleId, ada.prismId);
  const member = read.members.find((m) => m.prismId === tobi.prismId);
  assert.equal(member.status, 'REMOVED');
  assert.ok(member.removedAt);
  assert.equal(read.authority.adminCount, 1);
});

test('invitation replay: an invitation can be consumed exactly once', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'VIEWER' });

  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });
  assert.throws(
    () => circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId }),
    /already accepted/
  );
  // Declining a spent invitation is refused too — the invitation is gone, not merely answered.
  assert.throws(
    () => circles.declineInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId }),
    /already accepted/
  );
});

test('an invitation cannot be redeemed by anyone other than its invitee', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi' });
  const mallory = await makeIdentity(identityService, { name: 'Mallory' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'ADMIN' });

  assert.throws(
    () => circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: mallory.prismId }),
    /belongs to someone else/
  );
});

test('a removed user cannot regain their role from a stale invitation', async () => {
  const { circles, ada, circle, identityService, store, fake } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi' });

  // Kemi is invited as an admin and accepts, then is removed from the Circle. The old invitation
  // record is still sitting there — this is exactly the object an attacker would reach for.
  const first = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'ADMIN' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: first.inviteId, prismId: kemi.prismId });

  store.mutate((d) => {
    // A second, still-PENDING invitation issued before the removal.
    d.circleInvitations['inv_stale'] = {
      inviteId: 'inv_stale', circleId: circle.circleId, role: 'ADMIN',
      invitedPrismId: kemi.prismId, invitedByPrismId: ada.prismId, status: 'PENDING',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), respondedAt: null
    };
    const member = d.circleMembers[`${circle.circleId}:${kemi.prismId}`];
    member.status = 'REMOVED';
    member.removedAt = new Date().toISOString();
  });
  assert.throws(
    () => circles.acceptInvitation({ circleId: circle.circleId, inviteId: 'inv_stale', prismId: kemi.prismId }),
    /no longer valid; ask an admin for a new one/
  );
  // The stale invitation is burned, not left for a second attempt.
  assert.equal(store.read().circleInvitations['inv_stale'].status, 'REVOKED');
  // And they are still not an owner.
  const owners = fake.safeAt(circle.safeAddress).owners.map((o) => o.toLowerCase());
  assert.ok(!owners.includes(kemi.accountAddress.toLowerCase()));
});

test('an expired invitation is refused and marked expired', async () => {
  const { circles, ada, circle, identityService, store } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'VIEWER' });

  store.mutate((d) => { d.circleInvitations[invite.inviteId].expiresAt = new Date(Date.now() - 1000).toISOString(); });

  assert.throws(() => circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId }), /expired/);
  assert.equal(store.read().circleInvitations[invite.inviteId].status, 'EXPIRED');
});

test('declining leaves the Circle and does not keep a membership row alive', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'VIEWER' });

  circles.declineInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });
  assert.equal(circles.listCircles(kemi.prismId).length, 0);
  assert.throws(() => circles.listMembers(circle.circleId, kemi.prismId), /circle not found/);
});

test('only an admin can invite, and nobody can invite into someone else\'s Circle', async () => {
  const { circles, circle, identityService, ada } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi' });
  const stranger = await makeIdentity(identityService, { name: 'Stranger' });

  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'VIEWER' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });

  // A VIEWER is a member but holds no invite power.
  assert.throws(() => circles.invite({ circleId: circle.circleId, actorPrismId: kemi.prismId, prismId: stranger.prismId, role: 'VIEWER' }), /only an admin/);
  // A non-member cannot even see that the Circle exists.
  assert.throws(() => circles.invite({ circleId: circle.circleId, actorPrismId: stranger.prismId, prismId: kemi.prismId, role: 'VIEWER' }), /circle not found/);
});

test('inviting someone who is already in the Circle is refused', async () => {
  const { circles, ada, tobi, circle } = await circleOfTwo();
  assert.throws(
    () => circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: tobi.prismId, role: 'VIEWER' }),
    /already part of this Circle/
  );
});

test('an invitation carries no phone number, address, or other private identity material', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'VIEWER' });

  const serialized = JSON.stringify(invite);
  assert.ok(!serialized.includes(kemi.accountAddress), 'no wallet address in an invitation');
  assert.deepEqual(Object.keys(invite).sort(), ['circleId', 'expiresAt', 'inviteId', 'role', 'status']);
});
