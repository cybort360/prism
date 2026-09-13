/**
 * The canonical PRISM CIRCLE domain model.
 *
 * A Circle is a shared USDC account whose authority lives in a Safe Smart Account on Monad. This
 * module is deliberately pure: enums, factories, and the rules that must hold regardless of who is
 * asking. It performs no I/O and knows nothing about HTTP, so every invariant here is testable
 * without a chain, a store, or a server.
 *
 * The single most important idea in this file is CANONICAL_SOURCES. Prism holds *names*; the chain
 * holds *money and authority*. Anything the chain owns is read from the chain at the moment of
 * asking, never served from a backend row that merely remembers what the chain said once.
 */

// --- the asset ---------------------------------------------------------------
// V1 is USDC-only. This is a domain constraint, not a configuration knob: a Circle's proposals,
// contributions and balances are all denominated in one asset, and mixing them would make
// "the Circle's balance" ambiguous.
export const CIRCLE_ASSET = 'USDC';

// --- canonical source map ----------------------------------------------------
/**
 * Where the truth for each Circle fact lives. `prism` means Prism's own database is authoritative
 * (it is the only place that fact exists). `chain` means Monad is authoritative and Prism may only
 * mirror what it has *observed*. `resolver` means the Protected Alias Resolver.
 *
 * The backend must never fabricate a `chain` fact. In practice that means: no default, no cached
 * fallback, and no "optimistic" value. If the chain cannot be read, the answer is "unknown", which
 * is a truthful answer; a stale number presented as current is not.
 */
export const CANONICAL_SOURCES = Object.freeze({
  'circle.name': 'prism',
  'circle.icon': 'prism',
  'circle.balance': 'chain',              // USDC.balanceOf(safeAddress)
  'circle.owners': 'chain',               // Safe.getOwners()
  'circle.threshold': 'chain',            // Safe.getThreshold()
  'circle.adminAuthority': 'chain',       // membership of the Safe owner set
  'circle.executedPayment': 'chain',      // Safe execution + USDC Transfer log
  'circle.pendingProposal': 'coordinated',// Prism intent + Safe Transaction Service
  'circle.collectedApprovals': 'signature',// cryptographic signatures over safeTxHash
  'circle.memberAllowance': 'module',     // on-chain allowance module only, when enabled
  'circle.recipientIdentity': 'resolver', // Protected Alias Resolver
  'circle.activity': 'reconciled'         // Prism operations reconciled against on-chain evidence
});

/** Facts the backend is forbidden from inventing. Used by tests as an executable statement of the rule. */
export const NEVER_FABRICATED = Object.freeze([
  'balance', 'owner', 'threshold', 'allowance', 'successfulPayment'
]);

// --- Circle ------------------------------------------------------------------

/**
 * Circle status. The first eight values are the creation flow, in order; a Circle's status *is* its
 * position in that flow until it reaches ACTIVE. Keeping one status field (rather than a separate
 * "creation state") means there is no way to be ACTIVE and mid-creation at the same time.
 */
export const CircleStatus = Object.freeze({
  CREATED: 'CREATED',
  MEMBERS_SELECTED: 'MEMBERS_SELECTED',
  POLICY_REVIEWED: 'POLICY_REVIEWED',
  AWAITING_AUTHORIZATION: 'AWAITING_AUTHORIZATION',
  DEPLOYING: 'DEPLOYING',
  CONFIRMING: 'CONFIRMING',
  RECONCILING: 'RECONCILING',
  ACTIVE: 'ACTIVE',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  CLOSED: 'CLOSED'
});

/** The creation flow in order. ACTIVE is reachable only from RECONCILING, and only after verification. */
export const CREATION_FLOW = Object.freeze([
  CircleStatus.CREATED,
  CircleStatus.MEMBERS_SELECTED,
  CircleStatus.POLICY_REVIEWED,
  CircleStatus.AWAITING_AUTHORIZATION,
  CircleStatus.DEPLOYING,
  CircleStatus.CONFIRMING,
  CircleStatus.RECONCILING,
  CircleStatus.ACTIVE
]);

