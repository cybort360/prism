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
  TERMINAL_MEMBER_STATUSES, CHAIN_BACKED_ROLES, ContributionStatus,
  CirclePaymentState, CIRCLE_PAYMENT_PRE_BROADCAST, APPROVAL_BOUND_FIELDS,
  newCircle, newCircleMember, newCircleProposal, newCircleApproval, newCircleContribution,
  assertCircleTransition, assertCirclePaymentTransition, assertContributionTransition,
  assertThresholdWithinOwners, thresholdWarnings, assertRole,
  badRequest, forbidden, notFound, conflict
} from '../circles/model.js';
import { assertTemplateChoice, templateOptions, CircleTemplate } from '../circles/templates.js';
import { sameOwnerSet, normalizeOwnerSet, safeTransaction, safeTxHash, decodeUsdcTransfer, ZERO_ADDRESS } from '../circles/safeEncoding.js';
import { contributionHash } from '../chain/eth.js';
import { assertFreshResolution } from '../lib/continuity.js';
import { assertAdapterContract, EXPECTED_SAFE_VERSION } from '../circles/safeCircleAdapter.js';
import { logger } from '../lib/logger.js';

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // an invitation that goes unanswered for a fortnight is stale
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// How long one broadcast attempt holds the execution slot before a retry may take it over.
const EXECUTION_RESERVATION_MS = 60_000;

/** Roles allowed to put money into a Circle. A VIEWER may look at one and nothing else. */
const CONTRIBUTING_ROLES = Object.freeze([MemberRole.ADMIN, MemberRole.SPENDER, MemberRole.CONTRIBUTOR]);
/** Broadcast and not yet settled: calling execute again must reconcile, never re-broadcast. */
const CIRCLE_PAYMENT_IN_FLIGHT = Object.freeze([
  CirclePaymentState.SUBMITTED, CirclePaymentState.CONFIRMING,
  CirclePaymentState.CONFIRMED, CirclePaymentState.RECONCILED, CirclePaymentState.COMPLETED
]);
/** Payment states that are only truthful when `proposal.evidence` backs them. */
const EVIDENCE_BACKED_STATES = Object.freeze([CirclePaymentState.RECONCILED, CirclePaymentState.COMPLETED]);
/** Roles allowed to *propose* a spend. Proposing is not spending: only signatures move money. */
const PROPOSING_ROLES = CONTRIBUTING_ROLES;

export class CircleService {
  /**
   * @param {object} deps
   * @param {object} [deps.paymentService] Prism's existing payment service. Contributions are
   *        ordinary Prism payments whose recipient is the Circle's Safe, so they run through the
   *        audited router/ERC-3009/relayer path rather than a second settlement mechanism. Optional
   *        only so that Circle suites which never move money need not wire it.
   */
  constructor({ store, config, identityService, safeAdapter, paymentService = null }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.payments = paymentService;
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
  async _createProposal({ circle, actorPrismId, kind, authority, intent, memo, subject, payment = null, trace = [] }) {
    const tx = await this.safe.buildTransaction({ safeAddress: circle.safeAddress, intent, nonce: authority.nonce });
    const digest = await this.safe.getTransactionHash({ safeAddress: circle.safeAddress, tx });

    const proposalId = `prp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const proposal = newCircleProposal({
      proposalId, circleId: circle.circleId, kind, proposerPrismId: actorPrismId,
      recipientPrismId: payment?.recipientPrismId ?? subject.prismId ?? null,
      recipientAccount: payment?.recipientAccount ?? subject.authorityAddress ?? null,
      amount: payment?.amount ?? null, asset: payment ? CIRCLE_ASSET : null, memo,
      safeTxHash: digest, safeNonce: tx.nonce.toString(),
      safeTransaction: serializeTx(tx),
      // The Safe, the chain and the token this digest was built against, stored alongside it so a
      // later edit to any of them is detectable rather than invisible (see `_paymentBinding`).
      safeAddress: circle.safeAddress,
      chainId: circle.chainId,
      token: payment ? getAddress(this.config.chain.usdc) : null,
      requiredApprovals: authority.threshold,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString()
    });
    proposal.subject = subject;
    if (payment) {
      proposal.payment = payment;
      proposal.lifecycle = CirclePaymentState.PROPOSED;
      proposal.trace = [...trace, { state: CirclePaymentState.PROPOSED, at: new Date().toISOString(), detail: { safeTxHash: digest, safeNonce: tx.nonce.toString() } }];
      proposal.executionTxHash = null;
      proposal.balanceBefore = null;
      proposal.balanceAfter = null;
    }

    this.store.mutate((d) => { (d.circleProposals ||= {})[proposalId] = proposal; });
    await this.safe.proposeTransaction({
      safeAddress: circle.safeAddress, tx, safeTxHash: digest,
      proposerAddress: this._memberAuthority(circle.circleId, actorPrismId)
    });
    this._event(circle.circleId, 'circle.proposal.created', { proposalId, kind, safeTxHash: digest });

    if (payment) return this._paymentView(circle, this._proposal(circle.circleId, proposalId), { authority, collected: [] });
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
      // A payment carries its own lifecycle and its own binding check, so it is rendered by the
      // payment view rather than flattened into the governance one — this is the admin's approval
      // inbox, and it must show what is actually being approved.
      if (proposal.kind === ProposalKind.PAYMENT) {
        out.push(await this._paymentView(circle, proposal, { authority }));
        continue;
      }
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

    // One approval per authority. Safe counts an owner once however many signatures it is handed, so
    // a second approval could never raise the count — but silently accepting it would let the API
    // imply progress that does not exist.
    const duplicate = Object.values(this.store.read().circleApprovals ?? {}).find(
      (a) => a.proposalId === proposalId && a.authorityAddress && getAddress(a.authorityAddress) === authorityAddress
    );
    if (duplicate) throw conflict('you have already approved this');

    const approval = newCircleApproval({ proposalId, prismId, authorityAddress, signatureType, signature });
    this.store.mutate((d) => { (d.circleApprovals ||= {})[`${proposalId}:${prismId}`] = approval; });
    await this.safe.addConfirmation({ safeTxHash: proposal.safeTxHash, signature });
    this._event(circleId, 'circle.proposal.approved', { proposalId, authorityAddress });
    return { proposalId, approvedBy: prismId, signatureType };
  }

  // ===========================================================================
  // Contributions — money moving INTO a Circle
  // ===========================================================================

  /**
   * Prepare a contribution: a personal Prism account pays USDC to the Circle's Safe.
   *
   * There is deliberately no contribution vault and no second settlement mechanism. A contribution
   * is an ordinary Prism payment whose recipient happens to be a Safe, so it goes through the same
   * PaymentEnvelope, the same ERC-3009 receive-authorization to the audited router, the same
   * relayer, and the same reconciliation as paying a person. The Circle's balance then rises for
   * exactly the reason any ERC-20 balance rises — a transfer landed — and Prism reads it back from
   * the token rather than adding to a number it keeps.
   *
   * What makes this a *contribution* rather than a payment that happens to hit a Safe is the opaque
   * hash slot in the envelope: `contributionHash` binds the Circle, its Safe, the contributor and
   * the amount into the signature, so reconciliation can hold the settled payment to the claim the
   * contributor actually signed.
   */
  async prepareContribution({ circleId, prismId, amountAtomic }) {
    const circle = await this._spendableCircle(circleId, prismId, CONTRIBUTING_ROLES, 'add money to');
    if (!this.payments) throw conflict('contributions are not available on this deployment');

    const amount = this._assertAmount(amountAtomic);
    const contributionId = `ctb_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

    // Read before, so "the Circle went up by exactly this" is checkable later rather than asserted.
    // Unreadable is recorded as unknown; it is never defaulted to a number.
    const balanceBefore = await this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null);

    const bound = contributionHash({
      contributionId, circleId, safeAddress: circle.safeAddress,
      contributorPrismId: prismId, amountAtomic: amount
    });

    const prepared = await this.payments.prepareExternalSend({
      senderPrismId: prismId,
      recipientAddress: circle.safeAddress,
      amountAtomic: amount,
      boundHash: bound,
      kind: 'circle-contribution',
      intent: { circleId, contributionId, entryMethod: 'circle', memo: `Added to ${circle.name}` }
    });

    const contribution = newCircleContribution({
      contributionId, circleId, contributorPrismId: prismId, amount, asset: CIRCLE_ASSET,
      operationId: prepared.paymentId, safeAddress: circle.safeAddress, balanceBefore
    });
    contribution.boundHash = bound;
    this.store.mutate((d) => { (d.circleContributions ||= {})[contributionId] = contribution; });
    this._event(circleId, 'circle.contribution.prepared', { contributionId, amount, contributorPrismId: prismId });

    return {
      ...prepared,
      contribution: this._contributionView(contribution, circle),
      circle: { circleId: circle.circleId, name: circle.name, icon: circle.icon, safeAddress: circle.safeAddress }
    };
  }

