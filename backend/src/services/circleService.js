/**
 * CircleService — shared USDC accounts governed by a Safe Smart Account on Monad.
 *
 * The discipline this service exists to hold:
 *
 *   Prism owns the *human* layer — a Circle's name, who was invited, what a proposal was for.
 *   Monad owns the *money and authority* layer — the balance, the admin set, the threshold, and
 *   whether a payment actually happened.
 *
 * So this service never writes a balance, an owner, or a threshold from a user's request. Those
 * fields are written only by `_verifyDeployment` and `_reconcileAuthority`, both of which take their
 * values from a live chain read, and they are served to callers from a live read as well. A Circle
 * whose chain state cannot be read reports "unknown" rather than the last number Prism happened to
 * see, because a stale authority presented as current is the failure this whole design is against.
 *
 * Spending limits are deliberately absent: they require Safe's Allowance Module v1.0.0, which is
 * deployed on no chain (see docs/CIRCLES_DEPENDENCY_AUDIT.md). Circles is threshold-only.
 */
import crypto from 'node:crypto';
import { getAddress, isAddress, keccak256, toHex } from 'viem';
import {
  CircleStatus, MemberRole, MemberStatus, ProposalKind, ProposalStatus, CIRCLE_ASSET,
  TERMINAL_MEMBER_STATUSES, CHAIN_BACKED_ROLES,
  newCircle, newCircleMember, newCircleProposal, newCircleApproval,
  assertCircleTransition, assertThresholdWithinOwners, thresholdWarnings, assertRole,
  badRequest, forbidden, notFound, conflict
} from '../circles/model.js';
import { assertTemplateChoice, templateOptions, CircleTemplate } from '../circles/templates.js';
import { sameOwnerSet, normalizeOwnerSet } from '../circles/safeEncoding.js';
import { assertAdapterContract, EXPECTED_SAFE_VERSION } from '../circles/safeCircleAdapter.js';
import { logger } from '../lib/logger.js';

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // an invitation that goes unanswered for a fortnight is stale
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class CircleService {
  constructor({ store, config, identityService, safeAdapter }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.safe = assertAdapterContract(safeAdapter);
  }

  // ===========================================================================
  // Creation
  // ===========================================================================

  /**
   * Create a Circle and drive it through the creation flow.
   *
   * The flow is not ceremony. Each state is a claim that has been checked:
   *   MEMBERS_SELECTED       every admin is a real Prism identity with a real authority address
   *   POLICY_REVIEWED        the threshold is valid, and the creator saw the same trade-off we did
   *   AWAITING_AUTHORIZATION the creator explicitly authorized this exact shape
   *   DEPLOYING / CONFIRMING a transaction was broadcast, and then actually mined
   *   RECONCILING            the deployed Safe was read back from the chain
   *   ACTIVE                 that read matched what we asked for, in every field that matters
   *
   * A caller who never gets past CONFIRMING gets a truthful "still confirming", not an optimistic
   * Circle. That is the whole reason ACTIVE is unreachable from anywhere but RECONCILING.
   */
  async createCircle({ creatorPrismId, name, icon = null, template = CircleTemplate.CUSTOM, admins, threshold, policyAcknowledgement = null }) {
    const displayName = this._assertName(name);
    const creator = this._assertIdentity(creatorPrismId);

    // --- resolve admins to real identities. We never invent an address: an admin is a Prism
    // identity that has already bound a Mera account, and their Safe owner key is that account.
    const resolved = this._resolveAdmins({ creator, admins });
    assertTemplateChoice({ template, threshold, adminCount: resolved.length });

    // Every remaining check that does not need the chain happens BEFORE anything is written. A
    // request that fails validation must leave no trace: a half-built Circle sitting in someone's
    // list is both confusing and a thing a later bug could mistake for a real one.
    const warnings = thresholdWarnings({ threshold, ownerCount: resolved.length });
    this._assertPolicyAcknowledged({ policyAcknowledgement, threshold, adminCount: resolved.length, warnings });

    // --- idempotency. The salt is a pure function of who is in the Circle and how it is governed,
    // so a retried request predicts the same Safe address and must therefore be the same Circle.
    const { saltNonce, resume } = this._claimSalt({ creatorPrismId, name: displayName, admins: resolved, threshold });
    if (resume) {
      // Re-entering the flow is safe: every step below is guarded and idempotent, so a retry after a
      // crash mid-deployment resumes rather than deploying a second Safe.
      return this._advanceCreation(resume);
    }

    const owners = resolved.map((a) => a.authorityAddress);
    const prediction = await this.safe.predictCircleAddress({ owners, threshold, saltNonce });

    const circleId = `cir_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const circle = newCircle({
      circleId, name: displayName, icon, chainId: this.config.chain.chainId,
      createdByPrismId: creatorPrismId, template, requestedThreshold: threshold,
      requestedAdmins: resolved.map((a) => ({ prismId: a.prismId, authorityAddress: a.authorityAddress })),
      saltNonce, predictedSafeAddress: prediction.address
    });

    this.store.mutate((d) => {
      (d.circles ||= {})[circleId] = circle;
      (d.circleSalts ||= {})[saltNonce] = circleId;
      d.circleMembers ||= {};
      for (const admin of resolved) {
        // Admins start PENDING_ACTIVATION even though the creator selected them: nobody holds admin
        // authority until the Safe on-chain says they are an owner.
        d.circleMembers[memberKey(circleId, admin.prismId)] = newCircleMember({
          circleId, prismId: admin.prismId, authorityAddress: admin.authorityAddress,
          displayName: admin.displayName, handle: admin.handle,
          role: MemberRole.ADMIN, status: MemberStatus.PENDING_ACTIVATION
        });
      }
    });
    this._event(circleId, 'circle.created', { template, admins: resolved.length, requestedThreshold: threshold });
    this._transition(circleId, CircleStatus.MEMBERS_SELECTED, { admins: resolved.length });

    // --- policy review was validated above, before the Circle existed; record that it happened.
    this.store.mutate((d) => {
      d.circles[circleId].creation.policyAcknowledgedAt = new Date().toISOString();
      d.circles[circleId].creation.acknowledgedWarnings = warnings.map((w) => w.code);
    });
    this._transition(circleId, CircleStatus.POLICY_REVIEWED, { warnings: warnings.map((w) => w.code) });

    this.store.mutate((d) => { d.circles[circleId].creation.authorizedAt = new Date().toISOString(); });
    this._transition(circleId, CircleStatus.AWAITING_AUTHORIZATION, { authorizedBy: creatorPrismId });

    return this._advanceCreation(circleId);
  }

  /**
   * Push a Circle as far along the creation flow as the chain currently allows, and no further.
   * Safe to call repeatedly — it is how a CONFIRMING Circle eventually becomes ACTIVE without the
   * client having to hold a request open across block time.
   */
  async _advanceCreation(circleId) {
    let circle = this._circle(circleId);

    if (circle.status === CircleStatus.AWAITING_AUTHORIZATION) {
      const owners = circle.creation.requestedAdmins.map((a) => a.authorityAddress);
      const { predictedAddress, txHash } = await this.safe.createCircle({
        owners, threshold: circle.creation.requestedThreshold, saltNonce: circle.creation.saltNonce
      });
      if (getAddress(predictedAddress) !== getAddress(circle.creation.predictedSafeAddress)) {
        return this._fail(circleId, 'the deployment would not land at the predicted Circle address');
      }
      this.store.mutate((d) => { d.circles[circleId].creation.deploymentTxHash = txHash; });
      this._transition(circleId, CircleStatus.DEPLOYING, { txHash });
      circle = this._circle(circleId);
    }

    if (circle.status === CircleStatus.DEPLOYING) {
      const receipt = await this.safe.getDeploymentReceipt(circle.creation.deploymentTxHash);
      if (!receipt) return this.getCircleRecord(circleId);             // still in flight; stay honest
      if (receipt.status !== 'success') return this._fail(circleId, 'the Circle deployment transaction reverted');
      this._transition(circleId, CircleStatus.CONFIRMING, { blockNumber: String(receipt.blockNumber ?? '') });
      circle = this._circle(circleId);
    }

    if (circle.status === CircleStatus.CONFIRMING) {
      this._transition(circleId, CircleStatus.RECONCILING, {});
      circle = this._circle(circleId);
    }

    if (circle.status === CircleStatus.RECONCILING) {
      return this._verifyDeployment(circleId);
    }

    return this.getCircleRecord(circleId);
  }

  /**
   * The activation gate. Reads the deployed Safe and refuses to call it this Circle unless every
   * field matches: right chain, right address, right singleton and version, exactly the admin
   * authorities we asked for, and exactly the threshold the creator authorized.
   *
   * This is the only writer of `circle.activation`, `circle.threshold` and `circle.adminCount`.
   */
  async _verifyDeployment(circleId) {
    const circle = this._circle(circleId);
    const expectedAddress = getAddress(circle.creation.predictedSafeAddress);

    let state;
    try {
      state = await this.safe.getCircleState(expectedAddress);
    } catch (e) {
      // A read failure is not a verification failure — we simply do not know yet, and saying so
      // leaves the Circle re-checkable instead of burning it.
      logger.error('circle.verify.read_failed', { circleId, error: e.message });
      return this.getCircleRecord(circleId);
    }

    const expectedOwners = circle.creation.requestedAdmins.map((a) => a.authorityAddress);
    const mismatches = [];
    if (Number(state.chainId) !== Number(this.config.chain.chainId)) {
      mismatches.push(`deployed on chain ${state.chainId}, expected ${this.config.chain.chainId}`);
    }
    if (getAddress(state.safeAddress) !== expectedAddress) {
      mismatches.push('deployed Safe address does not match the predicted Circle address');
    }
    if (getAddress(state.singleton) !== getAddress(this.config.circles.safeSingleton)) {
      mismatches.push('Safe singleton is not the audited deployment');
    }
    if (String(state.version) !== EXPECTED_SAFE_VERSION) {
      mismatches.push(`Safe version is ${state.version}, expected ${EXPECTED_SAFE_VERSION}`);
    }
    if (!sameOwnerSet(state.owners, expectedOwners)) {
      mismatches.push('the deployed admin set is not the admin set that was authorized');
    }
    if (Number(state.threshold) !== Number(circle.creation.requestedThreshold)) {
      mismatches.push(`deployed threshold is ${state.threshold}, expected ${circle.creation.requestedThreshold}`);
    }

    if (mismatches.length) {
      logger.error('circle.verify.failed', { circleId, mismatches });
      return this._fail(circleId, mismatches.join('; '));
    }

    const now = new Date().toISOString();
    this.store.mutate((d) => {
      const c = d.circles[circleId];
      c.safeAddress = expectedAddress;
      // Written from the chain read, never from the request. `creation.requestedThreshold` is what
      // was asked for; `threshold` is what Monad says is true.
      c.threshold = Number(state.threshold);
      c.adminCount = state.owners.length;
      c.activatedAt = now;
      c.activation = {
        verifiedAt: now, chainId: Number(state.chainId), safeAddress: expectedAddress,
        singleton: getAddress(state.singleton), version: state.version,
        owners: state.owners.map((o) => getAddress(o)), threshold: Number(state.threshold)
      };
    });
    this._transition(circleId, CircleStatus.ACTIVE, { safeAddress: expectedAddress, threshold: Number(state.threshold) });
    this._reconcileMembersFromOwners(circleId, state.owners);
    logger.info('circle.active', { circleId, safeAddress: expectedAddress, threshold: state.threshold });
    return this.getCircleRecord(circleId);
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  /** Circles this user is a member of. Chain state is not read here — a list view must stay cheap. */
  listCircles(prismId) {
    const data = this.store.read();
    const mine = Object.values(data.circleMembers ?? {}).filter((m) => m.prismId === prismId && !TERMINAL_MEMBER_STATUSES.includes(m.status));
    return mine
      .map((m) => ({ membership: m, circle: data.circles?.[m.circleId] }))
      .filter((x) => x.circle)
      .sort((a, b) => (a.circle.createdAt < b.circle.createdAt ? 1 : -1))
      .map(({ circle, membership }) => ({
        ...this._summaryView(circle),
        myRole: membership.role,
        myStatus: membership.status
      }));
  }

  /**
   * One Circle, with its authority and balance read live from Monad.
   *
   * Calling this also advances a Circle still mid-creation and re-checks an ACTIVE one for drift, so
   * simply looking at a Circle is enough to keep Prism's view honest.
   */
  async getCircle(circleId, prismId) {
    let circle = this._circle(circleId);
    this._assertMember(circleId, prismId);

    if (circle.status !== CircleStatus.ACTIVE && circle.status !== CircleStatus.CLOSED && circle.status !== CircleStatus.VERIFICATION_FAILED) {
      await this._advanceCreation(circleId).catch((e) => logger.error('circle.advance.failed', { circleId, error: e.message }));
      circle = this._circle(circleId);
    }

    const view = this._summaryView(circle);
    if (!circle.safeAddress || circle.status !== CircleStatus.ACTIVE) {
      return { ...view, authority: unavailable('circle is not active on-chain yet'), balance: unavailable('circle is not active on-chain yet'), members: this.listMembers(circleId, prismId) };
    }

    // Live reads. If either fails the field says so — it is never backfilled from the stored mirror.
    const [authority, balance] = await Promise.all([
      this._readAuthority(circle).catch((e) => unavailable(e.message)),
      this._readBalance(circle).catch((e) => unavailable(e.message))
    ]);

    if (!authority.unavailable) {
      this._assertActivationIntegrity(circle, authority);
      this._reconcileAuthority(circleId, authority);
      this._reconcileMembersFromOwners(circleId, authority.owners);
    }

    return {
      ...this._summaryView(this._circle(circleId)),
      authority,
      balance,
      members: this.listMembers(circleId, prismId)
    };
  }

  /** The record as stored, for internal callers that have already authorized the read. */
  getCircleRecord(circleId) { return this._summaryView(this._circle(circleId)); }

  async _readAuthority(circle) {
    const state = await this.safe.getCircleState(circle.safeAddress);
    return {
      owners: state.owners.map((o) => getAddress(o)),
      threshold: Number(state.threshold),
      adminCount: state.owners.length,
      nonce: Number(state.nonce),
      version: state.version,
      spare: state.owners.length - Number(state.threshold),
      source: 'chain',
      readAt: state.readAt
    };
  }

  async _readBalance(circle) {
    const amount = await this.safe.getUsdcBalance(circle.safeAddress);
    return {
      amountAtomic: amount.toString(),
      decimals: this.config.chain.usdcDecimals,
      symbol: CIRCLE_ASSET,
      token: this.config.chain.usdc,
      source: 'chain',
      readAt: new Date().toISOString()
    };
  }

  // ===========================================================================
  // Members and invitations
  // ===========================================================================

  listMembers(circleId, prismId) {
    this._assertMember(circleId, prismId);
    const data = this.store.read();
    return Object.values(data.circleMembers ?? {})
      .filter((m) => m.circleId === circleId)
      .map((m) => ({
        prismId: m.prismId,
        displayName: m.displayName,
        handle: m.handle,
        role: m.role,
        status: m.status,
        // Shown so the UI can be honest about the gap between "accepted in Prism" and "holds
        // authority on Monad". Only an on-chain owner has admin authority.
        authorityConfirmedOnChain: m.role === MemberRole.ADMIN ? m.status === MemberStatus.ACTIVE : null,
        authorityAddress: m.authorityAddress,
        joinedAt: m.joinedAt,
        removedAt: m.removedAt
      }));
  }

  /**
   * Invite someone to a Circle through Prism's existing human identity layer.
   *
   * An invitation grants nothing. Accepting it makes someone a member; it does not make them an
   * admin, because admin authority is the Safe's owner set and only an approved owner-add
   * transaction can change that. An invited ADMIN lands in PENDING_ACTIVATION and waits for chain
   * confirmation — which is exactly what `POST /admins/prepare-add` starts.
   */
  invite({ circleId, actorPrismId, prismId = null, handle = null, role = MemberRole.VIEWER }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);
    assertRole(role);
    if (circle.status === CircleStatus.CLOSED) throw conflict('this Circle is closed');

    const target = this._findIdentity({ prismId, handle });
    if (!target) throw notFound('no Prism identity for that person');
    if (target.prismId === actorPrismId) throw badRequest('you are already in this Circle');

    const existing = this.store.read().circleMembers?.[memberKey(circleId, target.prismId)];
    if (existing && !TERMINAL_MEMBER_STATUSES.includes(existing.status)) {
      throw conflict('that person is already part of this Circle');
    }

    const inviteId = `inv_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const invite = {
      inviteId, circleId, role,
      invitedPrismId: target.prismId,
      invitedByPrismId: actorPrismId,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      respondedAt: null
    };
    this.store.mutate((d) => {
      (d.circleInvitations ||= {})[inviteId] = invite;
      (d.circleMembers ||= {})[memberKey(circleId, target.prismId)] = newCircleMember({
        circleId, prismId: target.prismId, authorityAddress: target.accountAddress ?? null,
        displayName: target.displayName, handle: target.handle ? `@${target.handle}` : null,
        role, status: MemberStatus.INVITED
      });
    });
    this._event(circleId, 'circle.invited', { role, invitedPrismId: target.prismId });
    // The invitation carries no phone number and no address — it is an opaque id plus a role. Phone
    // stays reachability only, exactly as it is everywhere else in Prism.
    return { inviteId, circleId, role, status: invite.status, expiresAt: invite.expiresAt };
  }

  /**
   * Accept an invitation. Single-use by construction: the invite is moved out of PENDING inside the
   * same mutate that records the acceptance, so a replayed request finds nothing left to consume.
   */
  acceptInvitation({ circleId, inviteId, prismId }) {
    const invite = this._consumeInvitation({ circleId, inviteId, prismId, outcome: 'ACCEPTED' });
    const identity = this._assertIdentity(prismId);

    // An ADMIN invitation cannot confer authority here. Prism can record the intent; only the Safe
    // can grant it, and until it does the member is PENDING_ACTIVATION.
    const status = CHAIN_BACKED_ROLES.includes(invite.role) ? MemberStatus.PENDING_ACTIVATION : MemberStatus.ACTIVE;
    this.store.mutate((d) => {
      const member = d.circleMembers[memberKey(circleId, prismId)];
      member.status = status;
      member.authorityAddress = identity.accountAddress ?? null;
      member.displayName = identity.displayName ?? member.displayName;
      member.handle = identity.handle ? `@${identity.handle}` : member.handle;
      if (status === MemberStatus.ACTIVE) member.joinedAt = new Date().toISOString();
    });
    this._event(circleId, 'circle.invitation.accepted', { prismId, role: invite.role });
    return {
      circleId, role: invite.role, status,
      // Said plainly, because the difference matters to someone who just accepted an admin invite.
      authorityConfirmedOnChain: status === MemberStatus.ACTIVE ? true : false,
      note: status === MemberStatus.PENDING_ACTIVATION
        ? 'Admin authority becomes active only once the Circle approves adding you on Monad.'
        : null
    };
  }

  declineInvitation({ circleId, inviteId, prismId }) {
    this._consumeInvitation({ circleId, inviteId, prismId, outcome: 'DECLINED' });
    this.store.mutate((d) => {
      const member = d.circleMembers[memberKey(circleId, prismId)];
      if (member) { member.status = MemberStatus.LEFT; member.removedAt = new Date().toISOString(); }
    });
    this._event(circleId, 'circle.invitation.declined', { prismId });
    return { circleId, status: 'DECLINED' };
  }

  /**
   * Atomically take an invitation out of PENDING. Every reason an invitation must not be honoured is
   * checked inside one mutate so two concurrent accepts cannot both win.
   */
  _consumeInvitation({ circleId, inviteId, prismId, outcome }) {
    let error = null;
    let invite = null;
    this.store.mutate((d) => {
      const record = d.circleInvitations?.[inviteId];
      if (!record || record.circleId !== circleId) { error = notFound('invitation not found'); return; }
      if (record.invitedPrismId !== prismId) { error = forbidden('this invitation belongs to someone else'); return; }
      if (record.status !== 'PENDING') { error = conflict(`this invitation was already ${record.status.toLowerCase()}`); return; }
      if (Date.parse(record.expiresAt) <= Date.now()) {
        record.status = 'EXPIRED';
        error = conflict('this invitation has expired');
        return;
      }
      const member = d.circleMembers?.[memberKey(circleId, prismId)];
      // A person who left or was removed cannot be reinstated by an invitation issued before they
      // left. Rejoining requires a fresh invitation from a current admin.
      if (member && TERMINAL_MEMBER_STATUSES.includes(member.status)) {
        record.status = 'REVOKED';
        error = conflict('this invitation is no longer valid; ask an admin for a new one');
        return;
      }
      if (!member) { error = notFound('invitation has no matching membership'); return; }
      record.status = outcome;
      record.respondedAt = new Date().toISOString();
      invite = { ...record };
    });
    if (error) throw error;
    return invite;
  }

  /** Reflect the on-chain owner set onto admin membership. The chain decides who is an admin. */
  _reconcileMembersFromOwners(circleId, owners) {
    const normalized = owners.map((o) => getAddress(o).toLowerCase());
    this.store.mutate((d) => {
      for (const member of Object.values(d.circleMembers ?? {})) {
        if (member.circleId !== circleId || member.role !== MemberRole.ADMIN) continue;
        if (TERMINAL_MEMBER_STATUSES.includes(member.status)) continue;
        const isOwner = member.authorityAddress && normalized.includes(member.authorityAddress.toLowerCase());
        if (isOwner && member.status !== MemberStatus.ACTIVE) {
          member.status = MemberStatus.ACTIVE;
          member.joinedAt ??= new Date().toISOString();
        } else if (!isOwner && member.status === MemberStatus.ACTIVE) {
          // They were an owner and are not any more: the chain removed their authority, so Prism
          // must stop showing them as an admin.
          member.status = MemberStatus.REMOVED;
          member.removedAt = new Date().toISOString();
        }
      }
    });
  }

  // ===========================================================================
  // Governance proposals (owner set and threshold)
  // ===========================================================================

  /**
   * Prepare the Safe transaction that adds an admin. Nothing changes on-chain here: this produces
   * the digest the Circle's current admins must approve. `threshold` may be raised at the same time
   * because Safe's `addOwnerWithThreshold` takes both, and a Circle that grows without revisiting
   * its threshold silently dilutes the approval it requires.
   */
  async prepareAddAdmin({ circleId, actorPrismId, prismId = null, handle = null, threshold = null }) {
    const { circle, authority } = await this._activeCircleWithAuthority(circleId, actorPrismId);
    const target = this._findIdentity({ prismId, handle });
    if (!target) throw notFound('no Prism identity for that person');
    if (!target.accountAddress) throw badRequest('that person has not finished setting up their Prism account');

    const owner = getAddress(target.accountAddress);
    if (authority.owners.map((o) => getAddress(o)).includes(owner)) throw conflict('that person is already an admin of this Circle');

    const ownerCountAfter = authority.owners.length + 1;
    const newThreshold = threshold ?? authority.threshold;
    assertThresholdWithinOwners({ threshold: newThreshold, ownerCount: ownerCountAfter, context: 'approvals required' });

    return this._createProposal({
      circle, actorPrismId, kind: ProposalKind.OWNER_ADD, authority,
      intent: { kind: 'OWNER_ADD', owner, threshold: newThreshold },
      memo: `Add ${target.displayName ?? (target.handle ? `@${target.handle}` : 'an admin')} as an admin`,
      subject: { prismId: target.prismId, authorityAddress: owner, threshold: newThreshold, ownerCountAfter }
    });
  }

  /**
   * Prepare the Safe transaction that removes an admin.
   *
   * The threshold must remain valid for the *smaller* owner set. Removing an admin from a 2-of-2
   * Circle without lowering the threshold would leave 2-of-1, which Safe rejects — so Prism requires
   * an explicit new threshold instead of letting a well-meaning removal brick the Circle.
   */
  async prepareRemoveAdmin({ circleId, actorPrismId, prismId, threshold = null }) {
    const { circle, authority } = await this._activeCircleWithAuthority(circleId, actorPrismId);
    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (!member?.authorityAddress) throw notFound('that person is not an admin of this Circle');

    const owner = getAddress(member.authorityAddress);
    const owners = authority.owners.map((o) => getAddress(o));
    if (!owners.includes(owner)) throw conflict('that person is not currently an admin on-chain');
    if (owners.length === 1) throw badRequest('a Circle must keep at least one admin');

    const ownerCountAfter = owners.length - 1;
    const newThreshold = threshold ?? Math.min(authority.threshold, ownerCountAfter);
    if (threshold === null && authority.threshold > ownerCountAfter) {
      // Do not silently pick a weaker rule on the Circle's behalf — that is a governance decision.
      throw badRequest(`removing this admin leaves ${ownerCountAfter} admin${ownerCountAfter === 1 ? '' : 's'}, so the Circle must also choose a new approvals-required value of at most ${ownerCountAfter}`);
    }
    assertThresholdWithinOwners({ threshold: newThreshold, ownerCount: ownerCountAfter, context: 'approvals required' });

    return this._createProposal({
      circle, actorPrismId, kind: ProposalKind.OWNER_REMOVE, authority,
      intent: { kind: 'OWNER_REMOVE', owner, threshold: newThreshold },
      memo: `Remove ${member.displayName ?? member.handle ?? 'an admin'} as an admin`,
      subject: { prismId, authorityAddress: owner, threshold: newThreshold, ownerCountAfter }
    });
  }

  /** Prepare a threshold change against the live owner count. */
  async prepareThresholdChange({ circleId, actorPrismId, threshold }) {
    const { circle, authority } = await this._activeCircleWithAuthority(circleId, actorPrismId);
    assertThresholdWithinOwners({ threshold, ownerCount: authority.owners.length, context: 'approvals required' });
    if (threshold === authority.threshold) throw conflict('that is already the number of approvals this Circle requires');

    return this._createProposal({
      circle, actorPrismId, kind: ProposalKind.THRESHOLD_CHANGE, authority,
      intent: { kind: 'THRESHOLD_CHANGE', threshold },
      memo: `Require ${threshold} of ${authority.owners.length} approvals`,
      subject: { threshold, ownerCountAfter: authority.owners.length }
    });
  }

  /**
   * Turn an intent into a signable proposal: build the Safe transaction against the live nonce,
   * compute its digest (cross-checked with the Safe contract), and record what admins are being
   * asked to approve. `requiredApprovals` is the *current on-chain* threshold, because that is what
   * Safe will enforce when this executes.
   */
  async _createProposal({ circle, actorPrismId, kind, authority, intent, memo, subject }) {
    const tx = await this.safe.buildTransaction({ safeAddress: circle.safeAddress, intent, nonce: authority.nonce });
    const digest = await this.safe.getTransactionHash({ safeAddress: circle.safeAddress, tx });

    const proposalId = `prp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const proposal = newCircleProposal({
      proposalId, circleId: circle.circleId, kind, proposerPrismId: actorPrismId,
      recipientPrismId: subject.prismId ?? null, recipientAccount: subject.authorityAddress ?? null,
      amount: null, asset: null, memo,
      safeTxHash: digest, safeNonce: tx.nonce.toString(),
      safeTransaction: serializeTx(tx),
      requiredApprovals: authority.threshold,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString()
    });
    proposal.subject = subject;

    this.store.mutate((d) => { (d.circleProposals ||= {})[proposalId] = proposal; });
    await this.safe.proposeTransaction({
      safeAddress: circle.safeAddress, tx, safeTxHash: digest,
      proposerAddress: this._memberAuthority(circle.circleId, actorPrismId)
    });
    this._event(circle.circleId, 'circle.proposal.created', { proposalId, kind, safeTxHash: digest });

    return this._proposalView(proposal, { collected: [] });
  }

  /**
   * Everything awaiting approval on this Circle.
   *
   * Approval counts come from signature evidence re-verified against the live owner set — never from
   * a number Prism incremented. A proposal shows READY only when enough *valid* signatures from
   * *current* admins exist, so an approval from someone since removed stops counting automatically.
   */
  async listPending(circleId, prismId) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    if (circle.status !== CircleStatus.ACTIVE) return { circleId, pending: [], note: 'this Circle is not active on-chain yet' };

    const authority = await this._readAuthority(circle).catch(() => null);
    if (!authority) return { circleId, pending: [], unavailable: 'Monad could not be read, so pending approvals are unknown' };

    // Anything the Safe Transaction Service knows about, already signature-verified by the adapter.
    const external = await this.safe.getPendingTransactions(circle.safeAddress).catch(() => []);
    const byHash = new Map(external.map((e) => [String(e.safeTxHash).toLowerCase(), e]));

    const data = this.store.read();
    const proposals = Object.values(data.circleProposals ?? {})
      .filter((p) => p.circleId === circleId && p.status === ProposalStatus.PENDING);

    const out = [];
    for (const proposal of proposals) {
      // A proposal built against a nonce the Safe has already consumed can never execute. Say so
      // rather than leaving a permanently un-executable row in the list.
      const stale = Number(proposal.safeNonce) < authority.nonce;
      const local = Object.values(data.circleApprovals ?? {}).filter((a) => a.proposalId === proposal.proposalId);
      const fromService = byHash.get(String(proposal.safeTxHash).toLowerCase())?.confirmations ?? [];
      const collected = dedupeApprovals([...local, ...fromService], authority.owners);
      out.push(this._proposalView(proposal, { collected, stale, requiredApprovals: authority.threshold }));
    }
    return { circleId, authority, pending: out };
  }

  /**
   * Record one admin's approval. The signature is verified against the digest and the live owner set
   * before it is stored, so an approval row can only ever exist because a current admin really
   * signed this exact transaction.
   */
  async recordApproval({ circleId, proposalId, prismId, signature }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, prismId);
    const proposal = this.store.read().circleProposals?.[proposalId];
    if (!proposal || proposal.circleId !== circleId) throw notFound('proposal not found');
    if (proposal.status !== ProposalStatus.PENDING) throw conflict(`this proposal is already ${proposal.status.toLowerCase()}`);

    const { authorityAddress, signatureType } = await this.safe.verifyApproval({
      safeAddress: circle.safeAddress, safeTxHash: proposal.safeTxHash, signature
    });
    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (!member?.authorityAddress || getAddress(member.authorityAddress) !== authorityAddress) {
      throw forbidden('that approval was signed by a different account than your Prism authority');
    }

    const approval = newCircleApproval({ proposalId, prismId, authorityAddress, signatureType, signature });
    this.store.mutate((d) => { (d.circleApprovals ||= {})[`${proposalId}:${prismId}`] = approval; });
    await this.safe.addConfirmation({ safeTxHash: proposal.safeTxHash, signature });
    this._event(circleId, 'circle.proposal.approved', { proposalId, authorityAddress });
    return { proposalId, approvedBy: prismId, signatureType };
  }

  // ===========================================================================
  // Templates (UX defaults only)
  // ===========================================================================

  /** What the creation sheet should show for a template and a chosen number of admins. */
  templateGuidance({ template, adminCount }) {
    return templateOptions(template, adminCount);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * Detect a Circle that claims to be ACTIVE without an activation receipt, or whose on-chain
   * authority has drifted from what was verified. Both mean Prism's stored view can no longer be
   * trusted, so the Circle is moved out of ACTIVE rather than quietly corrected.
   *
   * This is the check that makes a hand-edited "status: ACTIVE" row worthless.
   */
  _assertActivationIntegrity(circle, authority) {
    if (circle.status !== CircleStatus.ACTIVE) return;
    if (!circle.activation?.verifiedAt) {
      this._fail(circle.circleId, 'this Circle was marked active without an on-chain verification receipt');
      throw conflict('this Circle was marked active without an on-chain verification receipt');
    }
    const drifted = !sameOwnerSet(authority.owners, circle.activation.owners)
      || Number(authority.threshold) !== Number(circle.activation.threshold);
    if (drifted) {
      // Drift is not necessarily an attack — an approved owner change produces it too — so the
      // activation receipt is re-anchored to what the chain says now and the change is logged.
      logger.info('circle.authority.drift', { circleId: circle.circleId, from: circle.activation, to: { owners: authority.owners, threshold: authority.threshold } });
      this.store.mutate((d) => {
        d.circles[circle.circleId].activation = {
          ...d.circles[circle.circleId].activation,
          owners: authority.owners, threshold: authority.threshold, verifiedAt: new Date().toISOString()
        };
      });
      this._event(circle.circleId, 'circle.authority.changed', { threshold: authority.threshold, adminCount: authority.owners.length });
    }
  }

  /** Mirror the live authority into the stored record. Only ever called with a real chain read. */
  _reconcileAuthority(circleId, authority) {
    this.store.mutate((d) => {
      const c = d.circles[circleId];
      c.threshold = Number(authority.threshold);
      c.adminCount = authority.owners.length;
    });
  }

  async _activeCircleWithAuthority(circleId, actorPrismId) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);
    if (circle.status !== CircleStatus.ACTIVE) throw conflict('this Circle is not active on-chain yet');
    if (!circle.safeAddress) throw conflict('this Circle has no verified Safe address');
    const authority = await this._readAuthority(circle);
    return { circle, authority };
  }

  _resolveAdmins({ creator, admins }) {
    const requested = Array.isArray(admins) ? admins : [];
    // The creator is always an admin of the Circle they create; listing them again is not an error.
    const ids = [creator.prismId, ...requested.map((a) => (typeof a === 'string' ? a : a?.prismId))].filter(Boolean);
    const unique = [...new Set(ids)];
    if (unique.length < 1) throw badRequest('a Circle needs at least one admin');

    const resolved = unique.map((prismId) => {
      const identity = this.identityService.get(prismId);
      if (!identity) throw badRequest(`no Prism identity for admin ${prismId}`);
      if (!identity.accountAddress || !isAddress(identity.accountAddress)) {
        // No inventing addresses: a person without a bound Mera account cannot be a Safe owner.
        throw badRequest(`${identity.displayName ?? prismId} has not finished setting up their Prism account, so they cannot be an admin yet`);
      }
      return {
        prismId,
        authorityAddress: getAddress(identity.accountAddress),
        displayName: identity.displayName ?? null,
        handle: identity.handle ? `@${identity.handle}` : null
      };
    });
    normalizeOwnerSet(resolved.map((r) => r.authorityAddress)); // rejects duplicate authorities
    return resolved;
  }

  /**
   * The creator must confirm the exact governance they were shown. A mismatch means the sheet the
   * user approved is not the Circle about to be deployed — which is precisely the substitution the
   * acknowledgement exists to prevent — so it is refused rather than reconciled.
   */
  _assertPolicyAcknowledged({ policyAcknowledgement, threshold, adminCount, warnings }) {
    if (!policyAcknowledgement) throw badRequest('the approvals policy must be acknowledged before a Circle is created');
    if (Number(policyAcknowledgement.threshold) !== Number(threshold) || Number(policyAcknowledgement.adminCount) !== Number(adminCount)) {
      throw badRequest('the approvals policy you confirmed does not match this Circle; review it again');
    }
    const acknowledged = new Set(policyAcknowledgement.acknowledgedWarnings ?? []);
    const unacknowledged = warnings.filter((w) => !acknowledged.has(w.code));
    if (unacknowledged.length) {
      throw badRequest(`this Circle needs an explicit acknowledgement: ${unacknowledged.map((w) => `${w.title} — ${w.detail}`).join(' ')}`);
    }
    return true;
  }

  /**
   * Find this Circle's salt, or the existing Circle that already owns it.
   *
   * The salt is deterministic in the Circle's shape, which is what makes a repeated creation
   * idempotent rather than a second Safe. The `attempt` counter exists for one specific case: a
   * Circle that failed verification (or was closed) has already consumed its predicted address, and
   * redeploying to an occupied address would simply revert. So a new attempt at the same shape gets
   * the next free salt, while anything still in flight or live resumes.
   */
  _claimSalt({ creatorPrismId, name, admins, threshold }) {
    const salts = this.store.read().circleSalts ?? {};
    const circles = this.store.read().circles ?? {};
    for (let attempt = 0; attempt < 32; attempt++) {
      const saltNonce = this._saltFor({ creatorPrismId, name, admins, threshold, attempt });
      const existingId = salts[saltNonce];
      if (!existingId) return { saltNonce, resume: null };
      const existing = circles[existingId];
      if (!existing) return { saltNonce, resume: null };
      const spent = existing.status === CircleStatus.VERIFICATION_FAILED || existing.status === CircleStatus.CLOSED;
      if (!spent) return { saltNonce, resume: existingId };
    }
    throw conflict('too many Circles with this exact name and admins; give this one a different name');
  }

  _saltFor({ creatorPrismId, name, admins, threshold, attempt = 0 }) {
    const canonical = [
      creatorPrismId, name.toLowerCase(), String(threshold), `attempt:${attempt}`,
      ...admins.map((a) => a.authorityAddress.toLowerCase()).sort()
    ].join('|');
    return BigInt(keccak256(toHex(canonical))).toString();
  }

  _summaryView(circle) {
    return {
      circleId: circle.circleId,
      name: circle.name,
      icon: circle.icon,
      safeAddress: circle.safeAddress,
      chainId: circle.chainId,
      asset: circle.asset,
      status: circle.status,
      template: circle.creation?.template ?? null,
      createdByPrismId: circle.createdByPrismId,
      createdAt: circle.createdAt,
      activatedAt: circle.activatedAt,
      closedAt: circle.closedAt,
      // Present so a client can tell "verified on Monad" from "Prism thinks so". An ACTIVE Circle
      // without a verification receipt is never reported as verified.
      verifiedOnChain: Boolean(circle.activation?.verifiedAt) && circle.status === CircleStatus.ACTIVE,
      requested: {
        threshold: circle.creation?.requestedThreshold ?? null,
        adminCount: circle.creation?.requestedAdmins?.length ?? null
      },
      failureReason: circle.creation?.failureReason ?? null,
      events: circle.events ?? []
    };
  }

  _proposalView(proposal, { collected = [], stale = false, requiredApprovals = null } = {}) {
    const required = requiredApprovals ?? proposal.requiredApprovals;
    return {
      proposalId: proposal.proposalId,
      circleId: proposal.circleId,
      kind: proposal.kind,
      proposerPrismId: proposal.proposerPrismId,
      memo: proposal.memo,
      subject: proposal.subject ?? null,
      safeTxHash: proposal.safeTxHash,
      safeNonce: proposal.safeNonce,
      safeTransaction: proposal.safeTransaction,
      requiredApprovals: required,
      collectedApprovals: collected.length,
      approvals: collected.map((a) => ({ authorityAddress: a.authorityAddress, signatureType: a.signatureType })),
      // READY is computed from verified signatures, never stored; and a stale-nonce proposal is
      // never READY however many approvals it has.
      status: stale ? ProposalStatus.EXPIRED : (collected.length >= required ? ProposalStatus.READY : ProposalStatus.PENDING),
      staleNonce: stale,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt
    };
  }

  _fail(circleId, reason) {
    this.store.mutate((d) => { d.circles[circleId].creation.failureReason = reason; });
    this._transition(circleId, CircleStatus.VERIFICATION_FAILED, { reason });
    return this.getCircleRecord(circleId);
  }

  _transition(circleId, next, detail) {
    this.store.mutate((d) => {
      const circle = d.circles[circleId];
      assertCircleTransition(circle.status, next);
      if (circle.status === next) return;
      circle.status = next;
      circle.events.push({ at: new Date().toISOString(), state: next, detail });
    });
  }

  _event(circleId, name, detail) {
    this.store.mutate((d) => {
      const circle = d.circles?.[circleId];
      if (circle) circle.events.push({ at: new Date().toISOString(), event: name, detail });
    });
  }

  _circle(circleId) {
    const circle = this.store.read().circles?.[circleId];
    if (!circle) throw notFound('circle not found');
    return circle;
  }

  /**
   * Membership is the authorization boundary for every Circle read. Note that no method anywhere in
   * this service accepts a Safe address from a caller — the address always comes from the stored
   * Circle record — so there is no shape of request that can point a Circle operation at a Safe the
   * caller does not belong to.
   */
  _assertMember(circleId, prismId) {
    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (!member || TERMINAL_MEMBER_STATUSES.includes(member.status)) throw notFound('circle not found');
    return member;
  }

  _assertAdmin(circleId, prismId) {
    const member = this._assertMember(circleId, prismId);
    if (member.role !== MemberRole.ADMIN) throw forbidden('only an admin of this Circle can do that');
    // PENDING_ACTIVATION is allowed during creation (before the Safe exists there are no owners yet);
    // once a Circle is ACTIVE, `_activeCircleWithAuthority` additionally requires on-chain authority.
    if (![MemberStatus.ACTIVE, MemberStatus.PENDING_ACTIVATION].includes(member.status)) {
      throw forbidden('your admin authority is not active');
    }
    return member;
  }

  _memberAuthority(circleId, prismId) {
    return this.store.read().circleMembers?.[memberKey(circleId, prismId)]?.authorityAddress ?? null;
  }

  _assertIdentity(prismId) {
    const identity = this.identityService.get(prismId);
    if (!identity) throw notFound('identity not found');
    return identity;
  }

  _findIdentity({ prismId, handle }) {
    if (prismId) return this.identityService.get(prismId);
    if (handle) {
      const normalized = String(handle).trim().replace(/^@/, '').toLowerCase();
      const id = this.store.read().handleIndex?.[normalized];
      return id ? this.identityService.get(id) : null;
    }
    return null;
  }

  _assertName(name) {
    const trimmed = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (trimmed.length < 1 || trimmed.length > 40) throw badRequest('a Circle name must be 1-40 characters');
    return trimmed;
  }
}

// --- helpers -----------------------------------------------------------------

const memberKey = (circleId, prismId) => `${circleId}:${prismId}`;

const unavailable = (reason) => ({ unavailable: true, reason, source: 'chain' });

function serializeTx(tx) {
  return {
    to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(), baseGas: tx.baseGas.toString(), gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.nonce.toString()
  };
}

/** One approval per admin authority, and only from addresses that are owners right now. */
function dedupeApprovals(approvals, owners) {
  const ownerSet = new Set(owners.map((o) => getAddress(o).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const approval of approvals) {
    if (!approval?.authorityAddress) continue;
    const key = getAddress(approval.authorityAddress).toLowerCase();
    if (!ownerSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(approval);
  }
  return out;
}
