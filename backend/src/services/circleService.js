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
import { getAddress, isAddress, keccak256, toHex, recoverAddress } from 'viem';
import {
  CircleStatus, MemberRole, MemberStatus, ProposalKind, ProposalStatus, CIRCLE_ASSET, SPENDING_LIMIT_KINDS,
  TERMINAL_MEMBER_STATUSES, CHAIN_BACKED_ROLES, ContributionStatus,
  CirclePaymentState, CIRCLE_PAYMENT_PRE_BROADCAST, APPROVAL_BOUND_FIELDS, CLOSE_REQUIREMENTS,
  CircleWithdrawalStatus,
  newCircle, newCircleMember, newCircleProposal, newCircleApproval, newCircleContribution, newCircleWithdrawal,
  assertCircleTransition, assertCirclePaymentTransition, assertContributionTransition,
  assertMemberTransition, assertThresholdWithinOwners, thresholdWarnings, assertRole,
  badRequest, forbidden, notFound, conflict
} from '../circles/model.js';
import {
  CircleApprovalPolicy, CircleFlow, circleContext, proposalAsOperation, spendAsOperation,
  spendCircleState, circlePaymentKindOfId, isCirclePaymentId
} from '../circles/circlePayment.js';
import { canonicalPayment, receiptFor } from '../lib/lifecycle.js';
import { assertTemplateChoice, templateOptions, CircleTemplate } from '../circles/templates.js';
import { sameOwnerSet, normalizeOwnerSet, safeTransaction, safeTxHash, decodeUsdcTransfer, safeExecutionOutcome, ZERO_ADDRESS } from '../circles/safeEncoding.js';
import { contributionHash } from '../chain/eth.js';
import { netContributions, withdrawableFor, proRataPayouts } from '../circles/withdrawal.js';
import {
  assertPeriod, assertAllowanceAmount, periodMinutes, PERIOD_LABELS, PERIOD_ADJECTIVES
} from '../circles/allowanceModule.js';
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
/** Statuses in which a Circle's Safe is live and Prism may still act on it. */
const SPENDING_STATUSES = Object.freeze([CircleStatus.ACTIVE, CircleStatus.CLOSING]);
/** How much of a Circle a caller may see: everything, or only the payment that involved them. */
const AUDIENCE_MEMBER = 'member';
const AUDIENCE_COUNTERPARTY = 'counterparty';