/**
 * Guarded status transitions. A Circle cannot skip verification: RECONCILING is the only state with
 * an edge to ACTIVE, and CircleService only takes that edge with a chain-verification receipt in
 * hand. DEPLOYING may fall back to AWAITING_AUTHORIZATION because a broadcast that never landed
 * leaves the Circle re-authorizable rather than stuck.
 */
export const ALLOWED_CIRCLE_TRANSITIONS = Object.freeze({
  CREATED: ['MEMBERS_SELECTED', 'VERIFICATION_FAILED'],
  MEMBERS_SELECTED: ['POLICY_REVIEWED', 'VERIFICATION_FAILED'],
  POLICY_REVIEWED: ['AWAITING_AUTHORIZATION', 'MEMBERS_SELECTED', 'VERIFICATION_FAILED'],
  AWAITING_AUTHORIZATION: ['DEPLOYING', 'POLICY_REVIEWED', 'VERIFICATION_FAILED'],
  DEPLOYING: ['CONFIRMING', 'AWAITING_AUTHORIZATION', 'VERIFICATION_FAILED'],
  CONFIRMING: ['RECONCILING', 'VERIFICATION_FAILED'],
  RECONCILING: ['ACTIVE', 'VERIFICATION_FAILED'],
  ACTIVE: ['CLOSED', 'VERIFICATION_FAILED'],   // drift found later must be able to un-trust a Circle
  VERIFICATION_FAILED: ['RECONCILING', 'CLOSED'],
  CLOSED: []
});

export function canCircleTransition(from, to) {
  if (from === to) return true;                       // idempotent re-entry is always safe
  return (ALLOWED_CIRCLE_TRANSITIONS[from] ?? []).includes(to);
}

export function assertCircleTransition(from, to) {
  if (!canCircleTransition(from, to)) {
    throw badRequest(`illegal circle transition: ${from} -> ${to}`);
  }
}

/**
 * A new Circle record. Note what is *absent*: `threshold` and `adminCount` start null and are
 * written only by chain verification, never from the creator's request. The value the creator asked
 * for lives under `creation.requestedThreshold`, clearly marked as an intent. That separation is
 * what makes "the backend never fabricates a threshold" a structural property rather than a promise.
 */
export function newCircle({ circleId, name, icon, chainId, createdByPrismId, template, requestedThreshold, requestedAdmins, saltNonce, predictedSafeAddress }) {
  const now = new Date().toISOString();
  return {
    circleId,
    name,
    icon: icon ?? null,
    safeAddress: predictedSafeAddress ?? null, // predicted until CONFIRMING proves it
    chainId: String(chainId),
    asset: CIRCLE_ASSET,
    status: CircleStatus.CREATED,
    threshold: null,                            // chain-owned; null until verified on-chain
    adminCount: null,                           // chain-owned; null until verified on-chain
    createdByPrismId,
    createdAt: now,
    activatedAt: null,
    closedAt: null,
    creation: {
      template,
      requestedThreshold,
      requestedAdmins,                          // [{ prismId, authorityAddress }] — resolved, never invented
      saltNonce,
      predictedSafeAddress: predictedSafeAddress ?? null,
      deploymentTxHash: null,
      policyAcknowledgedAt: null,
      authorizedAt: null,
      failureReason: null
    },
    // Written only by verifyDeployment(): the receipt of an actual chain read. Its presence is the
    // proof that ACTIVE was earned. A Circle marked ACTIVE without it is a forgery (see
    // CircleService.assertActivationIntegrity).
    activation: null,
    events: []
  };
}

// --- CircleMember ------------------------------------------------------------

export const MemberRole = Object.freeze({
  ADMIN: 'ADMIN',             // a Safe owner; can approve movements of money
  SPENDER: 'SPENDER',         // may propose spends; has NO unilateral authority while limits are off
  CONTRIBUTOR: 'CONTRIBUTOR', // may add money and propose
  VIEWER: 'VIEWER'            // may see the Circle; proposes nothing
});