  /**
   * Relay a signed contribution. `SUBMITTED` means a transaction was broadcast and nothing more —
   * the money is not in the Circle until a receipt says so, which is `reconcileContribution`'s job.
   */
  async submitContribution({ circleId, contributionId, prismId, prismSignature, tokenSignature }) {
    const { contribution } = this._ownContribution({ circleId, contributionId, prismId });
    if (!this.payments) throw conflict('contributions are not available on this deployment');
    if (contribution.status === ContributionStatus.COMPLETED) return this.reconcileContribution({ circleId, contributionId, prismId });

    const result = await this.payments.submitPayment({
      paymentId: contribution.operationId, prismSignature, tokenSignature, actorPrismId: prismId
    });
    if (result.state === 'submitted' || result.state === 'confirming') {
      this._setContributionStatus(contributionId, ContributionStatus.SUBMITTED, { transactionHash: result.txHash ?? null });
    }
    return this.reconcileContribution({ circleId, contributionId, prismId, payment: result });
  }

  /**
   * Reconcile a contribution against chain truth.
   *
   * COMPLETED requires three things, not one: the underlying Prism payment reached `completed` (which
   * only an on-chain receipt can do), the settled envelope really paid *this* Circle's Safe, and the
   * signed contribution hash still describes this contribution. The last check is what makes a later
   * edit to the stored row — a different Circle, a different amount — surface as a contradiction
   * instead of quietly re-labelling somebody's money.
   */
  async reconcileContribution({ circleId, contributionId, prismId, payment = null }) {
    const { contribution, circle } = this._ownContribution({ circleId, contributionId, prismId });
    if (!this.payments) throw conflict('contributions are not available on this deployment');
    // Terminal: a settled contribution is read, never re-transitioned. Without this, polling a
    // completed contribution would keep re-asking the chain for an answer it already has.
    if (contribution.status === ContributionStatus.COMPLETED || contribution.status === ContributionStatus.FAILED) {
      return { contribution: this._contributionView(contribution, circle) };
    }

    const settled = payment && payment.state === 'completed'
      ? payment
      : await this.payments.reconcile(contribution.operationId, prismId).catch(() => null);

    if (!settled) return { contribution: this._contributionView(this._contribution(contributionId), circle) };

    if (settled.state === 'failed') {
      this._setContributionStatus(contributionId, ContributionStatus.FAILED, { failureReason: 'the contribution transaction reverted on Monad' });
      return { contribution: this._contributionView(this._contribution(contributionId), circle), payment: settled };
    }

    if (settled.state !== 'completed') {
      if (contribution.status === ContributionStatus.SUBMITTED) {
        this._setContributionStatus(contributionId, ContributionStatus.CONFIRMING, { transactionHash: settled.txHash ?? contribution.transactionHash });
      }
      return { contribution: this._contributionView(this._contribution(contributionId), circle), payment: settled };
    }

    // --- completed on-chain. Now check it is completed *as this contribution*. -----------------
    const operation = this.store.read().operations?.[contribution.operationId];
    const mismatch = this._contributionMismatch(contribution, operation);
    if (mismatch) {
      this._setContributionStatus(contributionId, ContributionStatus.FAILED, { failureReason: mismatch });
      logger.error('circle.contribution.mismatch', { contributionId, reason: mismatch });
      return { contribution: this._contributionView(this._contribution(contributionId), circle), payment: settled, mismatch };
    }

    const balanceAfter = await this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null);
    this._setContributionStatus(contributionId, ContributionStatus.COMPLETED, {
      transactionHash: settled.transactionHash ?? settled.txHash ?? contribution.transactionHash,
      balanceAfter,
      completedAt: new Date().toISOString()
    });
    this._event(circleId, 'circle.contribution.completed', {
      contributionId, amount: contribution.amount, transactionHash: settled.transactionHash ?? settled.txHash
    });
    return { contribution: this._contributionView(this._contribution(contributionId), circle), payment: settled };
  }

  /** Contributions to this Circle, newest first. Visible to every member. */
  listContributions(circleId, prismId) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    const all = Object.values(this.store.read().circleContributions ?? {})
      .filter((c) => c.circleId === circleId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { circleId, contributions: all.map((c) => this._contributionView(c, circle)) };
  }

  /**
   * The settled payment must agree with the contribution in every field the contributor signed.
   * Returns a human reason, or null when everything lines up.
   */
  _contributionMismatch(contribution, operation) {
    if (!operation?.env) return 'the settled payment for this contribution is missing';
    if (operation.kind !== 'circle-contribution') return 'that operation is not a Circle contribution';
    if (!contribution.safeAddress || getAddress(operation.env.recipient) !== getAddress(contribution.safeAddress)) {
      return 'the settled payment did not pay this Circle';
    }
    if (String(operation.env.amount) !== String(contribution.amount)) {
      return 'the settled amount is not the amount this contribution recorded';
    }
    const expected = contributionHash({
      contributionId: contribution.contributionId, circleId: contribution.circleId,
      safeAddress: contribution.safeAddress, contributorPrismId: contribution.contributorPrismId,
      amountAtomic: contribution.amount
    });
    if (String(operation.env.resolutionHash).toLowerCase() !== expected.toLowerCase()) {
      return 'this contribution no longer matches what the contributor signed';
    }
    return null;
  }

  _setContributionStatus(contributionId, status, extra = {}) {
    this.store.mutate((d) => {
      const c = d.circleContributions[contributionId];
      assertContributionTransition(c.status, status);
      Object.assign(c, extra);
      c.status = status;
    });
  }

  _contribution(contributionId) {
    const contribution = this.store.read().circleContributions?.[contributionId];
    if (!contribution) throw notFound('contribution not found');
    return contribution;
  }

  _ownContribution({ circleId, contributionId, prismId }) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    const contribution = this._contribution(contributionId);
    if (contribution.circleId !== circleId) throw notFound('contribution not found');
    if (contribution.contributorPrismId !== prismId) throw forbidden('that contribution belongs to someone else');
    return { contribution, circle };
  }

  _contributionView(contribution, circle) {
    const before = contribution.balanceBefore;
    const after = contribution.balanceAfter;
    return {
      contributionId: contribution.contributionId,
      circleId: contribution.circleId,
      circleName: circle?.name ?? null,
      contributorPrismId: contribution.contributorPrismId,
      amount: contribution.amount,
      asset: contribution.asset,
      status: contribution.status,
      operationId: contribution.operationId,
      transactionHash: contribution.transactionHash,
      failureReason: contribution.failureReason ?? null,
      createdAt: contribution.createdAt,
      completedAt: contribution.completedAt ?? null,
      // The Circle's balance either side of this contribution, as read from the token contract.
      // `delta` is present only when both reads succeeded — never inferred from the amount.
      balance: {
        before, after,
        delta: before !== null && after !== null ? (BigInt(after) - BigInt(before)).toString() : null,
        source: 'chain'
      }
    };
  }

  // ===========================================================================
  // Circle payments — money moving OUT of a Circle, under the threshold
  // ===========================================================================

  /**
   * Propose a payment from a Circle to a person.
   *
   * The recipient comes from the *same* Protected Alias Resolver as every other Prism payment. That
   * is not code reuse for its own sake: it means paying someone from a Circle inherits Prism
   * Continuity whole — a contact whose alias now resolves to a different PrismIdentity is blocked
   * and reviewed, never silently redirected, exactly as it would be for a personal payment.
   *
   * The Safe transaction this builds is fixed in shape and Prism is the only thing that chooses it:
   *
   *     to        = the officially configured USDC contract
   *     value     = 0
   *     data      = USDC.transfer(resolvedRecipient, amount)
   *     operation = CALL
   *
   * No caller — app, admin, or backend route — supplies a target or calldata. `_intentToCall` is the
   * only function that turns a Circle intent into a Safe call, and `PAYMENT` is hardcoded there to
   * the configured token. There is no request shape that reaches `execTransaction` with an arbitrary
   * destination, which is why "the relayer cannot redirect funds" is a structural claim rather than
   * a validation rule that could be forgotten.
   */
  async proposePayment({ circleId, actorPrismId, resolution, amountAtomic, memo = '' }) {
    const circle = await this._spendableCircle(circleId, actorPrismId, PROPOSING_ROLES, 'pay from');
    if (!this.payments) throw conflict('Circle payments are not available on this deployment');
    const amount = this._assertAmount(amountAtomic);
    const note = String(memo ?? '').trim().slice(0, 120);

    const proposalId = `prp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const trace = [];
    const mark = (state, detail = {}) => trace.push({ state, at: new Date().toISOString(), detail });
    mark(CirclePaymentState.CREATED, { amount });

    // --- RESOLVING / RESOLVED: the recipient is a Prism identity, not an address the caller typed.
    mark(CirclePaymentState.RESOLVING, {});
    const { identity: recipient, attestation } = this.payments.assertResolution(resolution, actorPrismId);
    if (!recipient?.accountAddress) throw badRequest('that person has not finished setting up their Prism account');
    if (getAddress(recipient.accountAddress) === getAddress(circle.safeAddress)) throw badRequest('a Circle cannot pay itself');
    mark(CirclePaymentState.RESOLVED, { recipientPrismId: recipient.prismId, route: attestation.route });

    const authority = await this._readAuthority(circle);
    const balance = await this.safe.getUsdcBalance(circle.safeAddress).catch(() => null);

    const proposal = await this._createProposal({
      circle, actorPrismId, kind: ProposalKind.PAYMENT, authority,
      intent: { kind: 'PAYMENT', recipient: getAddress(recipient.accountAddress), amountAtomic: amount },
      memo: note || `Payment to ${recipient.displayName ?? (recipient.handle ? `@${recipient.handle}` : 'a contact')}`,
      subject: { prismId: recipient.prismId, authorityAddress: getAddress(recipient.accountAddress) },
      payment: {
        amount,
        recipientPrismId: recipient.prismId,
        recipientAccount: getAddress(recipient.accountAddress),
        recipientDisplayName: recipient.displayName ?? null,
        recipientHandle: recipient.handle ? `@${recipient.handle}` : null,
        // Kept so continuity can be re-checked before every signature and before execution: the
        // alias that found this person may change, and a change to a DIFFERENT identity must block.
        aliasVersion: recipient.aliasVersion,
        resolutionRequestId: attestation.requestId,
        resolutionRoute: attestation.route ?? null
      },
      trace
    });

    return {
      ...proposal,
      // Stated, never enforced by refusing to propose: a Circle can be topped up while approvals are
      // collected, and simulation is the gate that actually decides whether it can execute.
      sufficientBalance: balance === null ? null : balance >= BigInt(amount)
    };
  }

  /**
   * Everything a Circle payment's approvals are *about*, re-derived and compared.
   *
   * A Safe signature covers a digest, and the digest covers the Circle's address, the chain id, the
   * nonce, the target, the value, the operation, the gas-refund fields and `keccak256(calldata)`.
   * So changing the recipient, the amount, the token, the nonce, the Safe or the chain already
   * invalidates every signature *cryptographically* — Safe would refuse to execute.
   *
   * This function makes that failure visible *before* anyone is asked to sign again, and before a
   * relayer burns gas discovering it. It rebuilds the digest from the stored fields and compares it
   * with the digest the approvals were collected against. A backend row edited after approval
   * therefore reads as a contradiction rather than as a payment waiting to go out.
   */
  _paymentBinding(circle, proposal) {
    const reasons = [];
    const tx = proposal.safeTransaction;
    const usdc = getAddress(this.config.chain.usdc);
    const same = (a, b) => { try { return getAddress(a) === getAddress(b); } catch { return false; } };

    if (!tx) return { ok: false, reasons: ['this payment has no recorded Safe transaction'] };
    if (!same(proposal.safeAddress, circle.safeAddress)) reasons.push('the Circle Safe is not the Safe this payment was approved for');
    if (String(proposal.chainId) !== String(circle.chainId)) reasons.push('the chain is not the chain this payment was approved for');
    if (!same(proposal.token, usdc)) reasons.push('the recorded token is not this deployment\'s USDC');
    if (!same(tx.to, usdc)) reasons.push('the transaction target is not this deployment\'s USDC contract');
    if (Number(tx.operation) !== 0) reasons.push('the transaction is a delegatecall, which a Circle never signs');
    if (BigInt(tx.value ?? 0) !== 0n) reasons.push('the transaction moves native MON, which a USDC payment never does');
    if (BigInt(tx.gasPrice ?? 0) !== 0n || BigInt(tx.baseGas ?? 0) !== 0n || BigInt(tx.safeTxGas ?? 0) !== 0n
      || !same(tx.gasToken, ZERO_ADDRESS) || !same(tx.refundReceiver, ZERO_ADDRESS)) {
      reasons.push('the gas-refund fields are not neutral, so a second unreviewed payment could hide inside this one');
    }
    if (String(tx.nonce) !== String(proposal.safeNonce)) reasons.push('the Safe nonce is not the nonce this payment was approved for');

    let decoded = null;
    try { decoded = decodeUsdcTransfer(tx.data); }
    catch { reasons.push('the calldata is not a plain USDC transfer'); }
    if (decoded) {
      if (!same(decoded.recipient, proposal.recipientAccount)) reasons.push('the calldata pays a different recipient than this payment records');
      if (decoded.amountAtomic !== BigInt(proposal.amount)) reasons.push('the calldata moves a different amount than this payment records');
    }

    // The digest of exactly these fields must be the digest the approvals were collected against.
    if (!reasons.length) {
      const recomputed = safeTxHash({
        chainId: circle.chainId,
        safeAddress: circle.safeAddress,
        tx: safeTransaction({
          to: tx.to, value: BigInt(tx.value), data: tx.data, operation: Number(tx.operation),
          safeTxGas: BigInt(tx.safeTxGas), baseGas: BigInt(tx.baseGas), gasPrice: BigInt(tx.gasPrice),
          gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: BigInt(tx.nonce)
        })
      });
      if (recomputed.toLowerCase() !== String(proposal.safeTxHash).toLowerCase()) {
        reasons.push('the recorded approval digest is not the digest of these fields');
      }
    }
    return { ok: reasons.length === 0, reasons, boundFields: APPROVAL_BOUND_FIELDS };
  }

  /**
   * Re-check the recipient's identity against the live resolver state.
   *
   * The person was resolved when the payment was proposed, and approvals may be collected over
   * hours. Prism Continuity says a reachability route may change without changing who is paid — but
   * if it now leads to a *different* PrismIdentity, or the account rotated without an authenticated
   * version advance, the payment must be blocked and reviewed rather than sent.
   */
  _paymentContinuity(proposal) {
    const recipient = this.identityService.get(proposal.recipientPrismId);
    const attestation = {
      prismIdentity: proposal.recipientPrismId,
      recipientAccount: proposal.recipientAccount,
      aliasVersion: proposal.payment?.aliasVersion,
      // Freshness of the original attestation is not the question here — the question is whether the
      // identity Prism is about to pay is still the identity that was reviewed. `expiresAt` is set
      // forward so the classifier answers that question and not a staleness question it already
      // answered at propose time.
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    const verdict = assertFreshResolution(attestation, recipient);
    if (verdict.ok) return { ok: true };
    return {
      ok: false,
      state: verdict.state,
      reason: verdict.state === 'IDENTITY_DISCONTINUITY'
        ? 'this contact now resolves to a different person; the payment must be reviewed again'
        : 'the recipient identity has changed since this payment was proposed; resolve them again'
    };
  }

  /**
   * Approve a Circle payment. Everything the signature is about is re-checked first.
   *
   * `recordApproval` already verifies the signature itself — that it recovers to a CURRENT Safe
   * owner over this exact digest. What this adds for a payment is the two checks a signature cannot
   * make on its own: that the fields behind the digest still describe the payment on file, and that
   * the human being paid is still the human who was reviewed.
   */
  async approvePayment({ circleId, proposalId, prismId, signature }) {
    const circle = this._circle(circleId);
    const proposal = this._proposal(circleId, proposalId);
    if (proposal.kind !== ProposalKind.PAYMENT) throw badRequest('that proposal is not a payment');

    const binding = this._paymentBinding(circle, proposal);
    if (!binding.ok) {
      this._invalidatePayment(proposalId, binding.reasons.join('; '));
      throw conflict(`this payment changed after it was proposed and can no longer be approved: ${binding.reasons.join('; ')}`);
    }
    const continuity = this._paymentContinuity(proposal);
    if (!continuity.ok) {
      this._invalidatePayment(proposalId, continuity.reason);
      throw conflict(continuity.reason);
    }

    const recorded = await this.recordApproval({ circleId, proposalId, prismId, signature });
    // The stored lifecycle follows the flow; whether the threshold is MET is still derived on every
    // read from signatures against the live owner set, never from this write.
    this._setPaymentState(proposalId, CirclePaymentState.APPROVAL_PENDING, { detail: { approvedBy: prismId } });
    const view = await this.getPayment({ circleId, proposalId, prismId });
    return { ...recorded, payment: view };
  }

  /**
   * Execute a Circle payment, if — and only if — the chain itself says it may be executed.
   *
   * The order of these checks is the security argument, so it is worth reading as a whole:
   *
   *   1. the binding still holds                    (nothing was edited after approval)
   *   2. the recipient is still the same person     (Prism Continuity)
   *   3. the Safe's owners, threshold and nonce are
   *      read LIVE from Monad                       (never inferred from Prism's rows)
   *   4. every stored approval is re-verified as a
   *      signature from a CURRENT owner over this
   *      exact digest                               (a removed admin's approval stops counting)
   *   5. the count meets the LIVE threshold
   *   6. the proposal's nonce is the Safe's next
   *      nonce                                      (a consumed nonce is a replay, not a payment)
   *   7. `execTransaction` is SIMULATED             (the Safe re-derives the digest and re-checks
   *                                                  every signature itself; success here is the
   *                                                  Safe agreeing, not Prism asserting)
   *
   * Only after all seven is anything broadcast. A failed simulation returns the reason and leaves the
   * payment exactly where it was — it is never broadcast "to see what happens".
   */
  async executePayment({ circleId, proposalId, actorPrismId }) {
    const circle = this._circle(circleId);
    const member = this._assertMember(circleId, actorPrismId);
    const proposal = this._proposal(circleId, proposalId);
    if (proposal.kind !== ProposalKind.PAYMENT) throw badRequest('that proposal is not a payment');
    if (member.role !== MemberRole.ADMIN && proposal.proposerPrismId !== actorPrismId) {
      throw forbidden('only an admin or the person who proposed this payment can send it');
    }
    if (circle.status !== CircleStatus.ACTIVE) throw conflict('this Circle is not active on-chain yet');

    // Already away: this call becomes a reconcile rather than a second broadcast.
    if (CIRCLE_PAYMENT_IN_FLIGHT.includes(proposal.lifecycle)) {
      return this.reconcilePayment({ circleId, proposalId, prismId: actorPrismId });
    }
    // Off the path entirely — invalidated, expired, cancelled or failed. Say why, rather than
    // returning a view that reads like a payment still on its way.
    if (!CIRCLE_PAYMENT_PRE_BROADCAST.includes(proposal.lifecycle)) {
      throw conflict(proposal.failureReason
        ? `this payment will not be sent: ${proposal.failureReason}`
        : `this payment is ${proposal.lifecycle.toLowerCase()} and will not be sent`);
    }

    const binding = this._paymentBinding(circle, proposal);
    if (!binding.ok) {
      this._invalidatePayment(proposalId, binding.reasons.join('; '));
      throw conflict(`this payment changed after it was approved and will not be sent: ${binding.reasons.join('; ')}`);
    }
    const continuity = this._paymentContinuity(proposal);
    if (!continuity.ok) {
      this._invalidatePayment(proposalId, continuity.reason);
      throw conflict(continuity.reason);
    }

    // --- 3. LIVE authority. Never the stored mirror, and an unreadable chain is not an excuse to
    // fall back to what Prism remembers: with no authority reading, there is no authority.
    let authority;
    try { authority = await this._readAuthority(circle); }
    catch (e) { throw conflict(`Monad could not be read, so this payment cannot be sent: ${e.message}`); }

    // --- 4 & 5. Approvals counted from signatures against the CURRENT owner set.
    const collected = await this._collectApprovals(circle, proposal, authority.owners);
    if (collected.length < authority.threshold) {
      this._setPaymentState(proposalId, CirclePaymentState.APPROVAL_PENDING, {
        detail: { collected: collected.length, required: authority.threshold }
      });
      return {
        ...(await this._paymentView(circle, this._proposal(circleId, proposalId), { authority, collected })),
        blocked: `${collected.length} of ${authority.threshold} approvals; this payment cannot be sent yet`
      };
    }

    // --- 6. The Safe's nonce must be this proposal's nonce.
    if (Number(proposal.safeNonce) < authority.nonce) {
      this._setPaymentState(proposalId, CirclePaymentState.EXPIRED, {
        detail: { reason: 'the Safe has already used this nonce' }
      });
      throw conflict('this payment was built against a Safe nonce that has already been used; propose it again');
    }
    if (Number(proposal.safeNonce) > authority.nonce) {
      return {
        ...(await this._paymentView(circle, proposal, { authority, collected })),
        blocked: 'an earlier Circle transaction must execute first'
      };
    }

    this._setPaymentState(proposalId, CirclePaymentState.APPROVED, {
      detail: { collected: collected.length, threshold: authority.threshold, source: 'live owner set' }
    });

    // --- 7. Simulate. The Safe re-derives the digest and re-checks the signatures itself.
    const tx = rehydrateTx(proposal.safeTransaction);
    const simulation = await this.safe.simulateExecution({ safeAddress: circle.safeAddress, tx, approvals: collected });
    this.store.mutate((d) => {
      d.circleProposals[proposalId].lastSimulation = { at: new Date().toISOString(), ok: simulation.ok, reason: simulation.reason ?? null };
    });
    if (!simulation.ok) {
      logger.warn('circle.payment.simulation.failed', { circleId, proposalId, reason: simulation.reason });
      return {
        ...(await this._paymentView(circle, this._proposal(circleId, proposalId), { authority, collected })),
        blocked: `this payment was not sent because it would fail: ${simulation.reason}`,
        simulation: { ok: false, reason: simulation.reason }
      };
    }

    // Claim the right to broadcast, atomically, before anything leaves the process.
    //
    // Two simultaneous "send" taps would otherwise both pass every check above and both broadcast.
    // The Safe would reject the second — its nonce is consumed — so the money is never at risk, but
    // the reservation turns a wasted, confusing revert into a reconcile. `JsonStore.mutate` is
    // synchronous, so the check and the write happen with no await between them.
    if (!this._reserveExecution(proposalId)) {
      return {
        ...(await this._paymentView(circle, this._proposal(circleId, proposalId), { authority, collected })),
        blocked: 'this payment is already being sent'
      };
    }

    // Balance before, for the reconciliation record. Best effort: an unreadable balance must not
    // stop a fully-approved payment, it just means the delta is reported as unknown.
    const balanceBefore = await this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null);

    let txHash;
    try {
      ({ txHash } = await this.safe.executeTransaction({ safeAddress: circle.safeAddress, tx, approvals: collected }));
    } catch (error) {
      // The broadcast never happened (the adapter throws before returning a hash), so the
      // reservation is released and a genuine retry can proceed.
      this._releaseExecution(proposalId);
      throw error;
    }
    this._setPaymentState(proposalId, CirclePaymentState.SUBMITTED, {
      extra: { executionTxHash: txHash, balanceBefore },
      detail: { txHash }
    });
    this._event(circleId, 'circle.payment.submitted', { proposalId, txHash, amount: proposal.amount });
    logger.info('circle.payment.submitted', { circleId, proposalId, txHash });

    return this.reconcilePayment({ circleId, proposalId, prismId: actorPrismId });
  }

  /**
   * Reconcile a broadcast Circle payment against on-chain evidence.
   *
   * COMPLETED is unreachable from here without three separate facts: a successful receipt, the
   * Safe's own `ExecutionSuccess` for this exact digest, and a USDC `Transfer` from this Circle to
   * the reviewed recipient for the exact amount. A receipt alone is not enough — Safe swallows a
   * failing inner call and emits `ExecutionFailure` while the outer transaction still succeeds — and
   * that is precisely the case where a backend that trusted `status: success` would report a payment
   * that never happened.
   */
  async reconcilePayment({ circleId, proposalId, prismId }) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    let proposal = this._proposal(circleId, proposalId);
    if (proposal.kind !== ProposalKind.PAYMENT) throw badRequest('that proposal is not a payment');

    if (proposal.lifecycle === CirclePaymentState.COMPLETED || !proposal.executionTxHash) {
      return this._paymentView(circle, proposal, {});
    }

    const receipt = await this.safe.getTransactionReceipt(proposal.executionTxHash).catch(() => null);
    if (!receipt) {
      this._setPaymentState(proposalId, CirclePaymentState.CONFIRMING, { detail: { txHash: proposal.executionTxHash } });
      return this._paymentView(circle, this._proposal(circleId, proposalId), {});
    }

    const evidence = this.safe.verifyExecutionEvidence({
      receipt,
      safeAddress: circle.safeAddress,
      safeTxHash: proposal.safeTxHash,
      recipient: proposal.recipientAccount,
      amountAtomic: proposal.amount
    });

    if (!evidence.ok) {
      // Broadcast, mined, and NOT the payment that was approved. This is a terminal failure with a
      // reason attached; it is never rounded up, and it is never retried automatically.
      this._setPaymentState(proposalId, CirclePaymentState.FAILED, {
        extra: { failureReason: evidence.reason },
        detail: { reason: evidence.reason, txHash: proposal.executionTxHash }
      });
      logger.error('circle.payment.evidence.failed', { circleId, proposalId, reason: evidence.reason });
      return this._paymentView(circle, this._proposal(circleId, proposalId), {});
    }

    this._setPaymentState(proposalId, CirclePaymentState.CONFIRMED, {
      detail: { blockNumber: evidence.blockNumber, txHash: proposal.executionTxHash }
    });

    const balanceAfter = await this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null);
    this._setPaymentState(proposalId, CirclePaymentState.RECONCILED, {
      extra: {
        executedAt: new Date().toISOString(),
        balanceAfter,
        evidence: {
          transactionHash: proposal.executionTxHash,
          blockNumber: evidence.blockNumber,
          safeExecutionSuccess: true,
          transfer: evidence.transfer
        }
      },
      detail: { transfer: evidence.transfer }
    });
    this._setPaymentState(proposalId, CirclePaymentState.COMPLETED, { detail: {} });
    this.store.mutate((d) => { d.circleProposals[proposalId].status = ProposalStatus.EXECUTED; });
    this._event(circleId, 'circle.payment.completed', {
      proposalId, amount: proposal.amount, recipientPrismId: proposal.recipientPrismId,
      transactionHash: proposal.executionTxHash
    });
    logger.info('circle.payment.completed', { circleId, proposalId, txHash: proposal.executionTxHash });

    return this._paymentView(circle, this._proposal(circleId, proposalId), {});
  }

  /** One Circle payment, with its approvals re-counted from signatures against the live owner set. */
  async getPayment({ circleId, proposalId, prismId }) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    const proposal = this._proposal(circleId, proposalId);
    if (proposal.kind !== ProposalKind.PAYMENT) throw notFound('payment not found');
    return this._paymentView(circle, proposal, {});
  }

  /** Payments on this Circle, newest first. */
  async listPayments(circleId, prismId) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    const authority = await this._readAuthority(circle).catch(() => null);
    const proposals = Object.values(this.store.read().circleProposals ?? {})
      .filter((p) => p.circleId === circleId && p.kind === ProposalKind.PAYMENT)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const payments = [];
    for (const proposal of proposals) payments.push(await this._paymentView(circle, proposal, { authority }));
    return { circleId, payments };
  }

  /**
   * Re-verify every approval on file against the digest and a given owner set, and drop duplicates.
   * Local rows and Safe Transaction Service confirmations are treated identically: both are
   * signature *claims* until `verifyApproval` says otherwise.
   */
  async _collectApprovals(circle, proposal, owners) {
    const data = this.store.read();
    const local = Object.values(data.circleApprovals ?? {}).filter((a) => a.proposalId === proposal.proposalId);
    const external = await this.safe.getPendingTransactions(circle.safeAddress).catch(() => []);
    const fromService = external.find((e) => String(e.safeTxHash).toLowerCase() === String(proposal.safeTxHash).toLowerCase())?.confirmations ?? [];

    const verified = [];
    for (const approval of [...local, ...fromService]) {
      if (!approval?.signature) continue;
      const ok = await this.safe.verifyApproval({
        safeAddress: circle.safeAddress, safeTxHash: proposal.safeTxHash, signature: approval.signature, owners
      }).catch(() => null);
      if (ok) verified.push({ ...approval, authorityAddress: ok.authorityAddress, signatureType: ok.signatureType });
    }
    return dedupeApprovals(verified, owners);
  }

  /**
   * The effective lifecycle of a payment.
   *
   * Everything up to and including APPROVED is *derived*, on every read, from signatures verified
   * against the live owner set — so an admin removed on-chain drops a payment back from APPROVED to
   * APPROVAL_PENDING without anyone telling Prism. From SUBMITTED onwards the stored state governs,
   * because a broadcast is a fact about the world that no later read can undo.
   */
  async _paymentView(circle, proposal, { authority: given = null, collected: givenCollected = null } = {}) {
    const terminalOrAway = !CIRCLE_PAYMENT_PRE_BROADCAST.includes(proposal.lifecycle);
    const binding = this._paymentBinding(circle, proposal);

    let authority = given;
    let collected = givenCollected;
    if (!terminalOrAway && binding.ok) {
      authority ??= await this._readAuthority(circle).catch(() => null);
      if (authority && !collected) collected = await this._collectApprovals(circle, proposal, authority.owners);
    }

    const required = authority?.threshold ?? proposal.requiredApprovals;
    const count = collected?.length ?? null;
    let lifecycle = proposal.lifecycle;
    let integrity = null;
    if (!terminalOrAway) {
      if (!binding.ok) lifecycle = CirclePaymentState.INVALIDATED;
      else if (authority && Number(proposal.safeNonce) < authority.nonce) lifecycle = CirclePaymentState.EXPIRED;
      else if (count !== null) lifecycle = count >= required ? CirclePaymentState.APPROVED : CirclePaymentState.APPROVAL_PENDING;
    } else if (EVIDENCE_BACKED_STATES.includes(lifecycle) && !proposal.evidence?.transfer) {
      // A payment claiming to have completed without the evidence that completes it is a forgery, in
      // exactly the sense that an ACTIVE Circle without an activation receipt is one. `reconcilePayment`
      // is the only writer of `evidence`, and it writes it only from a receipt carrying the Safe's
      // ExecutionSuccess and a matching USDC Transfer. A row hand-edited to COMPLETED therefore reads
      // back as INVALIDATED, with what it claimed still visible as `storedLifecycle`.
      integrity = 'this payment is recorded as complete but carries no on-chain evidence';
      lifecycle = CirclePaymentState.INVALIDATED;
      logger.error('circle.payment.evidence.missing', { proposalId: proposal.proposalId, storedLifecycle: proposal.lifecycle });
    }

    return {
      proposalId: proposal.proposalId,
      circleId: proposal.circleId,
      circleName: circle.name,
      kind: proposal.kind,
      lifecycle,
      storedLifecycle: proposal.lifecycle,
      proposerPrismId: proposal.proposerPrismId,
      recipientPrismId: proposal.recipientPrismId,
      recipientAccount: proposal.recipientAccount,
      recipientDisplayName: proposal.payment?.recipientDisplayName ?? null,
      recipientHandle: proposal.payment?.recipientHandle ?? null,
      amount: proposal.amount,
      asset: proposal.asset,
      memo: proposal.memo,
      // The exact Safe transaction, so the phone can re-derive the digest for itself rather than
      // trusting the one below. See ios/Prism/Core/Circles/CircleApprovalPayload.swift.
      safeAddress: proposal.safeAddress,
      chainId: proposal.chainId,
      token: proposal.token,
      safeTxHash: proposal.safeTxHash,
      safeNonce: proposal.safeNonce,
      safeTransaction: proposal.safeTransaction,
      requiredApprovals: required,
      collectedApprovals: count,
      approvals: (collected ?? []).map((a) => ({ authorityAddress: a.authorityAddress, signatureType: a.signatureType, prismId: a.prismId ?? null })),
      approvalsSource: collected ? 'verified signatures against the live owner set' : 'unavailable',
      binding: binding.ok && !integrity
        ? { ok: true, boundFields: binding.boundFields }
        : { ok: false, reasons: integrity ? [integrity] : binding.reasons, boundFields: binding.boundFields },
      executionTxHash: proposal.executionTxHash ?? null,
      evidence: proposal.evidence ?? null,
      failureReason: proposal.failureReason ?? null,
      lastSimulation: proposal.lastSimulation ?? null,
      balance: {
        before: proposal.balanceBefore ?? null,
        after: proposal.balanceAfter ?? null,
        delta: proposal.balanceBefore != null && proposal.balanceAfter != null
          ? (BigInt(proposal.balanceAfter) - BigInt(proposal.balanceBefore)).toString() : null,
        source: 'chain'
      },
      createdAt: proposal.createdAt,
      executedAt: proposal.executedAt ?? null,
      expiresAt: proposal.expiresAt,
      trace: proposal.trace ?? []
    };
  }

  /**
   * Take the single broadcast slot for this payment, or report that someone else holds it.
   *
   * A reservation older than the window is treated as abandoned (a crashed producer) so a retry can
   * take it over rather than being locked out forever — the same discipline `withIdempotency` uses.
   */
  _reserveExecution(proposalId) {
    let reserved = false;
    this.store.mutate((d) => {
      const proposal = d.circleProposals[proposalId];
      const held = proposal.executionReservedAt
        && Date.now() - Date.parse(proposal.executionReservedAt) < EXECUTION_RESERVATION_MS;
      if (held) return;
      proposal.executionReservedAt = new Date().toISOString();
      reserved = true;
    });
    return reserved;
  }

  _releaseExecution(proposalId) {
    this.store.mutate((d) => { d.circleProposals[proposalId].executionReservedAt = null; });
  }

  _setPaymentState(proposalId, next, { extra = {}, detail = {} } = {}) {
    this.store.mutate((d) => {
      const proposal = d.circleProposals[proposalId];
      assertCirclePaymentTransition(proposal.lifecycle, next);
      Object.assign(proposal, extra);
      if (proposal.lifecycle === next) return;
      proposal.lifecycle = next;
      (proposal.trace ||= []).push({ state: next, at: new Date().toISOString(), detail });
    });
  }

  _invalidatePayment(proposalId, reason) {
    const proposal = this.store.read().circleProposals?.[proposalId];
    if (!proposal || !CIRCLE_PAYMENT_PRE_BROADCAST.includes(proposal.lifecycle)) return;
    this._setPaymentState(proposalId, CirclePaymentState.INVALIDATED, {
      extra: { failureReason: reason }, detail: { reason }
    });
    this._event(proposal.circleId, 'circle.payment.invalidated', { proposalId, reason });
    logger.warn('circle.payment.invalidated', { proposalId, reason });
  }

  _proposal(circleId, proposalId) {
    const proposal = this.store.read().circleProposals?.[proposalId];
    if (!proposal || proposal.circleId !== circleId) throw notFound('proposal not found');
    return proposal;
  }

  /** An ACTIVE Circle the caller may move money in or out of, with the role check applied. */
  async _spendableCircle(circleId, prismId, roles, verb) {
    const circle = this._circle(circleId);
    const member = this._assertMember(circleId, prismId);
    if (!roles.includes(member.role)) throw forbidden(`your role in this Circle does not let you ${verb} it`);
    if (circle.status !== CircleStatus.ACTIVE) throw conflict('this Circle is not active on-chain yet');
    if (!circle.safeAddress) throw conflict('this Circle has no verified Safe address');
    return circle;
  }

  _assertAmount(value) {
    if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) throw badRequest('amount must be positive');
    if (BigInt(value) > this.config.limits.maxPaymentAtomic) throw badRequest('amount exceeds the Prism payment limit');
    return String(BigInt(value));
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

/**
 * Turn a stored Safe transaction back into the exact 10 typed fields the digest was computed over.
 * Round-tripping through `safeTransaction` rather than reading the JSON directly means a stored row
 * with a delegatecall, a bad address, or a missing nonce throws here instead of being handed to the
 * chain.
 */
function rehydrateTx(tx) {
  return safeTransaction({
    to: tx.to, value: BigInt(tx.value), data: tx.data, operation: Number(tx.operation),
    safeTxGas: BigInt(tx.safeTxGas), baseGas: BigInt(tx.baseGas), gasPrice: BigInt(tx.gasPrice),
    gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: BigInt(tx.nonce)
  });
}

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