export class CircleService {
  /**
   * @param {object} deps
   * @param {object} [deps.paymentService] Prism's existing payment service. Contributions are
   *        ordinary Prism payments whose recipient is the Circle's Safe, so they run through the
   *        audited router/ERC-3009/relayer path rather than a second settlement mechanism. Optional
   *        only so that Circle suites which never move money need not wire it.
   */
  constructor({ store, config, identityService, safeAdapter, paymentService = null, limitGate = null }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.payments = paymentService;
    // Verifies the Allowance Module against the chain and fails closed. Absent = no spending limits,
    // which is a perfectly good state: Circles falls back to threshold-only payments.
    this.limitGate = limitGate;
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

    if (!SPENDING_STATUSES.includes(circle.status) && circle.status !== CircleStatus.CLOSED && circle.status !== CircleStatus.VERIFICATION_FAILED) {
      await this._advanceCreation(circleId).catch((e) => logger.error('circle.advance.failed', { circleId, error: e.message }));
      circle = this._circle(circleId);
    }

    const view = this._summaryView(circle);
    // A CLOSED Circle keeps its record and its history, but Prism stops presenting live authority and
    // balance for it: what it held at close is preserved in `closing.evidence`, and that is the
    // honest thing to show rather than a fresh read of an account nobody is using.
    if (!circle.safeAddress || !SPENDING_STATUSES.includes(circle.status)) {
      const reason = circle.status === CircleStatus.CLOSED ? 'this Circle is closed' : 'circle is not active on-chain yet';
      return { ...view, authority: unavailable(reason), balance: unavailable(reason), members: this.listMembers(circleId, prismId) };
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
    if (circle.status === CircleStatus.CLOSING) throw conflict('this Circle is being closed, so no one new can be invited');

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
      member.authorityAddress = identity.accountAddress ?? null;
      member.displayName = identity.displayName ?? member.displayName;
      member.handle = identity.handle ? `@${identity.handle}` : member.handle;
    });
    // Two transitions, both true, both timestamped: accepting is a Prism fact, and what it earns
    // you is a separate question the chain answers. For a role Prism alone decides they land in the
    // same instant — which is the honest thing to record, rather than one standing in for the other.
    this._setMemberStatus({ circleId, prismId, next: MemberStatus.ACCEPTED, detail: { role: invite.role } });
    this._setMemberStatus({ circleId, prismId, next: status, detail: { role: invite.role } });
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
    this._setMemberStatus({ circleId, prismId, next: MemberStatus.LEFT, detail: { reason: 'declined the invitation' } });
    this._event(circleId, 'circle.invitation.declined', { prismId });
    return { circleId, status: 'DECLINED' };
  }

  /**
   * Invitations addressed to this person, across every Circle.
   *
   * Without this an invitation is unreachable: `acceptInvitation` needs an id that only the invited
   * person's own device can supply, and nothing else in Prism would ever hand it to them. Expired
   * invitations are filtered rather than returned with a flag — an invitation past its TTL is not a
   * thing anyone can act on, and offering it would only produce a failure at the tap.
   */
  listMyInvitations(prismId) {
    const data = this.store.read();
    const now = Date.now();
    return Object.values(data.circleInvitations ?? {})
      .filter((i) => i.invitedPrismId === prismId && i.status === 'PENDING' && Date.parse(i.expiresAt) > now)
      .map((i) => {
        const circle = data.circles?.[i.circleId];
        const invitedBy = this.identityService.get(i.invitedByPrismId);
        return {
          inviteId: i.inviteId,
          circleId: i.circleId,
          circleName: circle?.name ?? null,
          icon: circle?.icon ?? null,
          role: i.role,
          // Who is asking matters more than what the role is called, so it is never omitted.
          invitedBy: invitedBy?.displayName ?? (invitedBy?.handle ? `@${invitedBy.handle}` : null),
          expiresAt: i.expiresAt,
          createdAt: i.createdAt
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Change a member's role — but only between the roles Prism alone decides.
   *
   * ADMIN is not one of them, in either direction: admin authority IS the Safe's owner set, so
   * granting or revoking it is `prepareAddAdmin`/`prepareRemoveAdmin` and a threshold of signatures.
   * Letting this method write `role: 'ADMIN'` would produce a member who looks like an admin in
   * Prism and holds nothing on Monad, which is the exact lie the whole service is built to avoid.
   *
   * SPENDER is Prism-side too, but it has an on-chain shadow: a spender may hold an allowance. So
   * demoting out of SPENDER is refused while that allowance is live — the limit has to be revoked
   * by the Circle first, or the role change would take away the label and leave the money access.
   */
  async setMemberRole({ circleId, actorPrismId, prismId, role }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);
    assertRole(role);
    if (circle.status === CircleStatus.CLOSED) throw conflict('this Circle is closed');
    if (CHAIN_BACKED_ROLES.includes(role)) {
      throw badRequest('admin authority is granted by the Circle approving it on Monad, not by changing a role here');
    }

    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (!member) throw notFound('that person is not in this Circle');
    if (TERMINAL_MEMBER_STATUSES.includes(member.status)) throw conflict('that person has left this Circle');
    if (CHAIN_BACKED_ROLES.includes(member.role)) {
      throw badRequest("this person is an admin. Removing admin authority is a Circle decision that has to be approved on Monad, so it can't be done by changing a role here");
    }
    if (member.role === role) return { circleId, prismId, role, unchanged: true };

    await this._assertNoLiveSpendingAccess(circle, member, 'change what this person can do');

    this.store.mutate((d) => { d.circleMembers[memberKey(circleId, prismId)].role = role; });
    this._event(circleId, 'circle.member.role_changed', { prismId, from: member.role, to: role, by: actorPrismId });
    return { circleId, prismId, role, unchanged: false };
  }

  /**
   * Remove a member from a Circle.
   *
   * Prism-side membership only. An admin cannot be removed here for the same reason they cannot be
   * demoted here — their authority is on Monad — and neither can anyone still holding a live
   * spending allowance. Both refusals name the governance action that does work, because a dead end
   * at this point would push someone toward believing a removal that had not happened.
   */
  async removeMember({ circleId, actorPrismId, prismId }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);

    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (!member) throw notFound('that person is not in this Circle');
    if (TERMINAL_MEMBER_STATUSES.includes(member.status)) return { circleId, prismId, status: member.status, alreadyRemoved: true };
    if (CHAIN_BACKED_ROLES.includes(member.role)) {
      throw badRequest("this person is an admin. Removing an admin is a Circle decision that has to be approved on Monad — use 'Remove as admin', which the Circle's admins approve together");
    }

    await this._assertNoLiveSpendingAccess(circle, member, 'remove this person');

    this._setMemberStatus({ circleId, prismId, next: MemberStatus.REMOVED, detail: { by: actorPrismId, role: member.role } });
    this.store.mutate((d) => {
      // Any invitation they have not answered dies with the membership, so a pending invite cannot
      // quietly re-admit someone an admin has just removed.
      for (const invite of Object.values(d.circleInvitations ?? {})) {
        if (invite.circleId === circleId && invite.invitedPrismId === prismId && invite.status === 'PENDING') {
          invite.status = 'REVOKED';
          invite.respondedAt = new Date().toISOString();
        }
      }
    });
    this._event(circleId, 'circle.member.removed', { prismId, role: member.role, by: actorPrismId });
    return { circleId, prismId, status: MemberStatus.REMOVED, alreadyRemoved: false };
  }

  /**
   * Refuse a Prism-side membership change while the member can still spend on-chain.
   *
   * Fails CLOSED on a read failure, and that is deliberate. The alternative is to record a removal
   * we cannot verify — the app would then show "no spending access" for someone whose allowance is
   * still live on the module, which is precisely the stale-session failure limits are designed
   * against. Being unable to remove someone for a minute is recoverable; telling an admin their
   * money is safe when it is not is not.
   */
  async _assertNoLiveSpendingAccess(circle, member, action) {
    const moduleAddress = this.config.circles.allowanceModule;
    // No module configured on this deployment means no allowance can exist to strand.
    if (!moduleAddress || circle.status !== CircleStatus.ACTIVE || !circle.safeAddress) return;
    if (!member.authorityAddress) return;
    if (typeof this.safe.isModuleEnabled !== 'function' || typeof this.safe.getSpendDelegates !== 'function') return;

    let enabled;
    let delegates;
    try {
      enabled = await this.safe.isModuleEnabled(circle.safeAddress);
      if (!enabled) return;
      delegates = await this.safe.getSpendDelegates(circle.safeAddress);
    } catch (e) {
      logger.error('circle.member.spend_check_failed', { circleId: circle.circleId, error: e.message });
      throw conflict(`Monad could not be read just now, so Prism can't confirm whether this person can still spend from the Circle. Try again in a moment rather than ${action} without knowing`);
    }

    const holds = delegates.some((d) => getAddress(d).toLowerCase() === getAddress(member.authorityAddress).toLowerCase());
    if (holds) {
      throw conflict(`${member.displayName ?? 'this person'} can still spend from this Circle. The Circle has to approve removing their spending access on Monad first — otherwise they would keep it`);
    }
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
    const changes = [];
    for (const member of Object.values(this.store.read().circleMembers ?? {})) {
      if (member.circleId !== circleId || member.role !== MemberRole.ADMIN) continue;
      if (TERMINAL_MEMBER_STATUSES.includes(member.status)) continue;
      const isOwner = member.authorityAddress && normalized.includes(member.authorityAddress.toLowerCase());
      if (isOwner && member.status === MemberStatus.PENDING_REMOVAL) {
        // A removal was proposed and has not executed. They still hold authority, and saying so is
        // the point of the state — it is not drift to be corrected back to ACTIVE.
        continue;
      }
      if (isOwner && member.status !== MemberStatus.ACTIVE) {
        changes.push([member.prismId, MemberStatus.ACTIVE, { source: 'safe owner set' }]);
      } else if (!isOwner && (member.status === MemberStatus.ACTIVE || member.status === MemberStatus.PENDING_REMOVAL)) {
        // They were an owner and are not any more: the chain removed their authority, so Prism
        // must stop showing them as an admin.
        changes.push([member.prismId, MemberStatus.REMOVED, { source: 'safe owner set' }]);
      }
    }
    for (const [prismId, next, detail] of changes) this._setMemberStatus({ circleId, prismId, next, detail });
  }

  /**
   * Move a member through the guarded authority lifecycle, recording the step.
   *
   * Every status change goes through here, so the member's own history is an ordered log with real
   * timestamps — which is what the Circle's activity feed reads to say "Tobi joined" without Prism
   * having to keep a second, hand-written record of the same fact.
   */
  _setMemberStatus({ circleId, prismId, next, detail = {} }) {
    this.store.mutate((d) => {
      const member = d.circleMembers?.[memberKey(circleId, prismId)];
      if (!member) throw notFound('that person is not in this Circle');
      assertMemberTransition(member.status, next);
      if (member.status === next) return;
      const at = new Date().toISOString();
      member.status = next;
      if (next === MemberStatus.ACTIVE) member.joinedAt ??= at;
      if (next === MemberStatus.REMOVED || next === MemberStatus.LEFT) member.removedAt = at;
      (member.events ||= []).push({ at, status: next, detail });
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
      subject: { prismId: target.prismId, authorityAddress: owner, threshold: newThreshold, ownerCountAfter },
      governance: { kind: 'OWNER_ADD', owner, prismId: target.prismId, threshold: newThreshold, ownerCountAfter, step: 'OWNER_ADD', remainingSteps: [] }
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

    const proposal = await this._createProposal({
      circle, actorPrismId, kind: ProposalKind.OWNER_REMOVE, authority,
      intent: { kind: 'OWNER_REMOVE', owner, threshold: newThreshold },
      memo: `Remove ${member.displayName ?? member.handle ?? 'an admin'} as an admin`,
      subject: { prismId, authorityAddress: owner, threshold: newThreshold, ownerCountAfter },
      governance: { kind: 'OWNER_REMOVE', owner, prismId, threshold: newThreshold, ownerCountAfter, step: 'OWNER_REMOVE', remainingSteps: [] }
    });
    // A removal is on the table. Their authority is untouched until the Safe executes — this state
    // says a decision is pending, and `_reconcileMembersFromOwners` will not quietly undo it. Only
    // an ACTIVE admin can enter it; anyone else is already somewhere the chain put them.
    if (this.store.read().circleMembers?.[memberKey(circleId, prismId)]?.status === MemberStatus.ACTIVE) {
      this._setMemberStatus({ circleId, prismId, next: MemberStatus.PENDING_REMOVAL, detail: { proposalId: proposal.proposalId } });
    }
    return proposal;
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
      subject: { threshold, ownerCountAfter: authority.owners.length },
      governance: { kind: 'THRESHOLD_CHANGE', threshold, ownerCountAfter: authority.owners.length, step: 'THRESHOLD_CHANGE', remainingSteps: [] }
    });
  }

  /**
   * Turn an intent into a signable proposal: build the Safe transaction against the live nonce,
   * compute its digest (cross-checked with the Safe contract), and record what admins are being
   * asked to approve. `requiredApprovals` is the *current on-chain* threshold, because that is what
   * Safe will enforce when this executes.
   */
  async _createProposal({ circle, actorPrismId, kind, authority, intent, memo, subject, payment = null, governance = null, trace = [] }) {
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
    if (governance) {
      // A governance proposal runs the same lifecycle as a payment — the states mean the same
      // things — but its completion evidence is a chain READBACK of what it changed rather than a
      // USDC Transfer. See `executeGovernance`.
      proposal.governance = governance;
      proposal.lifecycle = CirclePaymentState.PROPOSED;
      proposal.trace = [{ state: CirclePaymentState.PROPOSED, at: new Date().toISOString(), detail: { kind, safeTxHash: digest } }];
      proposal.executionTxHash = null;
    }
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
    if (governance) return this._governanceView(this._proposal(circle.circleId, proposalId), { authority, collected: [] });
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
    if (!SPENDING_STATUSES.includes(circle.status)) return { circleId, pending: [], note: 'this Circle is not active on-chain yet' };

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
    // A proposal that carries a lifecycle (a payment, or a governance change) follows the flow as
    // approvals land. Whether the threshold is MET is still derived on every read from signatures
    // against the live owner set — this write only records that collection has begun.
    if (proposal.lifecycle === CirclePaymentState.PROPOSED) {
      this._setPaymentState(proposalId, CirclePaymentState.APPROVAL_PENDING, { detail: { approvedBy: prismId } });
    }
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
  async prepareContribution({ circleId, prismId, amountAtomic, validBefore = null }) {
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
      validBefore,
      intent: {
        circleId, contributionId, entryMethod: 'circle', memo: `Added to ${circle.name}`,
        // The Circle context rides on the ordinary operation from the moment it is prepared, so the
        // contribution shows up as a Circle payment everywhere the canonical projection is read —
        // the contributor's own Activity included — without a second record existing anywhere.
        circle: circleContext({
          circle, flow: CircleFlow.IN, approvalPolicy: CircleApprovalPolicy.CONTRIBUTION,
          contributionId, operationId: null,
          proposer: this._memberParty(circleId, prismId)
        })
      }
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
   * How much `memberPrismId` may withdraw from this Circle right now: their COMPLETED contributions
   * minus their COMPLETED withdrawals (never negative), capped by what the Safe actually holds on
   * Monad. The balance is always a live chain read — never the stored ledger — so this can never
   * promise more than the Circle could really pay out.
   */
  /**
   * The Circle's live Safe balance, read with a few short-bounded retries.
   *
   * Monad's public RPC intermittently stalls for tens of seconds or drops a read. This method backs
   * `withdrawablePreview`, which decides whether a member may take their money out — so a failed read
   * must NOT be reported as a $0 balance. Doing that (the old `.catch(() => 0n)`) silently disabled a
   * member's Withdraw of real funds while claiming, falsely, that there was nothing to withdraw.
   * INV-M1: a value that cannot be read is unknown, never invented. So we retry briefly, bound each
   * attempt so a stalled RPC can't hang the request past the client's timeout, and if every attempt
   * fails we throw (503) rather than fabricate a zero — the same "unavailable, not stale/zero" stance
   * the detail read takes for its balance.
   */
  async _liveSafeBalance(safeAddress, { tries = 3, perAttemptMs = 6000, gapMs = 250 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await Promise.race([
          this.safe.getUsdcBalance(safeAddress),
          new Promise((_, reject) => setTimeout(() => reject(new Error('balance read timed out')), perAttemptMs))
        ]);
      } catch (err) {
        lastErr = err;
        if (attempt < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
      }
    }
    const e = new Error("Prism couldn't read this Circle's balance from Monad just now — pull down to try again.");
    e.statusCode = 503;
    e.cause = lastErr;
    throw e;
  }

  async withdrawablePreview({ circleId, memberPrismId }) {
    const circle = this._circle(circleId);
    this._activeMember(circleId, memberPrismId);

    const data = this.store.read();
    const contributions = Object.values(data.circleContributions ?? {}).filter((c) => c.circleId === circleId);
    const withdrawals = Object.values(data.circleWithdrawals ?? {}).filter((w) => w.circleId === circleId);
    const net = netContributions(contributions, withdrawals);

    const balance = await this._liveSafeBalance(circle.safeAddress);
    const withdrawable = withdrawableFor(memberPrismId, net, balance);

    return {
      circleId, memberPrismId,
      netContributedAtomic: (net.get(memberPrismId) ?? 0n).toString(),
      balanceAtomic: balance.toString(),
      withdrawableAtomic: withdrawable.toString()
    };
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
    const circle = await this._spendableCircle(circleId, actorPrismId, PROPOSING_ROLES, 'pay from', { allowClosing: true });
    if (!this.payments) throw conflict('Circle payments are not available on this deployment');
    this._assertNotReturningFunds(circleId);
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
   * Propose a withdrawal: an ordinary threshold PAYMENT proposal whose recipient is the withdrawing
   * member's own Prism account rather than a resolved contact. There is no Protected Alias Resolver
   * step here — the recipient is already a known Circle member, so `getAddress` is applied directly
   * to their `authorityAddress` the same way `proposePayment` applies it to a resolved identity.
   *
   * The only thing this adds over a normal payment is the cap: the amount can never exceed what
   * `withdrawablePreview` says this member may take out right now (their COMPLETED contributions
   * minus their COMPLETED withdrawals, capped by the Safe's live balance). Nothing here approves or
   * executes anything — like every Circle payment, it still needs the Circle's normal threshold of
   * signatures before `executePayment` will touch it.
   */
  async proposeWithdrawal({ circleId, memberPrismId, amountAtomic }) {
    const circle = this._circle(circleId);
    const member = this._activeMember(circleId, memberPrismId);
    if (!this.payments) throw conflict('Circle payments are not available on this deployment');
    if (circle.status === CircleStatus.CLOSED) throw conflict('this Circle is closed');
    if (!SPENDING_STATUSES.includes(circle.status)) throw conflict('this Circle is not active on-chain yet');
    if (!circle.safeAddress) throw conflict('this Circle has no verified Safe address');
    if (!member.authorityAddress) throw badRequest('you have not finished setting up your Prism account');
    this._assertNotReturningFunds(circleId);

    const { withdrawableAtomic } = await this.withdrawablePreview({ circleId, memberPrismId });
    const amount = this._assertAmount(amountAtomic);
    if (BigInt(amount) > BigInt(withdrawableAtomic)) {
      throw conflict(`you can withdraw at most ${withdrawableAtomic} base units`);
    }

    // The proposer IS the beneficiary here — an ordinary member cashing out their own net
    // contribution. `proposeClosePayouts` below reuses the same builder with an ADMIN as the
    // proposer and each member in turn as the beneficiary.
    return this._createWithdrawalProposal({
      circle, actorPrismId: memberPrismId, beneficiaryPrismId: memberPrismId, beneficiaryMember: member, amount
    });
  }

  /**
   * The proposal-building body shared by `proposeWithdrawal` and `proposeClosePayouts`: an ordinary
   * threshold PAYMENT proposal to `beneficiaryMember`'s own account, tagged `withdrawal` so
   * `reconcilePayment`'s COMPLETED hook recognizes it and decrements the beneficiary's ledger the
   * same way regardless of who proposed it.
   *
   * `actorPrismId` and `beneficiaryPrismId` are deliberately separate parameters rather than one:
   * a member withdrawing their own money is both; an admin proposing a member's close-out payout
   * is only the former. Callers are responsible for whatever cap or authorization applies BEFORE
   * calling this — it performs no cap check of its own, since `proposeClosePayouts`'s pro-rata
   * amount is already bounded by construction (see `proRataPayouts`).
   */
  async _createWithdrawalProposal({ circle, actorPrismId, beneficiaryPrismId, beneficiaryMember, amount, closePayout = false }) {
    const memberAccount = getAddress(beneficiaryMember.authorityAddress);
    if (memberAccount === getAddress(circle.safeAddress)) throw badRequest('a Circle cannot pay itself');

    const authority = await this._readAuthority(circle);

    const withdrawalId = `wd_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const trace = [];
    const mark = (state, detail = {}) => trace.push({ state, at: new Date().toISOString(), detail });
    mark(CirclePaymentState.CREATED, { amount });

    const proposal = await this._createProposal({
      circle, actorPrismId, kind: ProposalKind.PAYMENT, authority,
      intent: { kind: 'PAYMENT', recipient: memberAccount, amountAtomic: amount },
      memo: `Withdrawal to ${beneficiaryMember.displayName ?? 'a member'}`,
      subject: { prismId: beneficiaryPrismId, authorityAddress: memberAccount },
      payment: {
        amount,
        recipientPrismId: beneficiaryPrismId,
        recipientAccount: memberAccount,
        recipientDisplayName: beneficiaryMember.displayName ?? null,
        recipientHandle: beneficiaryMember.handle ?? null,
        // A withdrawal has no alias resolution behind it — the recipient IS the member record — but
        // `_paymentContinuity` still binds every payment to the recipient's aliasVersion AT PROPOSAL
        // TIME so an approval re-check can tell whether that identity has mutated since. `null` here
        // would compare as 0 against a real identity's version (which starts at 1), so every
        // withdrawal would fail continuity at the first approval; the live version must be captured.
        aliasVersion: this.identityService.get(beneficiaryPrismId)?.aliasVersion ?? null,
        resolutionRequestId: null,
        resolutionRoute: null
      },
      trace
    });

    // `_createProposal` only knows about `payment` and `governance` proposals; a withdrawal tag is
    // written directly onto the persisted record (and mirrored onto the view returned here) so a
    // later confirmation hook can recognize this PAYMENT as a withdrawal without guessing from the
    // memo string.
    const tag = { beneficiaryPrismId, ...(closePayout ? { closePayout: true } : {}) };
    this.store.mutate((d) => {
      const stored = d.circleProposals?.[proposal.proposalId];
      if (stored) stored.withdrawal = tag;
    });
    proposal.withdrawal = tag;

    const withdrawalRecord = {
      ...newCircleWithdrawal({
        withdrawalId, circleId: circle.circleId, beneficiaryPrismId, beneficiaryAccount: memberAccount,
        amount, proposalId: proposal.proposalId
      }),
      ...(closePayout ? { closePayout: true } : {})
    };
    this.store.mutate((d) => { (d.circleWithdrawals ||= {})[withdrawalId] = withdrawalRecord; });

    return { proposal, withdrawalId };
  }

  /**
   * Preview, per member, what a Circle close would pay out right now: each member's net
   * contribution (COMPLETED contributions minus COMPLETED withdrawals) split pro-rata across the
   * Safe's live USDC balance — largest-remainder, so the payouts sum EXACTLY to the balance even
   * when the balance is short of total net contributions. Writes nothing; proposes nothing.
   */
  async planClosePayouts({ circleId }) {
    const circle = this._circle(circleId);

    const data = this.store.read();
    const contributions = Object.values(data.circleContributions ?? {}).filter((c) => c.circleId === circleId);
    const withdrawals = Object.values(data.circleWithdrawals ?? {}).filter((w) => w.circleId === circleId);
    const net = netContributions(contributions, withdrawals);

    const balance = await this.safe.getUsdcBalance(circle.safeAddress).catch(() => 0n);
    const payouts = proRataPayouts(net, balance);

    const members = data.circleMembers ?? {};
    const result = [...payouts.entries()].map(([prismId, amount]) => ({
      prismId,
      account: members[memberKey(circleId, prismId)]?.authorityAddress ?? null,
      amountAtomic: amount.toString()
    }));

    return { balanceAtomic: balance.toString(), payouts: result };
  }

  // A payout proposal is "outstanding" until its withdrawal-tagged PAYMENT reaches a terminal state.
  static CLOSE_TERMINAL_STATES = Object.freeze([
    CirclePaymentState.COMPLETED, CirclePaymentState.INVALIDATED,
    CirclePaymentState.EXPIRED, CirclePaymentState.CANCELLED, CirclePaymentState.FAILED
  ]);

  /**
   * Freeze each member's close entitlement the first time a close payout is requested, and reuse it
   * thereafter. This is what makes sequential payouts correct: pro-rata is `net_i / Σnet × balance`
   * computed ONCE, at close start. Recomputing it against the shrinking net after each payout would
   * over-pay whoever is paid first (their already-returned share still counts in `net`). Stored as
   * `{ circleId, balanceAtomic, targets: { prismId: amountString }, createdAt }`.
   */
  /** Drop a circle's frozen close plan. Called whenever a close starts, cancels, or finalizes, so a
   *  reopened close never reuses stale targets and ordinary spending unlocks again. */
  _clearClosePlan(circleId) {
    this.store.mutate((d) => { if (d.circleClosePlans) delete d.circleClosePlans[circleId]; });
  }

  /** While a close plan is frozen, the Circle is returning funds to members. Block any other spend so
   *  a side-channel payment or self-withdrawal can't drain the balance out from under the frozen plan
   *  (which would over-pay whoever's returned first and stale the pending close payout's nonce). */
  _assertNotReturningFunds(circleId) {
    if (this.store.read().circleClosePlans?.[circleId]) {
      throw conflict('this Circle is returning funds to members; no other payments until the close finishes or is cancelled');
    }
  }

  async _ensureClosePlan(circle) {
    const existing = this.store.read().circleClosePlans?.[circle.circleId];
    if (existing) return existing;

    const data = this.store.read();
    const contributions = Object.values(data.circleContributions ?? {}).filter((c) => c.circleId === circle.circleId);
    const withdrawals = Object.values(data.circleWithdrawals ?? {}).filter((w) => w.circleId === circle.circleId);
    const net = netContributions(contributions, withdrawals);
    const balance = await this.safe.getUsdcBalance(circle.safeAddress).catch(() => 0n);
    const payouts = proRataPayouts(net, balance);
    const targets = Object.fromEntries([...payouts.entries()].map(([id, amt]) => [id, amt.toString()]));
    const plan = { circleId: circle.circleId, balanceAtomic: balance.toString(), targets, createdAt: new Date().toISOString() };
    this.store.mutate((d) => { (d.circleClosePlans ||= {})[circle.circleId] = plan; });
    return plan;
  }

  /**
   * Return one member's money at a time. Every Circle payment builds against the CURRENT Safe nonce,
   * and execution refuses any proposal at a higher nonce — so a batch of payouts sharing one nonce
   * could only ever land one, leaving the rest to expire. Instead this proposes the SINGLE largest
   * unpaid payout from the FROZEN close plan (`_ensureClosePlan`); once it is approved and executed
   * the admin calls again for the next, until every target is met.
   *
   * Returns `{ proposal, remaining, skipped, done }`:
   *   - `proposal`  the single payout proposal created this call, or null (nothing left to propose, or
   *                 a payout is still in flight — only one is ever outstanding at a time).
   *   - `remaining` members still owed part of their frozen target, to a real account.
   *   - `skipped`   members still owed but with NO bound account — their residual keeps the balance
   *                 above zero, so the admin is told rather than left with a silently stuck close.
   *   - `done`      every target is met: nothing to propose, nothing in flight, no residual.
   * Each target is ≤ the member's net at close start by construction, so no per-payout cap is needed;
   * the ordinary admin threshold still gates whether any payout executes.
   */
  async proposeClosePayouts({ circleId, actorPrismId }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);
    if (!this.payments) throw conflict('Circle payments are not available on this deployment');
    if (circle.status === CircleStatus.CLOSED) throw conflict('this Circle is closed');
    if (!SPENDING_STATUSES.includes(circle.status)) throw conflict('this Circle is not active on-chain yet');
    if (!circle.safeAddress) throw conflict('this Circle has no verified Safe address');

    const plan = await this._ensureClosePlan(circle);
    const data = this.store.read();
    const members = data.circleMembers ?? {};

    // Amount already returned to each member via COMPLETED close payouts (frozen-plan progress).
    const paid = {};
    for (const w of Object.values(data.circleWithdrawals ?? {})) {
      if (w.circleId !== circleId || !w.closePayout || w.status !== CircleWithdrawalStatus.COMPLETED) continue;
      paid[w.beneficiaryPrismId] = (paid[w.beneficiaryPrismId] ?? 0n) + BigInt(w.amount);
    }

    // At most one close payout in flight at a time (single-nonce reality).
    const terminal = new Set(CircleService.CLOSE_TERMINAL_STATES);
    const outstanding = new Set(
      Object.values(data.circleProposals ?? {})
        .filter((p) => p.circleId === circleId && p.withdrawal?.closePayout && !terminal.has(p.lifecycle))
        .map((p) => p.withdrawal.beneficiaryPrismId)
    );

    const balance = await this.safe.getUsdcBalance(circle.safeAddress).catch(() => 0n);

    const skipped = [];
    const remaining = [];   // still owed, to a real account
    const eligible = [];    // still owed, has account, not in flight
    for (const [prismId, targetStr] of Object.entries(plan.targets)) {
      const owed = BigInt(targetStr) - (paid[prismId] ?? 0n);
      if (owed <= 0n) continue;
      const member = members[memberKey(circleId, prismId)];
      if (!member?.authorityAddress) { skipped.push({ prismId, amountAtomic: owed.toString() }); continue; }
      remaining.push({ prismId, account: member.authorityAddress, amountAtomic: owed.toString() });
      if (!outstanding.has(prismId)) eligible.push({ prismId, member, owed });
    }

    if (outstanding.size > 0) return { proposal: null, remaining, skipped, done: false };

    if (eligible.length > 0 && balance > 0n) {
      eligible.sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : (a.prismId < b.prismId ? -1 : 1)));
      const next = eligible[0];
      // Cap at the live balance in case non-close activity drained it below the frozen target.
      const amount = this._assertAmount((next.owed < balance ? next.owed : balance).toString());
      const proposal = await this._createWithdrawalProposal({
        circle, actorPrismId, beneficiaryPrismId: next.prismId, beneficiaryMember: next.member, amount, closePayout: true
      });
      // `remaining` lists every member not yet fully paid (COMPLETED) — including the one just
      // proposed, whose money has not moved yet; the returned `proposal` says which is now in flight.
      return { proposal, remaining, skipped, done: false };
    }

    // Nothing to propose and nothing in flight: done only when no unpaid residual remains at all.
    return { proposal: null, remaining, skipped, done: remaining.length === 0 && skipped.length === 0 };
  }

  /**
   * Move the `circleWithdrawals` record tied to a withdrawal-tagged PAYMENT proposal to a terminal
   * status. Found by `proposalId` — never trusted from a caller-supplied `withdrawalId` — so this
   * can only ever touch the one record that this exact proposal created. A record already COMPLETED
   * is left alone (this only ever runs once, from `reconcilePayment`'s own COMPLETED/FAILED branches,
   * but the guard costs nothing and keeps the terminal state honest under a retry).
   */
  _setWithdrawalForProposal(proposalId, status, extra = {}) {
    this.store.mutate((d) => {
      const record = Object.values(d.circleWithdrawals ?? {}).find((w) => w.proposalId === proposalId);
      if (!record || record.status === CircleWithdrawalStatus.COMPLETED) return;
      Object.assign(record, extra);
      record.status = status;
      record.updatedAt = new Date().toISOString();
    });
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
    const view = await this.getPayment({ circleId, proposalId, prismId });
    return { ...recorded, payment: view };
  }

  /**
   * Approve a Circle change that is not a payment.
   *
   * Same discipline as `approvePayment`, and deliberately a separate method rather than a relaxed
   * version of it: what has to be bound is different. A payment binds a recipient and an amount; a
   * governance change binds a *target and calldata*, and the only targets a Circle ever signs are
   * its own Safe and the configured Allowance Module. Everything else — including a proposal whose
   * fields were edited after the digest was computed — is refused before a signature is taken.
   */
  async approveGovernance({ circleId, proposalId, prismId, signature }) {
    const circle = this._circle(circleId);
    const proposal = this._proposal(circleId, proposalId);
    if (proposal.kind === ProposalKind.PAYMENT) throw badRequest('that proposal is a payment');
    if (!proposal.governance) throw badRequest('that proposal is not a governance change');

    const binding = this._governanceBinding(circle, proposal);
    if (!binding.ok) {
      this._setPaymentState(proposalId, CirclePaymentState.INVALIDATED, {
        extra: { failureReason: binding.reasons.join('; ') }, detail: { reasons: binding.reasons }
      });
      throw conflict(`this change was altered after it was proposed and can no longer be approved: ${binding.reasons.join('; ')}`);
    }

    const recorded = await this.recordApproval({ circleId, proposalId, prismId, signature });
    const view = await this._governanceView(this._proposal(circleId, proposalId), {});
    return { ...recorded, payment: view, governance: view };
  }

  /**
   * What a governance proposal must still be for its collected signatures to mean anything.
   *
   * The target check is the load-bearing one. A Safe transaction can call any address with any
   * calldata, so a Circle that could be talked into signing an arbitrary target would have no
   * safety property at all. Two addresses are legitimate and no others: the Circle's own Safe (for
   * its owner set, its threshold, and enabling the module) and the configured Allowance Module (for
   * delegates and limits). The digest recomputation then proves the signed bytes are the bytes of
   * exactly these fields.
   */
  _governanceBinding(circle, proposal) {
    const reasons = [];
    const tx = proposal.safeTransaction;
    const same = (a, b) => { try { return getAddress(a) === getAddress(b); } catch { return false; } };

    if (!tx) return { ok: false, reasons: ['this change has no recorded Safe transaction'] };
    if (!same(proposal.safeAddress, circle.safeAddress)) reasons.push('the Circle Safe is not the Safe this change was built for');
    if (String(proposal.chainId) !== String(circle.chainId)) reasons.push('the chain is not the chain this change was built for');
    if (Number(tx.operation) !== 0) reasons.push('the transaction is a delegatecall, which a Circle never signs');
    if (BigInt(tx.value ?? 0) !== 0n) reasons.push('the transaction moves native MON, which a Circle change never does');
    if (BigInt(tx.gasPrice ?? 0) !== 0n || BigInt(tx.baseGas ?? 0) !== 0n || BigInt(tx.safeTxGas ?? 0) !== 0n
      || !same(tx.gasToken, ZERO_ADDRESS) || !same(tx.refundReceiver, ZERO_ADDRESS)) {
      reasons.push('the gas-refund fields are not neutral, so a second unreviewed transaction could hide inside this one');
    }
    if (String(tx.nonce) !== String(proposal.safeNonce)) reasons.push('the Safe nonce is not the nonce this change was built for');

    // The two addresses a Circle may ever target, and which kinds may target which.
    const module = this.config.circles.allowanceModule;
    const targetsModule = SPENDING_LIMIT_KINDS.includes(proposal.kind) && proposal.kind !== ProposalKind.MODULE_ENABLE;
    if (targetsModule) {
      if (!module) reasons.push('this deployment has no configured Allowance Module, so this change cannot be approved');
      else if (!same(tx.to, module)) reasons.push('the transaction target is not the verified Allowance Module');
    } else if (!same(tx.to, circle.safeAddress)) {
      reasons.push('the transaction target is not this Circle');
    }

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
    return { ok: reasons.length === 0, reasons };
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
    if (!SPENDING_STATUSES.includes(circle.status)) throw conflict('this Circle is not active on-chain yet');

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

    // Withdrawal cap, re-derived from the ledger as it stands right now — the last checkpoint before
    // anything is broadcast. The propose-time check only proved the amount was safe THEN; another
    // withdrawal for the same member may have confirmed in the time since this one was proposed and
    // approved. Safe's own nonce ordering cannot catch that on its own: two withdrawals proposed
    // before either had executed are built against the SAME live nonce, so only one of them can ever
    // reach this point at all — this check is what stops that one from over-paying once it does.
    if (proposal.withdrawal) {
      const { withdrawableAtomic } = await this.withdrawablePreview({
        circleId, memberPrismId: proposal.withdrawal.beneficiaryPrismId
      });
      if (BigInt(proposal.amount) > BigInt(withdrawableAtomic)) {
        throw conflict(`this withdrawal can no longer be sent: at most ${withdrawableAtomic} base units are withdrawable now`);
      }
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
      extra: {
        executionTxHash: txHash,
        balanceBefore,
        // The exact signatures handed to `execTransaction`. The Safe re-derived the digest and
        // re-checked every one of them before it moved the money, so this is the set the CHAIN
        // accepted — which is what a receipt should name, and why it must not be re-derived later
        // from an owner set that has since changed.
        approvalsAtExecution: collected.map((a) => ({
          authorityAddress: a.authorityAddress, signatureType: a.signatureType, prismId: a.prismId ?? null
        }))
      },
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
  /**
   * Settle the viewer's broadcast-but-unconfirmed Circle payments (withdrawals included) against the
   * chain, so a payout that already landed on-chain stops showing as "Pending" in their Activity.
   * Without an Alchemy webhook wired, a Circle payment otherwise only reconciles when its own detail
   * screen is opened; the Activity list never opened it. Best-effort and idempotent: a read failure or
   * a still-unconfirmed tx leaves the row exactly as it was. Scoped to payments the viewer receives.
   */
  async reconcilePendingFor(prismId) {
    const pending = Object.values(this.store.read().circleProposals ?? {}).filter((p) =>
      p.kind === ProposalKind.PAYMENT
      && p.recipientPrismId === prismId
      && p.executionTxHash
      && (p.lifecycle === CirclePaymentState.SUBMITTED || p.lifecycle === CirclePaymentState.CONFIRMING)
    );
    for (const p of pending) {
      await this.reconcilePayment({ circleId: p.circleId, proposalId: p.proposalId, prismId }).catch(() => null);
    }
  }

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
      // A withdrawal whose payment did not really happen must not be treated as spent — the member's
      // net contribution is untouched, so a fresh withdrawal may still be proposed for it.
      if (proposal.withdrawal) this._setWithdrawalForProposal(proposalId, CircleWithdrawalStatus.FAILED);
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
    // The withdrawal's ledger effect lands here and only here: the same confirmed receipt that
    // completes the payment also completes the withdrawal it was tagged with, so `netContributions`
    // (and therefore `withdrawablePreview`) reflects it from this moment on — never before, since
    // nothing before this point is backed by an on-chain receipt.
    if (proposal.withdrawal) {
      this._setWithdrawalForProposal(proposalId, CircleWithdrawalStatus.COMPLETED, { transactionHash: proposal.executionTxHash });
    }
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
      collectedApprovals: count ?? (proposal.approvalsAtExecution?.length ?? null),
      // Before broadcast, approvals are re-counted from signatures against the LIVE owner set, so an
      // admin removed on-chain drops out by itself. Once the transaction is away they are the exact
      // signatures the Safe verified when it executed — a permanent fact about what happened, which
      // a later owner change must not rewrite.
      approvals: (collected ?? proposal.approvalsAtExecution ?? []).map((a) => ({
        authorityAddress: a.authorityAddress, signatureType: a.signatureType, prismId: a.prismId ?? null
      })),
      approvalsSource: collected
        ? 'verified signatures against the live owner set'
        : (proposal.approvalsAtExecution ? 'signatures the Safe verified at execution' : 'unavailable'),
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

  /**
   * A Circle the caller may move money in or out of, with the role check applied.
   *
   * `allowClosing` is the asymmetry that makes winding down possible: a Circle in CLOSING can still
   * pay money OUT — that is how the remaining balance leaves, by the members' own decision — but it
   * can never take money IN, because contributing to an account that is being shut down would strand
   * the contributor's money behind the same decision everyone else has already made.
   */
  async _spendableCircle(circleId, prismId, roles, verb, { allowClosing = false } = {}) {
    const circle = this._circle(circleId);
    const member = this._assertMember(circleId, prismId);
    if (!roles.includes(member.role)) throw forbidden(`your role in this Circle does not let you ${verb} it`);
    if (circle.status === CircleStatus.CLOSED) throw conflict('this Circle is closed');
    if (circle.status === CircleStatus.CLOSING && !allowClosing) {
      throw conflict('this Circle is being closed, so money cannot be added to it');
    }
    if (!SPENDING_STATUSES.includes(circle.status)) throw conflict('this Circle is not active on-chain yet');
    if (!circle.safeAddress) throw conflict('this Circle has no verified Safe address');
    return circle;
  }

  _assertAmount(value) {
    if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) throw badRequest('amount must be positive');
    if (BigInt(value) > this.config.limits.maxPaymentAtomic) throw badRequest('amount exceeds the Prism payment limit');
    return String(BigInt(value));
  }

  // ===========================================================================
  // Executing a governance proposal
  // ===========================================================================

  /**
   * Execute an approved non-payment Circle transaction — a limit change, a delegate add or remove,
   * enabling the module.
   *
   * Structurally identical to `executePayment`: live authority read, approvals re-verified against
   * the current owner set, the Safe's own nonce, simulate, then broadcast. The only thing that
   * differs is what counts as done. A payment is done when a USDC `Transfer` proves the money
   * moved; a limit change is done when **reading the module back** shows the limit the Circle
   * approved. That readback is the "Active" in the flow — until it succeeds, a limit is proposed,
   * not in force.
   */
  async executeGovernance({ circleId, proposalId, actorPrismId }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);
    const proposal = this._proposal(circleId, proposalId);
    if (!proposal.governance) throw badRequest('that proposal is not a governance change');
    if (!SPENDING_STATUSES.includes(circle.status)) throw conflict('this Circle is not active on-chain yet');

    if (CIRCLE_PAYMENT_IN_FLIGHT.includes(proposal.lifecycle)) {
      return this.reconcileGovernance({ circleId, proposalId, prismId: actorPrismId });
    }
    if (!CIRCLE_PAYMENT_PRE_BROADCAST.includes(proposal.lifecycle)) {
      throw conflict(proposal.failureReason
        ? `this change will not be sent: ${proposal.failureReason}`
        : `this change is ${proposal.lifecycle.toLowerCase()} and will not be sent`);
    }

    let authority;
    try { authority = await this._readAuthority(circle); }
    catch (e) { throw conflict(`Monad could not be read, so this change cannot be sent: ${e.message}`); }

    const collected = await this._collectApprovals(circle, proposal, authority.owners);
    if (collected.length < authority.threshold) {
      this._setPaymentState(proposalId, CirclePaymentState.APPROVAL_PENDING, {
        detail: { collected: collected.length, required: authority.threshold }
      });
      return {
        ...(await this._governanceView(this._proposal(circleId, proposalId), { authority, collected })),
        blocked: `${collected.length} of ${authority.threshold} approvals; this change cannot be applied yet`
      };
    }

    if (Number(proposal.safeNonce) < authority.nonce) {
      this._setPaymentState(proposalId, CirclePaymentState.EXPIRED, { detail: { reason: 'the Safe has already used this nonce' } });
      throw conflict('this change was built against a Safe nonce that has already been used; propose it again');
    }
    if (Number(proposal.safeNonce) > authority.nonce) {
      return {
        ...(await this._governanceView(proposal, { authority, collected })),
        blocked: 'an earlier Circle transaction must execute first'
      };
    }

    this._setPaymentState(proposalId, CirclePaymentState.APPROVED, {
      detail: { collected: collected.length, threshold: authority.threshold, source: 'live owner set' }
    });

    const tx = rehydrateTx(proposal.safeTransaction);
    const simulation = await this.safe.simulateExecution({ safeAddress: circle.safeAddress, tx, approvals: collected });
    this.store.mutate((d) => {
      d.circleProposals[proposalId].lastSimulation = { at: new Date().toISOString(), ok: simulation.ok, reason: simulation.reason ?? null };
    });
    if (!simulation.ok) {
      return {
        ...(await this._governanceView(this._proposal(circleId, proposalId), { authority, collected })),
        blocked: `this change was not applied because it would fail: ${simulation.reason}`,
        simulation: { ok: false, reason: simulation.reason }
      };
    }

    if (!this._reserveExecution(proposalId)) {
      return {
        ...(await this._governanceView(this._proposal(circleId, proposalId), { authority, collected })),
        blocked: 'this change is already being applied'
      };
    }

    let txHash;
    try {
      ({ txHash } = await this.safe.executeTransaction({ safeAddress: circle.safeAddress, tx, approvals: collected }));
    } catch (error) {
      this._releaseExecution(proposalId);
      throw error;
    }
    this._setPaymentState(proposalId, CirclePaymentState.SUBMITTED, {
      extra: {
        executionTxHash: txHash,
        approvalsAtExecution: collected.map((a) => ({
          authorityAddress: a.authorityAddress, signatureType: a.signatureType, prismId: a.prismId ?? null
        }))
      },
      detail: { txHash }
    });
    this._event(circleId, 'circle.governance.submitted', { proposalId, kind: proposal.kind, txHash });

    return this.reconcileGovernance({ circleId, proposalId, prismId: actorPrismId });
  }

  /**
   * Reconcile a governance change against chain truth.
   *
   * Two things must hold: the Safe reports `ExecutionSuccess` for this exact digest, and reading
   * the module back shows the state the Circle approved. The second is what makes this honest —
   * a transaction that succeeded but left the allowance at a different number is a failure, and
   * without the readback it would look like success.
   */
  async reconcileGovernance({ circleId, proposalId, prismId }) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    const proposal = this._proposal(circleId, proposalId);
    if (!proposal.governance) throw badRequest('that proposal is not a governance change');
    if (proposal.lifecycle === CirclePaymentState.COMPLETED || !proposal.executionTxHash) {
      return this._governanceView(proposal, {});
    }

    const receipt = await this.safe.getTransactionReceipt(proposal.executionTxHash).catch(() => null);
    if (!receipt) {
      this._setPaymentState(proposalId, CirclePaymentState.CONFIRMING, { detail: { txHash: proposal.executionTxHash } });
      return this._governanceView(this._proposal(circleId, proposalId), {});
    }
    if (receipt.status !== 'success') {
      this._setPaymentState(proposalId, CirclePaymentState.FAILED, {
        extra: { failureReason: 'the transaction reverted on Monad' }, detail: { txHash: proposal.executionTxHash }
      });
      return this._governanceView(this._proposal(circleId, proposalId), {});
    }

    const outcome = safeExecutionOutcome(receipt, { safeAddress: circle.safeAddress, safeTxHash: proposal.safeTxHash });
    if (outcome !== 'success') {
      this._setPaymentState(proposalId, CirclePaymentState.FAILED, {
        extra: { failureReason: outcome === 'failure' ? 'the Safe reported ExecutionFailure for this change' : 'the receipt carries no Safe ExecutionSuccess for this change' },
        detail: { txHash: proposal.executionTxHash }
      });
      return this._governanceView(this._proposal(circleId, proposalId), {});
    }

    this._setPaymentState(proposalId, CirclePaymentState.CONFIRMED, { detail: { txHash: proposal.executionTxHash } });

    // --- the readback. This is what "Active" means.
    const applied = await this._verifyGovernanceApplied(circle, proposal).catch((e) => ({ ok: false, reason: e.message }));
    if (!applied.ok) {
      this._setPaymentState(proposalId, CirclePaymentState.FAILED, {
        extra: { failureReason: applied.reason }, detail: { reason: applied.reason }
      });
      logger.error('circle.governance.readback.failed', { circleId, proposalId, reason: applied.reason });
      return this._governanceView(this._proposal(circleId, proposalId), {});
    }

    this._setPaymentState(proposalId, CirclePaymentState.RECONCILED, {
      extra: { executedAt: new Date().toISOString(), evidence: { transactionHash: proposal.executionTxHash, safeExecutionSuccess: true, readback: applied.state } },
      detail: { readback: applied.state }
    });
    this._setPaymentState(proposalId, CirclePaymentState.COMPLETED, { detail: {} });
    this.store.mutate((d) => { d.circleProposals[proposalId].status = ProposalStatus.EXECUTED; });
    this._event(circleId, 'circle.governance.completed', { proposalId, kind: proposal.kind, readback: applied.state });
    return this._governanceView(this._proposal(circleId, proposalId), {});
  }

  /** Read the module back and confirm it now says what the Circle approved. */
  async _verifyGovernanceApplied(circle, proposal) {
    const g = proposal.governance ?? {};
    switch (proposal.kind) {
      case ProposalKind.MODULE_ENABLE: {
        const enabled = await this.safe.isModuleEnabled(circle.safeAddress);
        return enabled
          ? { ok: true, state: { moduleEnabled: true } }
          : { ok: false, reason: 'the transaction succeeded but the module is still not enabled on this Circle' };
      }
      case ProposalKind.SPEND_DELEGATE_ADD: {
        const delegates = await this.safe.getSpendDelegates(circle.safeAddress);
        const present = delegates.some((d) => getAddress(d) === getAddress(g.delegate));
        return present
          ? { ok: true, state: { delegate: g.delegate, registered: true } }
          : { ok: false, reason: 'the transaction succeeded but the member is still not a registered spender' };
      }
      case ProposalKind.SPEND_DELEGATE_REMOVE: {
        const delegates = await this.safe.getSpendDelegates(circle.safeAddress);
        const present = delegates.some((d) => getAddress(d) === getAddress(g.delegate));
        if (present) return { ok: false, reason: 'the transaction succeeded but the member is still a registered spender' };
        // Revoking must also have zeroed the figures, or a later re-add would restore an old limit.
        const allowance = await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate: g.delegate });
        if (BigInt(allowance.amountAtomic) !== 0n) {
          return { ok: false, reason: 'the member was unregistered but their allowance figures were not cleared' };
        }
        return { ok: true, state: { delegate: g.delegate, registered: false, amountAtomic: '0' } };
      }
      case ProposalKind.SPEND_LIMIT_SET: {
        const allowance = await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate: g.delegate });
        if (allowance.amountAtomic !== String(g.amountAtomic)) {
          return { ok: false, reason: `the module reports a limit of ${allowance.amountAtomic}, not the ${g.amountAtomic} the Circle approved` };
        }
        if (Number(allowance.resetTimeMin) !== periodMinutes(g.period)) {
          return { ok: false, reason: `the module reports a ${allowance.resetTimeMin}-minute window, not the ${g.period} the Circle approved` };
        }
        return { ok: true, state: { delegate: g.delegate, amountAtomic: allowance.amountAtomic, period: allowance.period, spentAtomic: allowance.spentAtomic } };
      }
      case ProposalKind.SPEND_LIMIT_DELETE: {
        const allowance = await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate: g.delegate });
        return BigInt(allowance.amountAtomic) === 0n
          ? { ok: true, state: { delegate: g.delegate, amountAtomic: '0' } }
          : { ok: false, reason: 'the transaction succeeded but the allowance is still not zero' };
      }
      // Authority changes read back the Safe's own owner set and threshold. Nothing here trusts the
      // transaction having succeeded: `ExecutionSuccess` only says the Safe ran the call, and a call
      // that ran is not the same claim as an owner set that changed.
      case ProposalKind.OWNER_ADD: {
        const state = await this.safe.getCircleState(circle.safeAddress);
        const owners = state.owners.map((o) => getAddress(o));
        if (!owners.includes(getAddress(g.owner))) {
          return { ok: false, reason: 'the transaction succeeded but that person is still not an admin of this Circle' };
        }
        if (Number(state.threshold) !== Number(g.threshold)) {
          return { ok: false, reason: `the Circle now requires ${state.threshold} approvals, not the ${g.threshold} that was approved` };
        }
        return { ok: true, state: { owners, threshold: Number(state.threshold), added: getAddress(g.owner) } };
      }
      case ProposalKind.OWNER_REMOVE: {
        const state = await this.safe.getCircleState(circle.safeAddress);
        const owners = state.owners.map((o) => getAddress(o));
        if (owners.includes(getAddress(g.owner))) {
          return { ok: false, reason: 'the transaction succeeded but that person is still an admin of this Circle' };
        }
        if (Number(state.threshold) !== Number(g.threshold)) {
          return { ok: false, reason: `the Circle now requires ${state.threshold} approvals, not the ${g.threshold} that was approved` };
        }
        return { ok: true, state: { owners, threshold: Number(state.threshold), removed: getAddress(g.owner) } };
      }
      case ProposalKind.THRESHOLD_CHANGE: {
        const state = await this.safe.getCircleState(circle.safeAddress);
        if (Number(state.threshold) !== Number(g.threshold)) {
          return { ok: false, reason: `the Circle still requires ${state.threshold} approvals, not the ${g.threshold} that was approved` };
        }
        return { ok: true, state: { owners: state.owners.map((o) => getAddress(o)), threshold: Number(state.threshold) } };
      }
      default:
        return { ok: false, reason: `no readback is defined for ${proposal.kind}` };
    }
  }

  /** A governance proposal, with approvals re-counted from signatures against the live owner set. */
  async _governanceView(proposal, { authority: given = null, collected: givenCollected = null } = {}) {
    const circle = this._circle(proposal.circleId);
    const away = !CIRCLE_PAYMENT_PRE_BROADCAST.includes(proposal.lifecycle);

    let authority = given;
    let collected = givenCollected;
    if (!away) {
      authority ??= await this._readAuthority(circle).catch(() => null);
      if (authority && !collected) collected = await this._collectApprovals(circle, proposal, authority.owners);
    }

    const required = authority?.threshold ?? proposal.requiredApprovals;
    const count = collected?.length ?? null;
    let lifecycle = proposal.lifecycle;
    if (!away && count !== null) {
      lifecycle = count >= required ? CirclePaymentState.APPROVED : CirclePaymentState.APPROVAL_PENDING;
    } else if (away && EVIDENCE_BACKED_STATES.includes(lifecycle) && !proposal.evidence?.readback) {
      // The same rule as a payment: a change recorded as applied without a chain readback to back
      // it is a forgery, and reads back as one.
      lifecycle = CirclePaymentState.INVALIDATED;
    }

    return {
      proposalId: proposal.proposalId,
      circleId: proposal.circleId,
      circleName: circle.name,
      kind: proposal.kind,
      isSpendingLimitChange: SPENDING_LIMIT_KINDS.includes(proposal.kind),
      lifecycle,
      storedLifecycle: proposal.lifecycle,
      // The coarse proposal status alongside the fine-grained lifecycle, so a caller that only
      // needs "is this still open" does not have to interpret eleven states to find out.
      status: proposal.status,
      proposerPrismId: proposal.proposerPrismId,
      memo: proposal.memo,
      subject: proposal.subject ?? null,
      governance: proposal.governance ?? null,
      safeAddress: proposal.safeAddress,
      safeTxHash: proposal.safeTxHash,
      safeNonce: proposal.safeNonce,
      safeTransaction: proposal.safeTransaction,
      requiredApprovals: required,
      collectedApprovals: count ?? (proposal.approvalsAtExecution?.length ?? null),
      approvals: (collected ?? proposal.approvalsAtExecution ?? []).map((a) => ({ authorityAddress: a.authorityAddress, signatureType: a.signatureType })),
      approvalsSource: collected
        ? 'verified signatures against the live owner set'
        : (proposal.approvalsAtExecution ? 'signatures the Safe verified at execution' : 'unavailable'),
      executionTxHash: proposal.executionTxHash ?? null,
      evidence: proposal.evidence ?? null,
      failureReason: proposal.failureReason ?? null,
      lastSimulation: proposal.lastSimulation ?? null,
      createdAt: proposal.createdAt,
      executedAt: proposal.executedAt ?? null,
      expiresAt: proposal.expiresAt
    };
  }

  // ===========================================================================
  // Spending limits — Allowance Module v1.0.0, USDC only
  // ===========================================================================
  //
  // The shape of this section follows one rule: **a limit is a fact on Monad, and changing it is a
  // threshold-approved Circle transaction.** There is no method here that writes an allowance, and
  // no request shape in which a member changes their own. Prism builds the Safe transaction; the
  // Circle's admins approve it; the module stores it; and every number this service reports about a
  // limit is read back from the module rather than remembered.
  //
  // The module is verified before any of it is offered. `AllowanceModuleGate` re-reads the chain
  // and fails closed — a module that is not byte-identical to Safe's canonical v1.0.0 means limits
  // are simply unavailable and Circles falls back to threshold-only payments.

  /** The gate's verdict, re-checked against the chain. Callers get a reason, never a bare false. */
  async _assertLimitsAvailable(circle = null) {
    if (!this.limitGate) throw conflict('spending limits are not available on this deployment');
    const verdict = await this.limitGate.verify();
    if (!verdict.usable) throw conflict(`spending limits are unavailable: ${verdict.reason}`);
    if (circle) {
      const enabled = await this.safe.isModuleEnabled(circle.safeAddress);
      if (!enabled) {
        throw conflict('this Circle has not enabled the Allowance Module yet; an admin must propose enabling it first');
      }
    }
    return verdict;
  }

  /** Whether limits are on at all, with the reason when they are not. Safe to call unauthenticated-ish. */
  async limitsStatus() {
    if (!this.limitGate) return { enabled: false, reason: 'spending limits are not wired on this deployment' };
    const verdict = await this.limitGate.verify();
    return {
      enabled: verdict.usable,
      reason: verdict.usable ? null : verdict.reason,
      module: verdict.usable ? { address: verdict.address, version: verdict.version, codeHash: verdict.codeHash } : null,
      asset: CIRCLE_ASSET
    };
  }

  /**
   * Every member's live spending limit, read from the module.
   *
   * Members with no allowance are reported as having none rather than omitted — "Sarah has no
   * spending access" is a thing the UI has to be able to say, and it must come from the chain.
   */
  async listSpendingLimits(circleId, prismId) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    const status = await this.limitsStatus();
    if (!status.enabled || circle.status !== CircleStatus.ACTIVE) {
      return { circleId, limitsEnabled: false, reason: status.reason ?? 'this Circle is not active on-chain yet', limits: [] };
    }

    const moduleEnabled = await this.safe.isModuleEnabled(circle.safeAddress).catch(() => false);
    if (!moduleEnabled) {
      return { circleId, limitsEnabled: false, reason: 'the Allowance Module is not enabled on this Circle', limits: [] };
    }

    const members = this.listMembers(circleId, prismId).filter((m) => !TERMINAL_MEMBER_STATUSES.includes(m.status));
    const delegates = await this.safe.getSpendDelegates(circle.safeAddress).catch(() => null);
    if (!delegates) return { circleId, limitsEnabled: true, unavailable: 'Monad could not be read, so limits are unknown', limits: [] };
    const registered = new Set(delegates.map((d) => d.toLowerCase()));

    const limits = [];
    for (const member of members) {
      if (!member.authorityAddress) continue;
      const isDelegate = registered.has(member.authorityAddress.toLowerCase());
      const allowance = isDelegate
        ? await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate: member.authorityAddress }).catch(() => null)
        : null;
      limits.push(this._limitView({ member, allowance, isDelegate }));
    }
    return { circleId, limitsEnabled: true, module: status.module, limits };
  }

  /** One member's limit — the three numbers a person reads, all from the chain. */
  async spendingLimitFor(circleId, prismId, targetPrismId = null) {
    const { limits, limitsEnabled, reason } = await this.listSpendingLimits(circleId, prismId);
    const who = targetPrismId ?? prismId;
    const mine = limits.find((l) => l.prismId === who) ?? null;
    return { circleId, limitsEnabled, reason: reason ?? null, limit: mine };
  }

  /**
   * Prepare the NEXT threshold-approved transaction needed to put a member on a given limit.
   *
   * Up to three Safe transactions stand between "no spending access" and an active limit, and each
   * is its own proposal because each is its own Safe nonce:
   *
   *   1. `MODULE_ENABLE`       once per Circle — install the Allowance Module
   *   2. `SPEND_DELEGATE_ADD`  once per member — the module refuses `setAllowance` for a delegate
   *                            it does not know
   *   3. `SPEND_LIMIT_SET`     the limit itself
   *
   * They cannot be batched: batching would need a MultiSend `delegatecall`, and Circles refuses to
   * construct a delegatecall at all. So this returns the next step and says how many remain; call it
   * again once that step has executed. A step already satisfied on-chain is skipped, which makes
   * raising an existing limit a single proposal.
   */
  async prepareSpendingLimit({ circleId, actorPrismId, prismId, amountAtomic, period }) {
    const { circle, authority } = await this._activeCircleWithAuthority(circleId, actorPrismId);
    await this._assertLimitsAvailable();
    assertPeriod(period);
    const amount = assertAllowanceAmount(this._assertAmount(amountAtomic)).toString();

    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (!member) throw notFound('that person is not in this Circle');
    if (TERMINAL_MEMBER_STATUSES.includes(member.status)) throw conflict('that person has left this Circle');
    if (!member.authorityAddress) {
      throw badRequest(`${member.displayName ?? 'that person'} has not finished setting up their Prism account, so they cannot be given a spending limit`);
    }
    // The delegate IS the member's existing Prism authority address — the same account that holds
    // their personal USDC and, for an admin, owns the Safe. No new credential is minted for spending.
    const delegate = getAddress(member.authorityAddress);
    const moduleAddress = getAddress(this.config.circles.allowanceModule);

    const steps = await this._limitSteps({ circle, delegate, amount, period, moduleAddress });
    if (!steps.length) {
      return {
        circleId, prismId, complete: true,
        note: 'this limit is already what the Circle approved',
        limit: (await this.spendingLimitFor(circleId, actorPrismId, prismId)).limit
      };
    }

    const [next, ...rest] = steps;
    const proposal = await this._createProposal({
      circle, actorPrismId, kind: next.kind, authority, intent: next.intent, memo: next.memo,
      subject: { prismId, authorityAddress: delegate, amount, period, step: next.kind },
      governance: {
        delegate, prismId, amountAtomic: amount, period,
        module: moduleAddress, step: next.kind, remainingSteps: rest.map((r) => r.kind),
        previous: next.previous ?? null
      }
    });

    return { ...proposal, remainingSteps: rest.map((r) => r.kind), complete: false };
  }

  /**
   * Which of the three steps still need doing, decided from chain state rather than from Prism's
   * records. A Circle that enabled the module months ago and a member who is already a delegate
   * both skip straight to the limit itself.
   */
  async _limitSteps({ circle, delegate, amount, period, moduleAddress }) {
    const steps = [];
    const enabled = await this.safe.isModuleEnabled(circle.safeAddress);
    if (!enabled) {
      steps.push({
        kind: ProposalKind.MODULE_ENABLE,
        intent: { kind: 'MODULE_ENABLE', module: moduleAddress },
        memo: 'Turn on member spending limits for this Circle'
      });
    }

    // A module that is not yet enabled has no delegates and no allowances, so the remaining steps
    // are both required and there is nothing to read.
    const delegates = enabled ? await this.safe.getSpendDelegates(circle.safeAddress) : [];
    const isDelegate = delegates.some((d) => getAddress(d) === delegate);
    if (!isDelegate) {
      steps.push({
        kind: ProposalKind.SPEND_DELEGATE_ADD,
        intent: { kind: 'SPEND_DELEGATE_ADD', module: moduleAddress, delegate },
        memo: 'Allow this member to spend from the Circle'
      });
    }

    const current = enabled && isDelegate
      ? await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate }).catch(() => null)
      : null;
    const alreadySet = current
      && current.amountAtomic === String(amount)
      && Number(current.resetTimeMin) === periodMinutes(period);
    if (!alreadySet) {
      steps.push({
        kind: ProposalKind.SPEND_LIMIT_SET,
        intent: { kind: 'SPEND_LIMIT_SET', module: moduleAddress, delegate, amountAtomic: amount, period },
        memo: `Set this member's limit to ${formatUsdc(amount, this.config.chain.usdcDecimals)} ${PERIOD_LABELS[period]}`,
        // What the module says the limit is *now*, so the activity feed can report "$50/day →
        // $100/day" instead of announcing a number with no before. Null when there was none — the
        // feed then says the limit was set, and invents no previous value. A registered delegate
        // with a zero allowance had no limit either: an arrow from "$0.00" would be a fiction about
        // an intermediate step of granting one.
        previous: current && BigInt(current.amountAtomic) > 0n
          ? { amountAtomic: current.amountAtomic, period: current.period } : null
      });
    }
    return steps;
  }

  /**
   * Prepare the threshold-approved transaction that removes a member's spending access entirely.
   *
   * `removeDelegate(delegate, removeAllowances: true)` unregisters them AND zeroes the figures, so
   * there is nothing left for a later re-add to silently restore. Nothing about this is visible in
   * the app until the transaction has executed and the chain has been re-read — a stale session
   * cannot preserve spending access, because the app never had the authority in the first place.
   * Only the module's delegate list did, and that is what changes.
   */
  async prepareSpendingLimitRevoke({ circleId, actorPrismId, prismId }) {
    const { circle, authority } = await this._activeCircleWithAuthority(circleId, actorPrismId);
    await this._assertLimitsAvailable(circle);

    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (!member?.authorityAddress) throw notFound('that person is not in this Circle');
    const delegate = getAddress(member.authorityAddress);
    const moduleAddress = getAddress(this.config.circles.allowanceModule);

    const delegates = await this.safe.getSpendDelegates(circle.safeAddress);
    if (!delegates.some((d) => getAddress(d) === delegate)) {
      throw conflict('that person already has no spending access to this Circle');
    }

    return this._createProposal({
      circle, actorPrismId, kind: ProposalKind.SPEND_DELEGATE_REMOVE, authority,
      intent: { kind: 'SPEND_DELEGATE_REMOVE', module: moduleAddress, delegate },
      memo: `Remove ${member.displayName ?? member.handle ?? 'this member'}'s spending access`,
      subject: { prismId, authorityAddress: delegate, step: 'SPEND_DELEGATE_REMOVE' },
      governance: { delegate, prismId, module: moduleAddress, step: 'SPEND_DELEGATE_REMOVE', remainingSteps: [] }
    });
  }

  // ===========================================================================
  // Routing a payment: within the limit, or to the Circle for approval
  // ===========================================================================

  /**
   * Decide how a member's intended payment can actually happen, from live chain state.
   *
   * This is what makes the over-limit experience a fork rather than a dead end. A member who tries
   * to spend $140 against a $100 daily limit is not doing anything wrong — they are doing something
   * that needs the Circle's agreement instead of their own — and the honest answer names the limit,
   * the amount, and the route that remains open.
   *
   * Every number here is read fresh. A cached allowance is exactly the thing that would let a spend
   * through after the Circle had already cut it.
   */
  async previewPayment({ circleId, actorPrismId, amountAtomic }) {
    const circle = await this._spendableCircle(circleId, actorPrismId, PROPOSING_ROLES, 'pay from', { allowClosing: true });
    const amount = this._assertAmount(amountAtomic);
    const decimals = this.config.chain.usdcDecimals;

    const threshold = {
      route: 'THRESHOLD',
      requiresApproval: true,
      // The Circle's live threshold, so the sheet can say "needs 2 of 3" rather than guessing.
      requiredApprovals: await this._readAuthority(circle).then((a) => a.threshold).catch(() => null)
    };

    const status = await this.limitsStatus();
    if (!status.enabled) {
      return { circleId, amountAtomic: amount, ...threshold, reason: status.reason, limit: null };
    }

    const member = this._assertMember(circleId, actorPrismId);
    if (!member.authorityAddress) return { circleId, amountAtomic: amount, ...threshold, reason: 'your Prism account is not ready', limit: null };

    const moduleEnabled = await this.safe.isModuleEnabled(circle.safeAddress).catch(() => false);
    if (!moduleEnabled) {
      return { circleId, amountAtomic: amount, ...threshold, reason: 'this Circle has not turned on spending limits', limit: null };
    }

    const delegates = await this.safe.getSpendDelegates(circle.safeAddress).catch(() => []);
    if (!delegates.some((d) => getAddress(d) === getAddress(member.authorityAddress))) {
      return { circleId, amountAtomic: amount, ...threshold, reason: 'you do not have a spending limit in this Circle', limit: null };
    }

    const allowance = await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate: member.authorityAddress })
      .catch(() => null);
    if (!allowance) {
      return { circleId, amountAtomic: amount, ...threshold, reason: 'Monad could not be read, so your limit is unknown', limit: null };
    }

    const limit = this._limitView({ member: { ...member, prismId: actorPrismId }, allowance, isDelegate: true });
    if (BigInt(amount) <= BigInt(allowance.availableAtomic)) {
      return {
        circleId, amountAtomic: amount, route: 'ALLOWANCE', requiresApproval: false,
        reason: null, limit
      };
    }

    // Over the limit. Name the limit in the language it was set in, and offer the way forward —
    // this is a fork, not a refusal, and the wording is the difference between the two.
    const headline = formatUsdc(allowance.amountAtomic, decimals);
    const adjective = PERIOD_ADJECTIVES[allowance.period] ?? 'spending';
    return {
      circleId,
      amountAtomic: amount,
      ...threshold,
      overLimit: true,
      reason: `This is above your ${headline} ${adjective} limit.`,
      prompt: 'Request approval from the Circle?',
      shortfallAtomic: (BigInt(amount) - BigInt(allowance.availableAtomic)).toString(),
      limit
    };
  }

  /**
   * Prepare a within-limit spend for the member to sign.
   *
   * The member signs the module's own EIP-712 transfer hash — cross-checked against the deployed
   * module before it is handed over — and a Prism relayer submits it, so the member still holds
   * MON = 0. The nonce in that hash is the module's per-delegate counter, which is what makes one
   * signature good for exactly one transfer.
   */
  async prepareSpend({ circleId, actorPrismId, resolution, amountAtomic, memo = '' }) {
    const circle = await this._spendableCircle(circleId, actorPrismId, PROPOSING_ROLES, 'pay from', { allowClosing: true });
    await this._assertLimitsAvailable(circle);
    if (!this.payments) throw conflict('Circle payments are not available on this deployment');
    const amount = this._assertAmount(amountAtomic);

    const member = this._assertMember(circleId, actorPrismId);
    const delegate = getAddress(member.authorityAddress ?? '');

    // Same Protected Alias Resolver as every other Prism payment: a spend inside a limit is still a
    // payment to a person, and it inherits Prism Continuity whole.
    const { identity: recipient, attestation } = this.payments.assertResolution(resolution, actorPrismId);
    if (!recipient?.accountAddress) throw badRequest('that person has not finished setting up their Prism account');
    if (getAddress(recipient.accountAddress) === getAddress(circle.safeAddress)) throw badRequest('a Circle cannot pay itself');

    // Fresh read, immediately before authorization. This is the check that stops a spend authorized
    // against a limit the Circle has since cut.
    const allowance = await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate });
    if (!allowance.configured) throw conflict('you do not have a spending limit in this Circle');
    if (BigInt(amount) > BigInt(allowance.availableAtomic)) {
      throw conflict(`this is above your ${formatUsdc(allowance.amountAtomic, this.config.chain.usdcDecimals)} limit; ask the Circle to approve it instead`);
    }

    const transferHash = await this.safe.getAllowanceTransferHash({
      safeAddress: circle.safeAddress, recipient: recipient.accountAddress, amountAtomic: amount, nonce: allowance.nonce
    });

    const spendId = `spd_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const spend = {
      spendId,
      circleId,
      spenderPrismId: actorPrismId,
      delegate,
      recipientPrismId: recipient.prismId,
      recipientAccount: getAddress(recipient.accountAddress),
      recipientDisplayName: recipient.displayName ?? null,
      recipientHandle: recipient.handle ? `@${recipient.handle}` : null,
      aliasVersion: recipient.aliasVersion,
      resolutionRequestId: attestation.requestId,
      amount,
      asset: CIRCLE_ASSET,
      memo: String(memo ?? '').trim().slice(0, 120),
      module: getAddress(this.config.circles.allowanceModule),
      safeAddress: circle.safeAddress,
      chainId: circle.chainId,
      token: getAddress(this.config.chain.usdc),
      // The module's per-delegate nonce this signature is bound to. A spend prepared against a
      // stale nonce simply will not verify, which is the replay protection.
      allowanceNonce: allowance.nonce,
      transferHash,
      status: 'PREPARED',
      transactionHash: null,
      evidence: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      limitAtSigning: {
        amountAtomic: allowance.amountAtomic, spentAtomic: allowance.spentAtomic,
        availableAtomic: allowance.availableAtomic, period: allowance.period
      }
    };
    this.store.mutate((d) => { (d.circleSpends ||= {})[spendId] = spend; });
    this._event(circleId, 'circle.spend.prepared', { spendId, amount, spenderPrismId: actorPrismId });

    return { spend: this._spendView(spend), transferHash, limit: this._limitView({ member: { ...member, prismId: actorPrismId }, allowance, isDelegate: true }) };
  }

  /**
   * Verify, re-read, simulate, relay.
   *
   * The order matters. The signature is checked against the transfer hash and the member's own
   * authority first; then the allowance is re-read from the chain, because approvals-to-broadcast is
   * a window in which the Circle may have cut the limit; then the module itself is asked, by
   * simulation, whether it would allow this. Only then is anything broadcast.
   */
  async submitSpend({ circleId, spendId, prismId, signature }) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    await this._assertLimitsAvailable(circle);

    const spend = this.store.read().circleSpends?.[spendId];
    if (!spend || spend.circleId !== circleId) throw notFound('spend not found');
    if (spend.spenderPrismId !== prismId) throw forbidden('that spend belongs to someone else');
    if (spend.status === 'COMPLETED') return this.reconcileSpend({ circleId, spendId, prismId });
    if (spend.status !== 'PREPARED') throw conflict(`this spend is already ${spend.status.toLowerCase()}`);

    // 1. The signature is the member's own, over this exact transfer hash.
    const recovered = await recoverAddress({ hash: spend.transferHash, signature }).catch(() => null);
    if (!recovered || getAddress(recovered) !== getAddress(spend.delegate)) {
      throw forbidden('that authorization was not signed by your Prism account');
    }

    // 2. Continuity: the person being paid must still be the person who was reviewed.
    const continuity = this._paymentContinuity({
      recipientPrismId: spend.recipientPrismId,
      recipientAccount: spend.recipientAccount,
      payment: { aliasVersion: spend.aliasVersion }
    });
    if (!continuity.ok) {
      this._failSpend(spendId, continuity.reason);
      throw conflict(continuity.reason);
    }

    // 3. FRESH allowance read, immediately before authorizing. Never the figures from prepare time.
    const allowance = await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate: spend.delegate });
    if (!allowance.configured) {
      this._failSpend(spendId, 'your spending access was removed');
      throw conflict('your spending access to this Circle was removed');
    }
    if (Number(allowance.nonce) !== Number(spend.allowanceNonce)) {
      this._failSpend(spendId, 'the allowance moved on; this authorization is stale');
      throw conflict('this authorization is stale — another spend used it first. Try again.');
    }
    if (BigInt(spend.amount) > BigInt(allowance.availableAtomic)) {
      this._failSpend(spendId, 'the limit changed and no longer covers this spend');
      throw conflict(`your limit changed: ${formatUsdc(allowance.availableAtomic, this.config.chain.usdcDecimals)} is available now`);
    }

    // 4. Ask the module. A successful simulation is the MODULE agreeing, not Prism asserting.
    const simulation = await this.safe.simulateAllowanceTransfer({
      safeAddress: circle.safeAddress, recipient: spend.recipientAccount,
      amountAtomic: spend.amount, delegate: spend.delegate, signature
    });
    if (!simulation.ok) {
      return { spend: this._spendView(spend), blocked: `this spend was not sent because it would fail: ${simulation.reason}`, simulation };
    }

    const balanceBefore = await this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null);
    const { txHash } = await this.safe.submitAllowanceTransfer({
      safeAddress: circle.safeAddress, recipient: spend.recipientAccount,
      amountAtomic: spend.amount, delegate: spend.delegate, signature
    });
    this.store.mutate((d) => {
      const record = d.circleSpends[spendId];
      record.status = 'SUBMITTED';
      record.transactionHash = txHash;
      record.balanceBefore = balanceBefore;
      record.submittedAt = new Date().toISOString();
    });
    this._event(circleId, 'circle.spend.submitted', { spendId, txHash, amount: spend.amount });

    return this.reconcileSpend({ circleId, spendId, prismId });
  }

  /** COMPLETED needs the same three-part evidence a threshold payment needs. Nothing is rounded up. */
  async reconcileSpend({ circleId, spendId, prismId }) {
    const circle = this._circle(circleId);
    this._assertMember(circleId, prismId);
    const spend = this.store.read().circleSpends?.[spendId];
    if (!spend || spend.circleId !== circleId) throw notFound('spend not found');
    if (spend.status === 'COMPLETED' || spend.status === 'FAILED' || !spend.transactionHash) {
      return { spend: this._spendView(spend) };
    }

    const receipt = await this.safe.getTransactionReceipt(spend.transactionHash).catch(() => null);
    if (!receipt) {
      this.store.mutate((d) => { d.circleSpends[spendId].status = 'CONFIRMING'; });
      return { spend: this._spendView(this.store.read().circleSpends[spendId]) };
    }

    const evidence = this.safe.verifyAllowanceTransferEvidence({
      receipt, safeAddress: circle.safeAddress, recipient: spend.recipientAccount, amountAtomic: spend.amount
    });
    if (!evidence.ok) {
      this._failSpend(spendId, evidence.reason);
      return { spend: this._spendView(this.store.read().circleSpends[spendId]) };
    }

    const balanceAfter = await this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null);
    const limitAfter = await this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate: spend.delegate }).catch(() => null);
    this.store.mutate((d) => {
      const record = d.circleSpends[spendId];
      record.status = 'COMPLETED';
      record.evidence = { transactionHash: spend.transactionHash, blockNumber: evidence.blockNumber, transfer: evidence.transfer };
      record.balanceAfter = balanceAfter;
      record.limitAfter = limitAfter
        ? { amountAtomic: limitAfter.amountAtomic, spentAtomic: limitAfter.spentAtomic, availableAtomic: limitAfter.availableAtomic }
        : null;
      record.completedAt = new Date().toISOString();
    });
    this._event(circleId, 'circle.spend.completed', { spendId, amount: spend.amount, transactionHash: spend.transactionHash });
    return { spend: this._spendView(this.store.read().circleSpends[spendId]) };
  }

  listSpends(circleId, prismId) {
    this._circle(circleId);
    this._assertMember(circleId, prismId);
    const spends = Object.values(this.store.read().circleSpends ?? {})
      .filter((s) => s.circleId === circleId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { circleId, spends: spends.map((s) => this._spendView(s)) };
  }

  _failSpend(spendId, reason) {
    this.store.mutate((d) => {
      const spend = d.circleSpends[spendId];
      if (spend.status === 'COMPLETED') return;
      spend.status = 'FAILED';
      spend.failureReason = reason;
    });
    logger.warn('circle.spend.failed', { spendId, reason });
  }

  _limitView({ member, allowance, isDelegate }) {
    const decimals = this.config.chain.usdcDecimals;
    if (!isDelegate || !allowance || !allowance.configured) {
      return {
        prismId: member.prismId,
        displayName: member.displayName ?? null,
        handle: member.handle ?? null,
        authorityAddress: member.authorityAddress ?? null,
        hasSpendingAccess: false,
        // Said in the app's own words, because "no allowance row" and "no spending access" must not
        // be two different-looking things.
        summary: 'No spending access',
        source: 'chain'
      };
    }
    return {
      prismId: member.prismId,
      displayName: member.displayName ?? null,
      handle: member.handle ?? null,
      authorityAddress: member.authorityAddress,
      hasSpendingAccess: true,
      period: allowance.period,
      periodLabel: PERIOD_LABELS[allowance.period] ?? null,
      limitAtomic: allowance.amountAtomic,
      spentAtomic: allowance.spentAtomic,
      availableAtomic: allowance.availableAtomic,
      limitDisplay: formatUsdc(allowance.amountAtomic, decimals),
      spentDisplay: formatUsdc(allowance.spentAtomic, decimals),
      availableDisplay: formatUsdc(allowance.availableAtomic, decimals),
      summary: `${formatUsdc(allowance.amountAtomic, decimals)} ${PERIOD_LABELS[allowance.period] ?? ''}`.trim(),
      windowStartedAt: allowance.windowStartedAt,
      resetsAt: allowance.resetsAt,
      nonce: allowance.nonce,
      asset: CIRCLE_ASSET,
      token: allowance.token,
      decimals,
      // Every figure above came from `AllowanceModule.getTokenAllowance` on this read. None of it is
      // derived from Prism's activity, which would drift on a period rollover or an unseen transfer.
      source: 'chain'
    };
  }

  _spendView(spend) {
    const decimals = this.config.chain.usdcDecimals;
    return {
      spendId: spend.spendId,
      circleId: spend.circleId,
      spenderPrismId: spend.spenderPrismId,
      recipientPrismId: spend.recipientPrismId,
      recipientAccount: spend.recipientAccount,
      recipientDisplayName: spend.recipientDisplayName,
      recipientHandle: spend.recipientHandle,
      amount: spend.amount,
      amountDisplay: formatUsdc(spend.amount, decimals),
      asset: spend.asset,
      memo: spend.memo,
      route: 'ALLOWANCE',
      status: spend.status,
      transactionHash: spend.transactionHash,
      evidence: spend.evidence ?? null,
      failureReason: spend.failureReason ?? null,
      allowanceNonce: spend.allowanceNonce,
      limitAtSigning: spend.limitAtSigning ?? null,
      limitAfter: spend.limitAfter ?? null,
      createdAt: spend.createdAt,
      completedAt: spend.completedAt ?? null
    };
  }

  // ===========================================================================
  // The canonical payment surface — one Prism payment, with Circle context
  // ===========================================================================
  //
  // A Circle does not get its own transaction history. Money out of a Circle, money into a Circle
  // and a within-limit spend are all projected into the SAME canonical PrismPayment that a personal
  // payment projects into, carrying an extra `circle` block that says which shared account it came
  // from and what authority released it. The receipt is the ordinary receipt; the proof is the
  // ordinary proof, extended. Nothing below writes state — these are views over records that were
  // already reconciled against the chain.

  /** Which Circle record an id belongs to. Ids are prefixed at creation, so this needs no lookup. */
  static kindOfPaymentId(paymentId) { return circlePaymentKindOfId(paymentId); }

  /** True when this id addresses something Circles owns rather than an ordinary operation. */
  static isCirclePaymentId(paymentId) { return isCirclePaymentId(paymentId); }

  /**
   * The canonical projection of one Circle payment: `{ payment, events, receipt }`.
   *
   * Identical in shape to `PaymentService.canonicalFor`, and deliberately so — the phone opens the
   * same detail screen for a Circle payment as for a personal one. Reconciles against the chain
   * first, so a payment that settled since the last read is settled here too.
   */
  async canonicalFor(paymentId, prismId) {
    const kind = CircleService.kindOfPaymentId(paymentId);
    if (!kind) throw notFound('payment not found');
    const ctx = { viewerPrismId: prismId, identityService: this.identityService };

    if (kind === 'proposal') {
      const proposal = this._anyProposal(paymentId);
      if (proposal.kind !== ProposalKind.PAYMENT) throw notFound('payment not found');
      const circle = this._circle(proposal.circleId);
      const audience = this._audience(circle.circleId, prismId, proposal.recipientPrismId);
      if (audience === AUDIENCE_MEMBER) {
        await this.reconcilePayment({ circleId: circle.circleId, proposalId: paymentId, prismId }).catch(() => null);
      }
      const { operation } = await this._projectProposal(circle, this._anyProposal(paymentId), { audience });
      return { payment: canonicalPayment(operation, ctx), events: operation.events, receipt: receiptFor(operation, ctx) };
    }

    if (kind === 'spend') {
      const spend = this._anySpend(paymentId);
      const circle = this._circle(spend.circleId);
      const audience = this._audience(circle.circleId, prismId, spend.recipientPrismId);
      if (audience === AUDIENCE_MEMBER) {
        await this.reconcileSpend({ circleId: circle.circleId, spendId: paymentId, prismId }).catch(() => null);
      }
      const operation = this._projectSpend(circle, this._anySpend(paymentId), { audience });
      return { payment: canonicalPayment(operation, ctx), events: operation.events, receipt: receiptFor(operation, ctx) };
    }

    const contribution = this._contribution(paymentId);
    const circle = this._circle(contribution.circleId);
    const audience = this._audience(circle.circleId, prismId, contribution.contributorPrismId);
    if (audience === AUDIENCE_MEMBER) {
      await this.reconcileContribution({ circleId: circle.circleId, contributionId: paymentId, prismId }).catch(() => null);
    }
    const operation = this._projectContribution(circle, this._contribution(paymentId), { audience });
    return { payment: canonicalPayment(operation, ctx), events: operation.events ?? [], receipt: receiptFor(operation, ctx) };
  }

  /**
   * Who is asking, and how much of the Circle they are entitled to see.
   *
   * A member sees the Circle. Someone who was paid by it — or who put money into it and has since
   * left — sees *their own* payment, which legitimately names the Circle that paid them, and nothing
   * about how the Circle governs itself. Anyone else gets the same answer they get for a Circle they
   * are not in: not found.
   */
  _audience(circleId, prismId, counterpartyPrismId = null) {
    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (member && !TERMINAL_MEMBER_STATUSES.includes(member.status)) return AUDIENCE_MEMBER;
    if (counterpartyPrismId && counterpartyPrismId === prismId) return AUDIENCE_COUNTERPARTY;
    throw notFound('payment not found');
  }

  /**
   * Strip a Circle's internal governance out of a payment's context.
   *
   * The person who was paid is entitled to know which Circle paid them — that is the receipt. They
   * are not entitled to its approvals, its proposer, or how many admins it takes to spend, which are
   * facts about the Circle rather than about their money.
   */
  _restrictContext(context) {
    return {
      ...context,
      approvers: [],
      proposer: null,
      requiredApprovals: null,
      approvalRule: null,
      policy: null,
      safeTxHash: context.safeTxHash,
      spendingLimitReference: null,
      restricted: true
    };
  }

  /** A threshold payment as an operation record plus the view it was projected from. */
  async _projectProposal(circle, proposal, { authority = null, view = null, audience = AUDIENCE_MEMBER } = {}) {
    const resolved = view ?? await this._paymentView(circle, proposal, { authority });
    const context = circleContext({
      circle,
      flow: CircleFlow.OUT,
      approvalPolicy: CircleApprovalPolicy.THRESHOLD,
      proposalId: proposal.proposalId,
      safeTxHash: proposal.safeTxHash,
      safeNonce: proposal.safeNonce,
      requiredApprovals: resolved.requiredApprovals,
      adminCount: authority?.adminCount ?? null,
      // Only signatures that verified against this digest AND a current owner are here; an approval
      // that stopped counting is absent rather than listed as historical.
      approvers: (resolved.approvals ?? []).map((a) => this._approverParty(circle.circleId, a)),
      proposer: this._memberParty(circle.circleId, proposal.proposerPrismId),
      state: resolved.lifecycle
    });
    const scoped = audience === AUDIENCE_MEMBER ? context : this._restrictContext(context);
    return { operation: proposalAsOperation({ circle, proposal, view: resolved, context: scoped }), view: resolved, context: scoped };
  }

  /** A within-limit spend as an operation record. Its authority is the module, not a vote. */
  _projectSpend(circle, spend, { audience = AUDIENCE_MEMBER } = {}) {
    const limit = spend.limitAtSigning ?? null;
    const context = circleContext({
      circle,
      flow: CircleFlow.OUT,
      approvalPolicy: CircleApprovalPolicy.SPENDING_LIMIT,
      proposer: this._memberParty(circle.circleId, spend.spenderPrismId),
      state: spendCircleState(spend),
      operationId: spend.spendId,
      // The limit this spend was authorized against, named rather than summarized: a receipt that
      // says "within Sarah's limit" has to be able to say *which* limit, as it stood at signing.
      spendingLimitReference: {
        module: spend.module ?? null,
        delegate: spend.delegate ?? null,
        period: limit?.period ?? null,
        periodLabel: limit?.period ? (PERIOD_LABELS[limit.period] ?? null) : null,
        limitAtomic: limit?.amountAtomic ?? null,
        availableAtSigningAtomic: limit?.availableAtomic ?? null,
        allowanceNonce: spend.allowanceNonce ?? null,
        summary: limit?.amountAtomic
          ? `${formatUsdc(limit.amountAtomic, this.config.chain.usdcDecimals)} ${PERIOD_LABELS[limit.period] ?? ''}`.trim()
          : null,
        source: 'chain'
      }
    });
    return spendAsOperation({ circle, spend, context: audience === AUDIENCE_MEMBER ? context : this._restrictContext(context) });
  }

  /**
   * A contribution's canonical operation.
   *
   * There is nothing to build here: a contribution IS an ordinary Prism operation, and it already
   * carries its Circle context in the intent it was prepared with. All this does is refresh the
   * Circle's display name, which is Prism-owned and may have changed since.
   */
  _projectContribution(circle, contribution, { audience = AUDIENCE_MEMBER } = {}) {
    const operation = this.store.read().operations?.[contribution.operationId];
    if (!operation) throw notFound('the payment for this contribution is missing');
    const stored = operation.intent?.circle ?? null;
    const context = stored
      ? { ...stored, circleName: circle.name, circleIcon: circle.icon ?? null, contributionId: contribution.contributionId }
      : circleContext({
        circle, flow: CircleFlow.IN, approvalPolicy: CircleApprovalPolicy.CONTRIBUTION,
        contributionId: contribution.contributionId, operationId: contribution.operationId,
        proposer: this._memberParty(circle.circleId, contribution.contributorPrismId)
      });
    const scoped = audience === AUDIENCE_MEMBER ? context : this._restrictContext(context);
    return { ...operation, intent: { ...operation.intent, circle: scoped } };
  }

  /** A person as a payment party: the Circle's own record of them first, the identity second. */
  _memberParty(circleId, prismId) {
    if (!prismId) return null;
    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    const identity = this.identityService.get(prismId);
    const handle = member?.handle ?? (identity?.handle ? `@${identity.handle}` : null);
    return {
      prismId,
      displayName: member?.displayName ?? identity?.displayName ?? handle ?? 'Someone',
      handle,
      authorityAddress: member?.authorityAddress ?? identity?.accountAddress ?? null
    };
  }

  /** A verified approval, attributed to the person whose authority signed it. */
  _approverParty(circleId, approval) {
    const address = approval.authorityAddress ? getAddress(approval.authorityAddress) : null;
    const member = Object.values(this.store.read().circleMembers ?? {}).find((m) =>
      m.circleId === circleId && m.authorityAddress && address && getAddress(m.authorityAddress) === address);
    const party = member ? this._memberParty(circleId, member.prismId) : null;
    return {
      prismId: party?.prismId ?? approval.prismId ?? null,
      // An owner who is not a Prism member of this Circle is still a real signer. Say so plainly
      // rather than dropping the approval or inventing a name for it.
      displayName: party?.displayName ?? 'An admin',
      handle: party?.handle ?? null,
      authorityAddress: address,
      signatureType: approval.signatureType ?? null,
      status: 'verified'
    };
  }

  /**
   * Everything the Payment Proof surface needs for one Circle payment, assembled from live reads.
   *
   * What this returns is *evidence*, in the strict sense the rest of the codebase uses: the Safe's
   * own owner set and threshold, the token contract's balance, the Monad receipt, the USDC Transfer
   * inside it, and the module's allowance where one applies. The Safe Transaction Service appears
   * nowhere in it — that service coordinates signatures and is never execution evidence.
   */
  async evidenceFor(paymentId, prismId) {
    const kind = CircleService.kindOfPaymentId(paymentId);
    if (!kind) return null;

    if (kind === 'proposal') {
      const proposal = this._anyProposal(paymentId);
      if (proposal.kind !== ProposalKind.PAYMENT) throw notFound('payment not found');
      const circle = this._circle(proposal.circleId);
      const audience = this._audience(circle.circleId, prismId, proposal.recipientPrismId);
      if (audience === AUDIENCE_MEMBER) {
        await this.reconcilePayment({ circleId: circle.circleId, proposalId: paymentId, prismId }).catch(() => null);
      }
      const current = this._anyProposal(paymentId);
      const authority = await this._readAuthority(circle).catch(() => null);
      const { operation, view, context } = await this._projectProposal(circle, current, { authority, audience });
      const [receipt, balance] = await Promise.all([
        current.executionTxHash ? this.safe.getTransactionReceipt(current.executionTxHash).catch(() => null) : null,
        this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null)
      ]);
      return {
        policy: CircleApprovalPolicy.THRESHOLD,
        circle, operation, context, view, authority, receipt, balance,
        evidence: current.evidence ?? null,
        binding: this._paymentBinding(circle, current),
        calldataFields: this._proposalCalldataFields(current),
        recipientPrismId: current.recipientPrismId ?? null,
        proposerPrismId: current.proposerPrismId ?? null,
        balanceBefore: current.balanceBefore ?? null,
        balanceAfter: current.balanceAfter ?? null,
        allowance: null
      };
    }

    if (kind === 'spend') {
      const spend = this._anySpend(paymentId);
      const circle = this._circle(spend.circleId);
      const audience = this._audience(circle.circleId, prismId, spend.recipientPrismId);
      if (audience === AUDIENCE_MEMBER) {
        await this.reconcileSpend({ circleId: circle.circleId, spendId: paymentId, prismId }).catch(() => null);
      }
      const current = this._anySpend(paymentId);
      const authority = await this._readAuthority(circle).catch(() => null);
      const operation = this._projectSpend(circle, current, { audience });
      const [receipt, balance, allowance] = await Promise.all([
        current.transactionHash ? this.safe.getTransactionReceipt(current.transactionHash).catch(() => null) : null,
        this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null),
        this.safe.getSpendingLimit({ safeAddress: circle.safeAddress, delegate: current.delegate }).catch(() => null)
      ]);
      return {
        policy: CircleApprovalPolicy.SPENDING_LIMIT,
        circle, operation, context: operation.intent.circle, view: this._spendView(current),
        authority, receipt, balance,
        evidence: current.evidence ?? null,
        binding: { ok: true, reasons: [], boundFields: ['recipientAccount', 'amount', 'token', 'allowanceNonce', 'safeAddress', 'chainId'] },
        calldataFields: this._spendCalldataFields(current),
        recipientPrismId: current.recipientPrismId ?? null,
        proposerPrismId: current.spenderPrismId ?? null,
        balanceBefore: current.balanceBefore ?? null,
        balanceAfter: current.balanceAfter ?? null,
        allowance
      };
    }

    const contribution = this._contribution(paymentId);
    const circle = this._circle(contribution.circleId);
    const audience = this._audience(circle.circleId, prismId, contribution.contributorPrismId);
    if (audience === AUDIENCE_MEMBER) {
      await this.reconcileContribution({ circleId: circle.circleId, contributionId: paymentId, prismId }).catch(() => null);
    }
    const current = this._contribution(paymentId);
    const operation = this._projectContribution(circle, current, { audience });
    const balance = await this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null);
    return {
      policy: CircleApprovalPolicy.CONTRIBUTION,
      circle, operation, context: operation.intent.circle, view: this._contributionView(current, circle),
      authority: await this._readAuthority(circle).catch(() => null),
      // A contribution settles through the Prism router, so its chain evidence is the ordinary
      // payment operation's — the proof surface reads it from there rather than from a Safe receipt.
      receipt: null, balance,
      evidence: null,
      binding: { ok: true, reasons: [], boundFields: ['contributionId', 'circleId', 'safeAddress', 'contributorPrismId', 'amount'] },
      calldataFields: null,
      recipientPrismId: null,
      proposerPrismId: current.contributorPrismId,
      balanceBefore: current.balanceBefore ?? null,
      balanceAfter: current.balanceAfter ?? null,
      allowance: null,
      underlyingOperationId: current.operationId
    };
  }

  /** The exact argument values inside the Safe transaction, for the identifier-privacy detector. */
  _proposalCalldataFields(proposal) {
    const tx = proposal.safeTransaction ?? {};
    return [
      { name: 'safe', value: proposal.safeAddress },
      { name: 'to', value: tx.to },
      { name: 'value', value: tx.value },
      { name: 'data', value: tx.data },
      { name: 'operation', value: tx.operation },
      { name: 'nonce', value: tx.nonce },
      { name: 'safeTxHash', value: proposal.safeTxHash },
      { name: 'recipient', value: proposal.recipientAccount },
      { name: 'amount', value: proposal.amount }
    ];
  }

  _spendCalldataFields(spend) {
    return [
      { name: 'safe', value: spend.safeAddress },
      { name: 'module', value: spend.module },
      { name: 'token', value: spend.token },
      { name: 'recipient', value: spend.recipientAccount },
      { name: 'amount', value: spend.amount },
      { name: 'delegate', value: spend.delegate },
      { name: 'allowanceNonce', value: spend.allowanceNonce },
      { name: 'transferHash', value: spend.transferHash }
    ];
  }

  _anyProposal(proposalId) {
    const proposal = this.store.read().circleProposals?.[proposalId];
    if (!proposal) throw notFound('proposal not found');
    return proposal;
  }

  _anySpend(spendId) {
    const spend = this.store.read().circleSpends?.[spendId];
    if (!spend) throw notFound('spend not found');
    return spend;
  }

  /**
   * Cancel a Circle transaction that has not been broadcast.
   *
   * Needed for its own sake — a proposal nobody will approve should not sit in the approval inbox
   * forever — and needed for closing, because a Circle cannot be shut down while Prism still holds
   * decisions nobody resolved. Only pre-broadcast states are cancellable: once a transaction is
   * away, what happened to it is the chain's answer, not a button's.
   */
  async cancelProposal({ circleId, proposalId, actorPrismId }) {
    const circle = this._circle(circleId);
    const member = this._assertMember(circleId, actorPrismId);
    const proposal = this._proposal(circleId, proposalId);
    if (member.role !== MemberRole.ADMIN && proposal.proposerPrismId !== actorPrismId) {
      throw forbidden('only an admin or the person who proposed this can cancel it');
    }
    if (!CIRCLE_PAYMENT_PRE_BROADCAST.includes(proposal.lifecycle)) {
      throw conflict(`this is ${String(proposal.lifecycle).toLowerCase()} and can no longer be cancelled`);
    }
    this._setPaymentState(proposalId, CirclePaymentState.CANCELLED, { detail: { by: actorPrismId } });
    this.store.mutate((d) => { d.circleProposals[proposalId].status = ProposalStatus.REJECTED; });
    this._event(circleId, 'circle.proposal.cancelled', { proposalId, kind: proposal.kind, by: actorPrismId });
    // A cancelled owner-removal leaves that admin exactly where they were.
    if (proposal.kind === ProposalKind.OWNER_REMOVE && proposal.governance?.prismId) {
      const target = this.store.read().circleMembers?.[memberKey(circleId, proposal.governance.prismId)];
      if (target?.status === MemberStatus.PENDING_REMOVAL) {
        this._setMemberStatus({ circleId, prismId: proposal.governance.prismId, next: MemberStatus.ACTIVE, detail: { reason: 'the removal was cancelled' } });
      }
    }
    return proposal.kind === ProposalKind.PAYMENT
      ? this._paymentView(circle, this._proposal(circleId, proposalId), {})
      : this._governanceView(this._proposal(circleId, proposalId), {});
  }

  // ===========================================================================
  // Closing a Circle
  // ===========================================================================
  //
  // Closing is a lifecycle, not a delete. ACTIVE -> CLOSING -> CLOSED, and every Circle record,
  // payment, approval and receipt survives it: a shared account people put money through is exactly
  // the kind of history that must still be readable a year later.
  //
  // The one thing Prism will not do is decide where a remaining balance goes. There is no equal
  // split, no "return to contributors", no default. A Circle holding money cannot be closed at all —
  // it can only be emptied first, by the same threshold-approved payments it has always used, to
  // recipients its members choose. That refusal is the feature.

  /**
   * What stands between this Circle and being closed, checked against live state.
   *
   * Every blocker is a real read: open decisions from Prism's own records, spending delegates from
   * the module, the balance from the token contract, the owner set from the Safe. A read that fails
   * is itself a blocker — closing a Circle whose chain state could not be checked would record a
   * closure Prism cannot stand behind.
   */
  async closePreflight(circleId, prismId) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, prismId);
    if (circle.status === CircleStatus.CLOSED) {
      // Same shape as the open-circle preflight below — `requirements` included — so the client can
      // decode a finalize response (which returns this once the Circle is CLOSED) without failing.
      return {
        circleId, status: circle.status, canClose: false, alreadyClosed: true,
        requirements: CLOSE_REQUIREMENTS, blockers: [], checks: [], closing: circle.closing ?? null
      };
    }

    const blockers = [];
    const checks = [];

    // 1. No unresolved Prism decisions may outlive the Circle.
    const open = this._openProposals(circleId);
    checks.push({ code: 'OPEN_PROPOSALS', ok: open.length === 0, count: open.length, source: 'prism' });
    if (open.length) {
      blockers.push({
        code: 'OPEN_PROPOSALS',
        title: open.length === 1 ? '1 decision is still open' : `${open.length} decisions are still open`,
        detail: 'Approve or cancel everything waiting on the Circle before closing it.',
        proposals: open.map((p) => ({ proposalId: p.proposalId, kind: p.kind, memo: p.memo, lifecycle: p.lifecycle }))
      });
    }

    // 2. Nobody may still be able to spend from the Safe.
    const delegates = await this._liveSpendDelegates(circle);
    checks.push({ code: 'SPENDING_ACCESS', ok: delegates.ok && delegates.addresses.length === 0, source: 'module' });
    if (!delegates.ok) {
      blockers.push({
        code: 'SPENDING_ACCESS',
        title: 'Spending access could not be checked',
        detail: `Monad could not be read, so Prism cannot confirm that nobody can still spend from this Circle: ${delegates.reason}`
      });
    } else if (delegates.addresses.length) {
      blockers.push({
        code: 'SPENDING_ACCESS',
        title: delegates.addresses.length === 1 ? '1 member can still spend' : `${delegates.addresses.length} members can still spend`,
        detail: 'Revoke every spending limit on Monad first, or closing would leave the access behind.',
        members: delegates.addresses.map((a) => this._delegateMember(circleId, a))
      });
    }

    // 3. The balance. Prism will not choose where it goes.
    const balance = await this.safe.getUsdcBalance(circle.safeAddress).then((b) => b.toString()).catch(() => null);
    checks.push({ code: 'REMAINING_FUNDS', ok: balance === '0', balanceAtomic: balance, source: 'chain' });
    if (balance === null) {
      blockers.push({
        code: 'REMAINING_FUNDS',
        title: 'The balance could not be read',
        detail: 'Prism will not close a Circle without seeing that it is empty.'
      });
    } else if (BigInt(balance) > 0n) {
      blockers.push({
        code: 'REMAINING_FUNDS',
        title: `${formatUsdc(balance, this.config.chain.usdcDecimals)} is still in this Circle`,
        // Said plainly, because this is the one blocker a person has to make a decision about.
        detail: 'Decide together where this money goes and send it out of the Circle first. Prism will not split it or return it automatically — that is the Circle\'s decision, not ours.',
        balanceAtomic: balance,
        balanceDisplay: formatUsdc(balance, this.config.chain.usdcDecimals),
        requiresExplicitDecision: true
      });
    }

    // 4. The Safe's own state, read at close time rather than remembered.
    const authority = await this._readAuthority(circle).catch(() => null);
    checks.push({ code: 'CHAIN_RECONCILED', ok: Boolean(authority), source: 'chain' });
    if (!authority) {
      blockers.push({
        code: 'CHAIN_RECONCILED',
        title: 'The Circle could not be reconciled on Monad',
        detail: 'Closing records what the Safe actually held and who actually controlled it. Try again when Monad can be read.'
      });
    }

    return {
      circleId,
      status: circle.status,
      canClose: blockers.length === 0,
      requirements: CLOSE_REQUIREMENTS,
      checks,
      blockers,
      balance: balance === null ? unavailable('the token contract could not be read') : {
        amountAtomic: balance, display: formatUsdc(balance, this.config.chain.usdcDecimals),
        symbol: CIRCLE_ASSET, source: 'chain'
      },
      authority: authority ?? unavailable('the Safe could not be read'),
      closing: circle.closing ?? null,
      // Stated because people ask: closing ends the Circle's life in Prism, not its record.
      historyRetained: true
    };
  }

  /**
   * Begin closing. The Circle stays live on Monad and can still pay money out — that is how a
   * remaining balance leaves — but nothing new can come in, and nobody new can be invited.
   */
  async beginClose({ circleId, actorPrismId, reason = null }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);
    if (circle.status === CircleStatus.CLOSED) throw conflict('this Circle is already closed');
    if (circle.status === CircleStatus.CLOSING) return this.closePreflight(circleId, actorPrismId);
    if (circle.status !== CircleStatus.ACTIVE) throw conflict('only an active Circle can be closed');

    this.store.mutate((d) => {
      d.circles[circleId].closing = {
        startedAt: new Date().toISOString(),
        startedByPrismId: actorPrismId,
        reason: reason ? String(reason).trim().slice(0, 200) : null,
        finalizedAt: null,
        finalizedByPrismId: null,
        evidence: null
      };
    });
    this._clearClosePlan(circleId); // a fresh close never inherits a prior attempt's frozen targets
    this._transition(circleId, CircleStatus.CLOSING, { by: actorPrismId, reason: reason ?? null });
    this._event(circleId, 'circle.closing.started', { by: actorPrismId, reason: reason ?? null });
    logger.info('circle.closing.started', { circleId, by: actorPrismId });
    return this.closePreflight(circleId, actorPrismId);
  }

  /**
   * Change of mind. A closure that never finished leaves nothing behind but its own record.
   *
   * Reopening does not simply flip the status back: the Circle re-enters through RECONCILING and has
   * to be read off the chain again before it is ACTIVE, exactly as it did the first time. There is
   * one route to ACTIVE in this service and this is not an exception to it.
   */
  async cancelClose({ circleId, actorPrismId }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);
    if (circle.status !== CircleStatus.CLOSING) throw conflict('this Circle is not being closed');
    this.store.mutate((d) => {
      const record = d.circles[circleId];
      record.closing = { ...(record.closing ?? {}), cancelledAt: new Date().toISOString(), cancelledByPrismId: actorPrismId };
    });
    this._clearClosePlan(circleId); // reopening recomputes from scratch, and spending unlocks again
    this._transition(circleId, CircleStatus.RECONCILING, { by: actorPrismId, reason: 'closing cancelled' });
    this._event(circleId, 'circle.closing.cancelled', { by: actorPrismId });
    await this._reverifyActive(circleId);
    return this.getCircle(circleId, actorPrismId);
  }

  /**
   * Re-earn ACTIVE from a live read of the Safe.
   *
   * Used when a Circle comes back out of CLOSING. It re-checks the things that can never legitimately
   * change — the chain, the Safe address, the audited singleton and version — and then writes a fresh
   * activation receipt from what the chain says the owner set and threshold are *now*, because those
   * two can legitimately have moved through approved governance while Prism was closing the Circle.
   */
  async _reverifyActive(circleId) {
    const circle = this._circle(circleId);
    let state;
    try { state = await this.safe.getCircleState(circle.safeAddress); }
    catch (e) { throw conflict(`Monad could not be read, so this Circle cannot be reopened yet: ${e.message}`); }

    const mismatches = [];
    if (Number(state.chainId) !== Number(this.config.chain.chainId)) mismatches.push(`the Safe is on chain ${state.chainId}, not ${this.config.chain.chainId}`);
    if (getAddress(state.safeAddress) !== getAddress(circle.safeAddress)) mismatches.push('the Safe address does not match this Circle');
    if (getAddress(state.singleton) !== getAddress(this.config.circles.safeSingleton)) mismatches.push('the Safe singleton is not the audited deployment');
    if (String(state.version) !== EXPECTED_SAFE_VERSION) mismatches.push(`the Safe version is ${state.version}, expected ${EXPECTED_SAFE_VERSION}`);
    if (mismatches.length) return this._fail(circleId, mismatches.join('; '));

    const now = new Date().toISOString();
    this.store.mutate((d) => {
      const c = d.circles[circleId];
      c.threshold = Number(state.threshold);
      c.adminCount = state.owners.length;
      c.activation = {
        verifiedAt: now, chainId: Number(state.chainId), safeAddress: getAddress(state.safeAddress),
        singleton: getAddress(state.singleton), version: state.version,
        owners: state.owners.map((o) => getAddress(o)), threshold: Number(state.threshold)
      };
    });
    this._transition(circleId, CircleStatus.ACTIVE, { reason: 'reopened after a cancelled closure', threshold: Number(state.threshold) });
    this._reconcileMembersFromOwners(circleId, state.owners);
    return this.getCircleRecord(circleId);
  }

  /**
   * Close the Circle for good.
   *
   * Refuses unless every requirement holds against a live read, and refuses unless the person
   * closing it acknowledged the exact balance Prism just read — the same discipline creation uses
   * for the approvals policy. An acknowledgement that does not match what the chain says is not a
   * formality that can be waved through; it means the screen they agreed to is not this Circle.
   */
  async finalizeClose({ circleId, actorPrismId, acknowledgement = null }) {
    const circle = this._circle(circleId);
    this._assertAdmin(circleId, actorPrismId);
    if (circle.status === CircleStatus.CLOSED) return this.closePreflight(circleId, actorPrismId);
    if (circle.status !== CircleStatus.CLOSING) throw conflict('start closing this Circle before finalizing it');

    const preflight = await this.closePreflight(circleId, actorPrismId);
    if (!preflight.canClose) {
      const error = conflict(`this Circle cannot be closed yet: ${preflight.blockers.map((b) => b.title).join('; ')}`);
      error.blockers = preflight.blockers;
      throw error;
    }

    const balanceAtomic = preflight.balance?.amountAtomic ?? null;
    if (!acknowledgement || String(acknowledgement.balanceAtomic) !== String(balanceAtomic)) {
      throw badRequest('confirm the balance you were shown before closing this Circle; it no longer matches what Monad reports');
    }

    const authority = preflight.authority;
    const delegates = await this._liveSpendDelegates(circle);
    const evidence = {
      readAt: new Date().toISOString(),
      safeAddress: circle.safeAddress,
      chainId: circle.chainId,
      balanceAtomic,
      balanceSource: 'chain',
      owners: authority.owners ?? null,
      threshold: authority.threshold ?? null,
      safeNonce: authority.nonce ?? null,
      moduleEnabled: delegates.moduleEnabled,
      spendDelegates: delegates.addresses,
      openProposals: 0,
      // What actually emptied the Circle, taken from its own completed payments rather than from
      // anything the closer typed. An empty list is a truthful answer for a Circle that never held
      // anything.
      withdrawals: this._closingWithdrawals(circleId)
    };

    this.store.mutate((d) => {
      const record = d.circles[circleId];
      record.closing = {
        ...(record.closing ?? {}),
        finalizedAt: new Date().toISOString(),
        finalizedByPrismId: actorPrismId,
        evidence
      };
      record.closedAt = new Date().toISOString();
    });
    this._clearClosePlan(circleId); // the close is done; drop the frozen targets
    this._transition(circleId, CircleStatus.CLOSED, { by: actorPrismId, balanceAtomic });
    this._event(circleId, 'circle.closed', { by: actorPrismId, balanceAtomic, withdrawals: evidence.withdrawals.length });
    logger.info('circle.closed', { circleId, by: actorPrismId });

    return this.closePreflight(circleId, actorPrismId);
  }

  /** Decisions Prism still holds: pending, or broadcast and not yet settled. */
  _openProposals(circleId) {
    const terminal = [
      CirclePaymentState.COMPLETED, CirclePaymentState.FAILED, CirclePaymentState.EXPIRED,
      CirclePaymentState.CANCELLED, CirclePaymentState.INVALIDATED
    ];
    return Object.values(this.store.read().circleProposals ?? {})
      .filter((p) => p.circleId === circleId)
      .filter((p) => p.status !== ProposalStatus.EXECUTED && p.status !== ProposalStatus.REJECTED)
      .filter((p) => !terminal.includes(p.lifecycle));
  }

  /** Who can still spend from this Safe, read from the module. Fails closed, never assumes none. */
  async _liveSpendDelegates(circle) {
    const moduleAddress = this.config.circles.allowanceModule;
    if (!moduleAddress || !circle.safeAddress) return { ok: true, addresses: [], moduleEnabled: false };
    if (typeof this.safe.isModuleEnabled !== 'function' || typeof this.safe.getSpendDelegates !== 'function') {
      return { ok: true, addresses: [], moduleEnabled: null };
    }
    try {
      const enabled = await this.safe.isModuleEnabled(circle.safeAddress);
      if (!enabled) return { ok: true, addresses: [], moduleEnabled: false };
      const delegates = await this.safe.getSpendDelegates(circle.safeAddress);
      return { ok: true, addresses: delegates.map((d) => getAddress(d)), moduleEnabled: true };
    } catch (e) {
      return { ok: false, addresses: [], moduleEnabled: null, reason: e.message };
    }
  }

  _delegateMember(circleId, address) {
    const member = Object.values(this.store.read().circleMembers ?? {}).find((m) =>
      m.circleId === circleId && m.authorityAddress && getAddress(m.authorityAddress) === getAddress(address));
    return {
      authorityAddress: getAddress(address),
      prismId: member?.prismId ?? null,
      displayName: member?.displayName ?? null,
      handle: member?.handle ?? null
    };
  }

  /** The completed payments that took money out of this Circle, newest last. */
  _closingWithdrawals(circleId) {
    return Object.values(this.store.read().circleProposals ?? {})
      .filter((p) => p.circleId === circleId && p.kind === ProposalKind.PAYMENT && p.lifecycle === CirclePaymentState.COMPLETED)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((p) => ({
        proposalId: p.proposalId,
        amount: p.amount,
        recipientPrismId: p.recipientPrismId ?? null,
        recipientAccount: p.recipientAccount ?? null,
        transactionHash: p.executionTxHash ?? null,
        executedAt: p.executedAt ?? null
      }));
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
    if (!SPENDING_STATUSES.includes(circle.status)) return;
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
    if (circle.status === CircleStatus.CLOSED) throw conflict('this Circle is closed');
    // CLOSING is allowed on purpose: revoking spending access is a governance change, and it is one
    // of the things a Circle must do before it can close.
    if (!SPENDING_STATUSES.includes(circle.status)) throw conflict('this Circle is not active on-chain yet');
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
      // Present from the moment closing starts, so every surface can say where a Circle is in its
      // wind-down. `historyRetained` is not decoration: closing never deletes anything.
      closing: circle.closing
        ? {
          startedAt: circle.closing.startedAt ?? null,
          startedByPrismId: circle.closing.startedByPrismId ?? null,
          reason: circle.closing.reason ?? null,
          cancelledAt: circle.closing.cancelledAt ?? null,
          finalizedAt: circle.closing.finalizedAt ?? null,
          finalizedByPrismId: circle.closing.finalizedByPrismId ?? null,
          evidence: circle.closing.evidence ?? null
        }
        : null,
      historyRetained: true,
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

  /** ACTIVE membership only — same boundary `CircleMessageService` applies to proposal messages. */
  _activeMember(circleId, prismId) {
    const member = this.store.read().circleMembers?.[memberKey(circleId, prismId)];
    if (!member || member.status !== MemberStatus.ACTIVE) {
      throw forbidden('only active members of this Circle can do that');
    }
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
/** Atomic units to the dollars a person reads. Display only — never fed back into a calculation. */
function formatUsdc(atomic, decimals = 6) {
  const value = BigInt(atomic ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const cents = ((value % scale) * 100n) / scale;
  return `$${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
}

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