export const MemberStatus = Object.freeze({
  INVITED: 'INVITED',
  PENDING_ACTIVATION: 'PENDING_ACTIVATION', // accepted in Prism; not yet confirmed by the chain
  ACTIVE: 'ACTIVE',
  PENDING_REMOVAL: 'PENDING_REMOVAL',
  LEFT: 'LEFT',
  REMOVED: 'REMOVED'
});

/** Roles whose authority is on-chain, and therefore cannot be granted by Prism alone. */
export const CHAIN_BACKED_ROLES = Object.freeze([MemberRole.ADMIN]);

/** Terminal member states. A member in one of these can never be revived by an old invitation. */
export const TERMINAL_MEMBER_STATUSES = Object.freeze([MemberStatus.LEFT, MemberStatus.REMOVED]);

export function newCircleMember({ circleId, prismId, authorityAddress, displayName, handle, role, status }) {
  assertRole(role);
  return {
    circleId,
    prismId,
    authorityAddress: authorityAddress ?? null,
    displayName: displayName ?? null,
    handle: handle ?? null,
    role,
    status,
    joinedAt: status === MemberStatus.ACTIVE ? new Date().toISOString() : null,
    removedAt: null
  };
}

export function assertRole(role) {
  if (!Object.values(MemberRole).includes(role)) throw badRequest(`unknown circle role: ${role}`);
  return role;
}

// --- CircleProposal ----------------------------------------------------------

export const ProposalKind = Object.freeze({
  PAYMENT: 'PAYMENT',
  OWNER_ADD: 'OWNER_ADD',
  OWNER_REMOVE: 'OWNER_REMOVE',
  THRESHOLD_CHANGE: 'THRESHOLD_CHANGE',
  // --- member spending limits (Allowance Module v1.0.0) ---
  // Each is a Safe transaction, which is the whole point: a member's limit is set by the Circle
  // agreeing, never by the member and never by Prism.
  MODULE_ENABLE: 'MODULE_ENABLE',
  SPEND_DELEGATE_ADD: 'SPEND_DELEGATE_ADD',
  SPEND_DELEGATE_REMOVE: 'SPEND_DELEGATE_REMOVE',
  SPEND_LIMIT_SET: 'SPEND_LIMIT_SET',
  SPEND_LIMIT_DELETE: 'SPEND_LIMIT_DELETE'
});

/** Proposal kinds that change who may spend, or how much. Grouped so the UI can label them as one. */
export const SPENDING_LIMIT_KINDS = Object.freeze([
  ProposalKind.MODULE_ENABLE, ProposalKind.SPEND_DELEGATE_ADD, ProposalKind.SPEND_DELEGATE_REMOVE,
  ProposalKind.SPEND_LIMIT_SET, ProposalKind.SPEND_LIMIT_DELETE
]);

export const ProposalStatus = Object.freeze({
  PENDING: 'PENDING',       // collecting approvals
  READY: 'READY',           // enough valid signatures to execute
  EXECUTING: 'EXECUTING',
  EXECUTED: 'EXECUTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED'
});

/**
 * A proposal is a *Safe transaction awaiting signatures*. `safeTxHash` is its identity: the Safe's
 * own EIP-712 digest, which binds the Circle's address, this chain, and the Safe's nonce. Two
 * proposals with the same fields but different nonces are different proposals, and a signature for
 * one can never be replayed onto the other.
 *
 * `collectedApprovals` is a mirror of signature evidence, never a counter the backend increments on
 * its own — see CANONICAL_SOURCES['circle.collectedApprovals'].
 */
