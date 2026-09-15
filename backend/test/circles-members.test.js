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

// ===========================================================================
// The member page: roles, removal, and the two things it must refuse
// ===========================================================================
//
// The Member screen offers "Change permissions" and "Remove from Circle". Both are Prism-side
// edits, and both have an on-chain shadow that makes them dangerous if taken at face value: an
// admin's authority is the Safe's owner set, and a spender's limit is an allowance on the module.
// Everything below is an attempt to use the cheap Prism-side edit to achieve the expensive
// on-chain one, and an assertion that it fails.

test('member roles: an admin can move someone between the roles Prism alone decides', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'VIEWER' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });

  const changed = await circles.setMemberRole({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'CONTRIBUTOR' });
  assert.equal(changed.role, 'CONTRIBUTOR');
  assert.equal(changed.unchanged, false);
  assert.equal(circles.listMembers(circle.circleId, ada.prismId).find((m) => m.prismId === kemi.prismId).role, 'CONTRIBUTOR');

  // Re-applying the same role is a no-op rather than an error: the UI may be a tap behind.
  const again = await circles.setMemberRole({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'CONTRIBUTOR' });
  assert.equal(again.unchanged, true);
});

test('member roles: ADMIN cannot be granted by a role change — only the Safe confers authority', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'CONTRIBUTOR' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });

  await assert.rejects(
    () => circles.setMemberRole({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'ADMIN' }),
    /approving it on Monad/);
  assert.equal(circles.listMembers(circle.circleId, ada.prismId).find((m) => m.prismId === kemi.prismId).role, 'CONTRIBUTOR');
});

test('member roles: an existing admin cannot be demoted by a role change either', async () => {
  const { circles, ada, tobi, circle } = await circleOfTwo();
  await assert.rejects(
    () => circles.setMemberRole({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: tobi.prismId, role: 'VIEWER' }),
    /approved on Monad/);
  assert.equal(circles.listMembers(circle.circleId, ada.prismId).find((m) => m.prismId === tobi.prismId).role, 'ADMIN');
});

test('member removal: an admin can remove an ordinary member, and their pending invite dies with them', async () => {
  const { circles, ada, circle, identityService, store } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'CONTRIBUTOR' });

  // Removed while the invitation is still unanswered — the invitation must not survive to re-admit them.
  const removed = await circles.removeMember({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId });
  assert.equal(removed.status, 'REMOVED');
  assert.equal(store.read().circleInvitations[invite.inviteId].status, 'REVOKED');

  // `acceptInvitation` is synchronous, so this is assert.throws — assert.rejects would let a
  // synchronous throw past its validation entirely.
  assert.throws(
    () => circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId }),
    /already revoked|no longer valid/);
});

test('member removal: removing someone twice is idempotent, not an error', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'VIEWER' });
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });

  await circles.removeMember({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId });
  const second = await circles.removeMember({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId });
  assert.equal(second.alreadyRemoved, true);
});

test('member removal: an admin cannot be removed here — it names the governance action instead', async () => {
  const { circles, ada, tobi, circle } = await circleOfTwo();
  await assert.rejects(
    () => circles.removeMember({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: tobi.prismId }),
    /Remove as admin/);
  assert.equal(circles.listMembers(circle.circleId, ada.prismId).find((m) => m.prismId === tobi.prismId).status, 'ACTIVE');
});

test('member removal: only an admin may remove or re-role anyone', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const zara = await makeIdentity(identityService, { name: 'Zara', handle: 'zara' });
  for (const [person, role] of [[kemi, 'CONTRIBUTOR'], [zara, 'VIEWER']]) {
    const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: person.prismId, role });
    circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: person.prismId });
  }
  await assert.rejects(
    () => circles.removeMember({ circleId: circle.circleId, actorPrismId: kemi.prismId, prismId: zara.prismId }),
    /admin/);
  await assert.rejects(
    () => circles.setMemberRole({ circleId: circle.circleId, actorPrismId: kemi.prismId, prismId: zara.prismId, role: 'SPENDER' }),
    /admin/);
});

test('my invitations: an invited person can find the invitation addressed to them', async () => {
  const { circles, ada, circle, identityService } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const zara = await makeIdentity(identityService, { name: 'Zara', handle: 'zara' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'SPENDER' });

  const mine = circles.listMyInvitations(kemi.prismId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].inviteId, invite.inviteId);
  assert.equal(mine[0].circleName, 'Household');
  assert.equal(mine[0].role, 'SPENDER');
  // Who is asking is never omitted — it is the thing that makes an invitation trustworthy.
  assert.equal(mine[0].invitedBy, 'Ada');

  // Nobody else can see it.
  assert.equal(circles.listMyInvitations(zara.prismId).length, 0);

  // Once answered it leaves the list, so the UI cannot offer an invitation that is already spent.
  circles.acceptInvitation({ circleId: circle.circleId, inviteId: invite.inviteId, prismId: kemi.prismId });
  assert.equal(circles.listMyInvitations(kemi.prismId).length, 0);
});

test('my invitations: an expired invitation is not offered', async () => {
  const { circles, ada, circle, identityService, store } = await circleOfTwo();
  const kemi = await makeIdentity(identityService, { name: 'Kemi', handle: 'kemi' });
  const invite = circles.invite({ circleId: circle.circleId, actorPrismId: ada.prismId, prismId: kemi.prismId, role: 'VIEWER' });
  store.mutate((d) => { d.circleInvitations[invite.inviteId].expiresAt = new Date(Date.now() - 1000).toISOString(); });
  assert.equal(circles.listMyInvitations(kemi.prismId).length, 0);
});