export function newCircleProposal({
  proposalId, circleId, kind, proposerPrismId, recipientPrismId, recipientAccount,
  amount, asset, memo, safeTxHash, safeNonce, safeTransaction, requiredApprovals, expiresAt,
  safeAddress = null, chainId = null, token = null
}) {
  if (!Object.values(ProposalKind).includes(kind)) throw badRequest(`unknown proposal kind: ${kind}`);
  return {
    proposalId,
    circleId,
    kind,
    proposerPrismId,
    recipientPrismId: recipientPrismId ?? null,
    recipientAccount: recipientAccount ?? null,
    amount: amount ?? null,
    asset: asset ?? (amount ? CIRCLE_ASSET : null),
    memo: memo ?? null,
    // The five things a signature is *about*, recorded next to the digest rather than only inside
    // it. Re-deriving the digest from these is what turns "the fields were mutated" from an
    // invisible database edit into a detectable contradiction — see APPROVAL_BOUND_FIELDS.
    safeAddress: safeAddress ?? null,
    chainId: chainId === null ? null : String(chainId),
    token: token ?? null,
    safeTxHash: safeTxHash ?? null,
    safeNonce: safeNonce ?? null,
    safeTransaction: safeTransaction ?? null, // the exact 10 fields that were hashed
    requiredApprovals,
    collectedApprovals: 0,
    status: ProposalStatus.PENDING,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ?? null,
    executedAt: null,
    executionTxHash: null
  };
}

// --- the payment lifecycle ---------------------------------------------------

/**
 * The lifecycle of a threshold-governed Circle payment.
 *
 * Each state is a claim that has been established, in the same spirit as the creation flow:
 *
 *   CREATED           the request is well-formed and the proposer may spend from this Circle
 *   RESOLVING         the recipient is being resolved through the Protected Alias Resolver
 *   RESOLVED          a signed resolver attestation names a PrismIdentity and its account
 *   PROPOSED          the exact Safe transaction exists and its digest is cross-checked with the Safe
 *   APPROVAL_PENDING  fewer verified owner signatures than the Safe's LIVE threshold
 *   APPROVED          enough verified signatures from CURRENT owners over this exact digest
 *   SUBMITTED         `execTransaction` was simulated, then broadcast
 *   CONFIRMING        awaiting a receipt
 *   CONFIRMED         the receipt is a success and the Safe reports ExecutionSuccess for this digest
 *   RECONCILED        a USDC Transfer log proves Safe -> reviewed recipient, for the exact amount
 *   COMPLETED         terminal; the money moved and Prism has the evidence
 *
 * APPROVAL_PENDING and APPROVED are the only pair that moves in both directions, because approval
 * is not a stored fact: it is recomputed from signatures against the live owner set on every read,
 * so an admin removed on-chain drops an APPROVED payment back to APPROVAL_PENDING by itself.
 */
export const CirclePaymentState = Object.freeze({
  CREATED: 'CREATED',
  RESOLVING: 'RESOLVING',
  RESOLVED: 'RESOLVED',
  PROPOSED: 'PROPOSED',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVED: 'APPROVED',
  SUBMITTED: 'SUBMITTED',
  CONFIRMING: 'CONFIRMING',
  CONFIRMED: 'CONFIRMED',
  RECONCILED: 'RECONCILED',
  COMPLETED: 'COMPLETED',
  // --- off the happy path ---
  INVALIDATED: 'INVALIDATED', // a field the signatures cover no longer matches; approvals are void
  EXPIRED: 'EXPIRED',         // the Safe consumed this nonce elsewhere, or the proposal timed out
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED'            // broadcast, and the chain said no
});

/** The happy path in order. Used by tests and by the UI to render progress honestly. */
export const CIRCLE_PAYMENT_FLOW = Object.freeze([
  CirclePaymentState.CREATED,
  CirclePaymentState.RESOLVING,
  CirclePaymentState.RESOLVED,
  CirclePaymentState.PROPOSED,
  CirclePaymentState.APPROVAL_PENDING,
  CirclePaymentState.APPROVED,
  CirclePaymentState.SUBMITTED,
  CirclePaymentState.CONFIRMING,
  CirclePaymentState.CONFIRMED,
  CirclePaymentState.RECONCILED,
  CirclePaymentState.COMPLETED
]);

/**
 * Guarded transitions. Note what is absent: there is no edge from anywhere into COMPLETED except
 * RECONCILED, and no edge into RECONCILED except CONFIRMED. A backend that wants to call a payment
 * done must first hold a receipt AND a matching USDC Transfer log, because those are the only two
 * functions that take those edges.
 */
export const ALLOWED_CIRCLE_PAYMENT_TRANSITIONS = Object.freeze({
  CREATED: ['RESOLVING', 'CANCELLED', 'FAILED'],
  RESOLVING: ['RESOLVED', 'CANCELLED', 'FAILED'],
  RESOLVED: ['PROPOSED', 'CANCELLED', 'FAILED'],
  PROPOSED: ['APPROVAL_PENDING', 'INVALIDATED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  APPROVAL_PENDING: ['APPROVED', 'INVALIDATED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  // Back to APPROVAL_PENDING: approvals are re-counted from signatures, so losing an owner
  // un-approves a payment that has not yet been broadcast.
  APPROVED: ['SUBMITTED', 'APPROVAL_PENDING', 'INVALIDATED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  SUBMITTED: ['CONFIRMING', 'CONFIRMED', 'FAILED'],
  CONFIRMING: ['CONFIRMED', 'FAILED'],
  CONFIRMED: ['RECONCILED', 'FAILED'],
  RECONCILED: ['COMPLETED'],
  COMPLETED: [],
  INVALIDATED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: []
});

export function canCirclePaymentTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_CIRCLE_PAYMENT_TRANSITIONS[from] ?? []).includes(to);
}

export function assertCirclePaymentTransition(from, to) {
  if (!canCirclePaymentTransition(from, to)) {
    throw conflict(`illegal circle payment transition: ${from} -> ${to}`);
  }
}

/**
 * Everything an owner's signature is *about*. Changing any one of these produces a different Safe
 * digest, so every collected signature stops verifying — which is the whole security property.
 * Named here so `CircleService._assertPaymentBinding` and the tests describe the same list.
 */
export const APPROVAL_BOUND_FIELDS = Object.freeze([
  'recipientAccount', 'amount', 'token', 'safeNonce', 'safeAddress', 'chainId'
]);

/** States in which a payment has not yet been broadcast, so a rebuild is still possible. */
export const CIRCLE_PAYMENT_PRE_BROADCAST = Object.freeze([
  CirclePaymentState.CREATED, CirclePaymentState.RESOLVING, CirclePaymentState.RESOLVED,
  CirclePaymentState.PROPOSED, CirclePaymentState.APPROVAL_PENDING, CirclePaymentState.APPROVED
]);

// --- CircleApproval ----------------------------------------------------------

/**
 * How an owner's approval was expressed. Safe accepts all four; Circles records which one was used
 * because they have different trust properties — APPROVED_HASH is an on-chain pre-approval, while
 * CONTRACT_SIGNATURE delegates the check to an EIP-1271 owner contract.
 */
export const SignatureType = Object.freeze({
  ECDSA: 'ECDSA',                           // secp256k1 EIP-712 — the Mera account path
  ETH_SIGN: 'ETH_SIGN',
  CONTRACT_SIGNATURE: 'CONTRACT_SIGNATURE', // EIP-1271, e.g. a P-256 authority contract
  APPROVED_HASH: 'APPROVED_HASH'
});

export function newCircleApproval({ proposalId, prismId, authorityAddress, signatureType, signature }) {
  if (!Object.values(SignatureType).includes(signatureType)) throw badRequest(`unknown signature type: ${signatureType}`);
  return {
    proposalId,
    prismId,
    authorityAddress,
    signatureType,
    signature: signature ?? null,
    approvedAt: new Date().toISOString()
  };
}

// --- CircleContribution ------------------------------------------------------

export const ContributionStatus = Object.freeze({
  PREPARED: 'PREPARED',
  SUBMITTED: 'SUBMITTED',
  CONFIRMING: 'CONFIRMING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

/**
 * Money flowing *into* a Circle. A contribution is an ordinary Prism payment whose recipient is the
 * Circle's Safe, so it carries an `operationId` into the existing payment lifecycle rather than
 * inventing a second ledger. COMPLETED is only ever written from an on-chain receipt.
 */
export function newCircleContribution({ contributionId, circleId, contributorPrismId, amount, asset, operationId, safeAddress = null, balanceBefore = null }) {
  return {
    contributionId,
    circleId,
    contributorPrismId,
    amount,
    asset: asset ?? CIRCLE_ASSET,
    operationId,
    // The Safe the money was authorized to reach, pinned at prepare time. Reconciliation compares
    // the settled payment's recipient against this, so a Circle record edited afterwards cannot
    // make a payment to somewhere else look like a contribution to this Circle.
    safeAddress: safeAddress ?? null,
    // Read from the chain before the contribution is signed, so "the balance went up by exactly
    // this much" is checkable rather than asserted.
    balanceBefore: balanceBefore ?? null,
    balanceAfter: null,
    transactionHash: null,
    status: ContributionStatus.PREPARED,
    createdAt: new Date().toISOString(),
    completedAt: null
  };
}

/** Guarded contribution transitions. COMPLETED is reachable only from a confirmed on-chain receipt. */
export const ALLOWED_CONTRIBUTION_TRANSITIONS = Object.freeze({
  PREPARED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['CONFIRMING', 'COMPLETED', 'FAILED'],
  CONFIRMING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: []
});

export function assertContributionTransition(from, to) {
  if (from === to) return true;
  if (!(ALLOWED_CONTRIBUTION_TRANSITIONS[from] ?? []).includes(to)) {
    throw conflict(`illegal contribution transition: ${from} -> ${to}`);
  }
  return true;
}

// --- threshold rules ---------------------------------------------------------

/**
 * The arithmetic that must hold for any Safe owner set, at creation and at every later change.
 *
 * These are not stylistic preferences: Safe itself rejects a zero threshold and a threshold above
 * the owner count, so a proposal that violates them is guaranteed to revert. Catching it here turns
 * a wasted on-chain failure into a clear message, and — more importantly — stops Prism from showing
 * a user a proposal that could never have executed.
 */
export function assertThresholdWithinOwners({ threshold, ownerCount, context = 'threshold' }) {
  if (!Number.isInteger(threshold)) throw badRequest(`${context} must be a whole number`);
  if (threshold < 1) throw badRequest(`${context} must be at least 1; a Circle with no required approvals is not a shared account`);
  if (!Number.isInteger(ownerCount) || ownerCount < 1) throw badRequest('a Circle needs at least one admin');
  if (threshold > ownerCount) {
    throw badRequest(`${context} of ${threshold} exceeds the ${ownerCount} admin${ownerCount === 1 ? '' : 's'} that would remain; the Circle could never spend`);
  }
  return true;
}

/**
 * "spare" is how many admins a Circle can lose and still move money. It is the number the founder
 * decision in TODO.md is about, and the number the two-person warnings below are really describing.
 */
export function spareApprovals({ threshold, ownerCount }) {
  return ownerCount - threshold;
}

/**
 * The honest description of a given threshold. Prism states the trade-off and refuses to imply that
 * either end of it is universally safe: a low threshold means any one admin can move the money
 * alone, and a zero-spare threshold means one lost phone freezes the funds with no repair path.
 */
export function thresholdWarnings({ threshold, ownerCount }) {
  const warnings = [];
  if (threshold === 1 && ownerCount >= 2) {
    warnings.push({
      code: 'ANY_ADMIN_ALONE',
      title: `1 of ${ownerCount}`,
      detail: 'Either admin can move money alone.'
    });
  }
  if (spareApprovals({ threshold, ownerCount }) === 0 && ownerCount >= 2) {
    warnings.push({
      code: 'NO_SPARE_AUTHORITY',
      title: `${threshold} of ${ownerCount}`,
      detail: 'Both admins are required. Losing access to either authority can block spending.'
    });
  }
  return warnings;
}

// --- errors ------------------------------------------------------------------

export function badRequest(message) { const e = new Error(message); e.statusCode = 400; return e; }
export function forbidden(message) { const e = new Error(message); e.statusCode = 403; return e; }
export function notFound(message) { const e = new Error(message); e.statusCode = 404; return e; }
export function conflict(message) { const e = new Error(message); e.statusCode = 409; return e; }
