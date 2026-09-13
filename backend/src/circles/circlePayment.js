/**
 * Circle context for the canonical Prism payment model.
 *
 * The rule this module exists to hold: **a Circle does not get its own money object.** Paying from a
 * shared account is still one `PrismPayment` — same canonical projection, same receipt, same proof
 * surface — it simply carries an extra block saying which Circle the money came from and what
 * authority released it. There is no second ledger, no Circle-only transaction history, and no
 * Circle-only receipt type.
 *
 * So this file is a *projection*, not a store. It turns the records Circles already keeps (a Safe
 * proposal, an allowance spend, a contribution) into the operation shape `lib/lifecycle.js` already
 * knows how to project, and attaches the Circle context under `intent.circle`. Everything it reports
 * is either a Prism-owned fact (who proposed, what it was for) or evidence written by a chain read
 * (approvals, execution, transfer) — it invents nothing, and a field it cannot substantiate is null.
 */
import { CirclePaymentState } from './model.js';

/** Where the money came from. Absent context means an ordinary personal payment. */
export const PaymentSourceType = Object.freeze({ PERSONAL: 'personal', CIRCLE: 'circle' });

/** What released the money. Each is a different authority, and they are never blurred together. */
export const CircleApprovalPolicy = Object.freeze({
  /** n-of-m admin signatures over the Safe transaction digest. */
  THRESHOLD: 'THRESHOLD',
  /** One member acting alone, inside an allowance the Circle approved on-chain. */
  SPENDING_LIMIT: 'SPENDING_LIMIT',
  /** Money *into* the Circle: the contributor's own account, their own signature. */
  CONTRIBUTION: 'CONTRIBUTION'
});

/** How the authority reads to a person, for the proof surface. */
export const CircleAuthorityLabel = Object.freeze({
  [CircleApprovalPolicy.THRESHOLD]: 'Shared',
  [CircleApprovalPolicy.SPENDING_LIMIT]: 'Delegated',
  [CircleApprovalPolicy.CONTRIBUTION]: 'Personal'
});

/** Which way the money moved relative to the Circle. */
export const CircleFlow = Object.freeze({ IN: 'in', OUT: 'out' });

/**
 * Circle payment ids are prefixed at creation, so any surface can tell what a payment id addresses
 * without a lookup — which is what lets ONE canonical endpoint serve personal and Circle payments
 * alike instead of the app having to know which kind of thing it is holding.
 */
export const CIRCLE_ID_PREFIXES = Object.freeze({ prp_: 'proposal', spd_: 'spend', ctb_: 'contribution' });

export function circlePaymentKindOfId(paymentId) {
  const id = String(paymentId ?? '');
  for (const [prefix, kind] of Object.entries(CIRCLE_ID_PREFIXES)) if (id.startsWith(prefix)) return kind;
  return null;
}

export function isCirclePaymentId(paymentId) { return circlePaymentKindOfId(paymentId) !== null; }

/**
 * The Circle payment lifecycle mapped onto the coarse persisted payment state the canonical
 * projection speaks. The mapping is deliberately conservative at the end: CONFIRMED and RECONCILED
 * are *not* `completed`, because the canonical model reserves completion for money that both settled
 * and reconciled, which is exactly what COMPLETED means for a Circle too.
 */
const OP_STATE_BY_CIRCLE_STATE = Object.freeze({
  [CirclePaymentState.CREATED]: 'prepared',
  [CirclePaymentState.RESOLVING]: 'prepared',
  [CirclePaymentState.RESOLVED]: 'prepared',
  [CirclePaymentState.PROPOSED]: 'prepared',
  [CirclePaymentState.APPROVAL_PENDING]: 'prepared',
  [CirclePaymentState.APPROVED]: 'prepared',
  [CirclePaymentState.SUBMITTED]: 'submitted',
  [CirclePaymentState.CONFIRMING]: 'confirming',
  [CirclePaymentState.CONFIRMED]: 'confirming',
  [CirclePaymentState.RECONCILED]: 'confirming',
  [CirclePaymentState.COMPLETED]: 'completed',
  [CirclePaymentState.INVALIDATED]: 'requires_attention',
  [CirclePaymentState.EXPIRED]: 'expired',
  [CirclePaymentState.CANCELLED]: 'prepared',
  [CirclePaymentState.FAILED]: 'failed'
});

/** Off-path states carry a failure code from the shared taxonomy, so the UI uses one vocabulary. */
const FAILURE_BY_CIRCLE_STATE = Object.freeze({
  [CirclePaymentState.INVALIDATED]: 'CIRCLE_APPROVAL_INVALIDATED',
  [CirclePaymentState.EXPIRED]: 'CIRCLE_NONCE_CONSUMED',
  [CirclePaymentState.CANCELLED]: 'AUTHORIZATION_CANCELLED',
  [CirclePaymentState.FAILED]: 'CIRCLE_EXECUTION_FAILED'
});

/** The canonical lifecycle-event vocabulary each Circle state belongs to, for the event log. */
const EVENT_STATE_BY_CIRCLE_STATE = Object.freeze({
  [CirclePaymentState.CREATED]: 'created',
  [CirclePaymentState.RESOLVING]: 'resolving',
  [CirclePaymentState.RESOLVED]: 'resolved',
  [CirclePaymentState.PROPOSED]: 'awaitingAuthorization',
  [CirclePaymentState.APPROVAL_PENDING]: 'awaitingAuthorization',
  [CirclePaymentState.APPROVED]: 'authorized',
  [CirclePaymentState.SUBMITTED]: 'submitted',
  [CirclePaymentState.CONFIRMING]: 'confirming',
  [CirclePaymentState.CONFIRMED]: 'confirmed',
  [CirclePaymentState.RECONCILED]: 'reconciled',
  [CirclePaymentState.COMPLETED]: 'completed',
  [CirclePaymentState.INVALIDATED]: 'requiresAttention',
  [CirclePaymentState.EXPIRED]: 'expired',
  [CirclePaymentState.CANCELLED]: 'cancelled',
  [CirclePaymentState.FAILED]: 'failedTerminal'
});

/** What each step of a Circle payment is, in the words a person would use. */
const EVENT_TITLE_BY_CIRCLE_STATE = Object.freeze({
  [CirclePaymentState.CREATED]: 'Payment created',
  [CirclePaymentState.RESOLVING]: 'Finding the recipient',
  [CirclePaymentState.RESOLVED]: 'Recipient confirmed',
  [CirclePaymentState.PROPOSED]: 'Sent to the Circle for approval',
  [CirclePaymentState.APPROVAL_PENDING]: 'Collecting approvals',
  [CirclePaymentState.APPROVED]: 'Approved by the Circle',
  [CirclePaymentState.SUBMITTED]: 'Submitted to Monad',
  [CirclePaymentState.CONFIRMING]: 'Confirming on Monad',
  [CirclePaymentState.CONFIRMED]: 'Confirmed on Monad',
  [CirclePaymentState.RECONCILED]: 'Transfer verified on-chain',
  [CirclePaymentState.COMPLETED]: 'Completed',
  [CirclePaymentState.INVALIDATED]: 'Approvals no longer valid',
  [CirclePaymentState.EXPIRED]: 'Expired',
  [CirclePaymentState.CANCELLED]: 'Cancelled',
  [CirclePaymentState.FAILED]: 'Failed'
});

/** Who observed each step. A chain-observed step must never be attributed to Prism. */
const EVENT_SOURCE_BY_CIRCLE_STATE = Object.freeze({
  [CirclePaymentState.CREATED]: 'app',
  [CirclePaymentState.RESOLVING]: 'resolver',
  [CirclePaymentState.RESOLVED]: 'resolver',
  [CirclePaymentState.PROPOSED]: 'backend',
  [CirclePaymentState.APPROVAL_PENDING]: 'userAuthorization',
  [CirclePaymentState.APPROVED]: 'userAuthorization',
  [CirclePaymentState.SUBMITTED]: 'relayer',
  [CirclePaymentState.CONFIRMING]: 'monad',
  [CirclePaymentState.CONFIRMED]: 'monad',
  [CirclePaymentState.RECONCILED]: 'monad',
  [CirclePaymentState.COMPLETED]: 'backend',
  [CirclePaymentState.INVALIDATED]: 'backend',
  [CirclePaymentState.EXPIRED]: 'monad',
  [CirclePaymentState.CANCELLED]: 'app',
  [CirclePaymentState.FAILED]: 'monad'
});

export function opStateForCircleState(state) { return OP_STATE_BY_CIRCLE_STATE[state] ?? 'requires_attention'; }
export function failureCodeForCircleState(state) { return FAILURE_BY_CIRCLE_STATE[state] ?? null; }

/** "2 approvals" / "1 approval" — the rule as a receipt states it. */
export function approvalRule(requiredApprovals) {
  if (requiredApprovals == null) return null;
  const n = Number(requiredApprovals);
  return `${n} approval${n === 1 ? '' : 's'}`;
}

/** "2 of 3 admins" — the rule as the proof surface states it, against the live owner set. */
export function approvalPolicyLabel({ requiredApprovals, adminCount }) {
  if (requiredApprovals == null) return null;
  if (adminCount == null) return `${requiredApprovals} of ?`;
  return `${requiredApprovals} of ${adminCount} admin${Number(adminCount) === 1 ? '' : 's'}`;
}

/**
 * The Circle block that rides on a canonical payment.
 *
 * Every field is optional at the type level and null when unknown, because this block is consumed by
 * surfaces that must never imply a fact they were not given — an unreadable owner set produces a
 * null policy, not a plausible one.
 */
export function circleContext({
  circle, flow, approvalPolicy, proposalId = null, safeTxHash = null, safeNonce = null,
  requiredApprovals = null, adminCount = null, approvers = [], proposer = null,
  spendingLimitReference = null, state = null, contributionId = null, operationId = null
}) {
  return {
    sourceType: PaymentSourceType.CIRCLE,
    circleId: circle.circleId,
    circleName: circle.name,
    circleIcon: circle.icon ?? null,
    circleSafeAddress: circle.safeAddress ?? null,
    chainId: circle.chainId ?? null,
    flow,
    // The Circle lifecycle state in full, alongside (never instead of) the canonical lifecycleState.
    state,
    approvalPolicy,
    authority: CircleAuthorityLabel[approvalPolicy] ?? null,
    approvalRule: approvalPolicy === CircleApprovalPolicy.THRESHOLD ? approvalRule(requiredApprovals) : null,
    policy: approvalPolicy === CircleApprovalPolicy.THRESHOLD
      ? approvalPolicyLabel({ requiredApprovals, adminCount })
      : (spendingLimitReference?.summary ?? null),
    requiredApprovals: requiredApprovals == null ? null : Number(requiredApprovals),
    // Only signatures that verified against the digest AND a current owner reach this list.
    approvers,
    proposer,
    proposalId,
    contributionId,
    operationId,
    safeTxHash,
    safeNonce: safeNonce == null ? null : String(safeNonce),
    spendingLimitReference
  };
}

/**
 * A Circle threshold payment as an operation record.
 *
 * The proposal is the stored thing; this is its projection into the shape every canonical Prism
 * payment has. `lifecycle` is the payment view's *effective* state (approvals are re-counted from
 * signatures on every read), so a payment that lost an admin projects as pending here too.
 */
export function proposalAsOperation({ circle, proposal, view, context }) {
  const state = view?.lifecycle ?? proposal.lifecycle;
  const evidence = proposal.evidence ?? null;
  return {
    operationId: proposal.proposalId,
    kind: 'circle-payment',
    state: opStateForCircleState(state),
    failureCode: failureCodeForCircleState(state),
    failureMessage: proposal.failureReason ?? null,
    intent: {
      kind: 'circle-payment',
      senderPrismId: null,                       // the payer is the Circle, not a person
      recipientPrismId: proposal.recipientPrismId ?? null,
      amountAtomic: proposal.amount ?? null,
      token: proposal.token ?? null,
      tokenSymbol: proposal.asset ?? 'USDC',
      memo: proposal.memo ?? null,
      entryMethod: 'circle',
      aliasVersion: proposal.payment?.aliasVersion ?? null,
      resolutionRequestId: proposal.payment?.resolutionRequestId ?? null,
      circle: context
    },
    events: circleEvents(proposal),
    createdAt: proposal.createdAt ?? null,
    submittedAt: traceTime(proposal, CirclePaymentState.SUBMITTED),
    broadcastAt: traceTime(proposal, CirclePaymentState.SUBMITTED),
    completedAt: state === CirclePaymentState.COMPLETED ? (proposal.executedAt ?? traceTime(proposal, CirclePaymentState.COMPLETED)) : null,
    transactionHash: proposal.executionTxHash ?? null,
    blockNumber: evidence?.blockNumber ?? null,
    indexed: false,
    indexedAt: null
  };
}

/** A within-limit spend as an operation record. Same money object, a different authority. */
export function spendAsOperation({ circle, spend, context }) {
  const state = spendCircleState(spend);
  return {
    operationId: spend.spendId,
    kind: 'circle-spend',
    state: opStateForCircleState(state),
    failureCode: failureCodeForCircleState(state),
    failureMessage: spend.failureReason ?? null,
    intent: {
      kind: 'circle-spend',
      senderPrismId: null,
      recipientPrismId: spend.recipientPrismId ?? null,
      amountAtomic: spend.amount ?? null,
      token: spend.token ?? null,
      tokenSymbol: spend.asset ?? 'USDC',
      memo: spend.memo ?? null,
      entryMethod: 'circle',
      aliasVersion: spend.aliasVersion ?? null,
      resolutionRequestId: spend.resolutionRequestId ?? null,
      circle: context
    },
    events: spendEvents(spend),
    createdAt: spend.createdAt ?? null,
    submittedAt: spend.submittedAt ?? null,
    broadcastAt: spend.submittedAt ?? null,
    completedAt: spend.completedAt ?? null,
    transactionHash: spend.transactionHash ?? null,
    blockNumber: spend.evidence?.blockNumber ?? null,
    indexed: false,
    indexedAt: null
  };
}

/** A spend's status vocabulary is its own; map it onto the shared Circle payment lifecycle. */
export function spendCircleState(spend) {
  switch (spend.status) {
    case 'PREPARED': return CirclePaymentState.APPROVED;   // authorized by a limit, not by a vote
    case 'SUBMITTED': return CirclePaymentState.SUBMITTED;
    case 'CONFIRMING': return CirclePaymentState.CONFIRMING;
    case 'COMPLETED': return CirclePaymentState.COMPLETED;
    case 'FAILED': return CirclePaymentState.FAILED;
    default: return CirclePaymentState.CREATED;
  }
}

/** Ordered lifecycle events from a proposal's recorded trace. Real timestamps only; no synthesis. */
function circleEvents(proposal) {
  return (proposal.trace ?? []).map((entry, index) => ({
    id: `${proposal.proposalId}:${index}`,
    paymentId: proposal.proposalId,
    state: EVENT_STATE_BY_CIRCLE_STATE[entry.state] ?? 'requiresAttention',
    circleState: entry.state,
    source: EVENT_SOURCE_BY_CIRCLE_STATE[entry.state] ?? 'backend',
    occurredAt: entry.at,
    displayTitle: EVENT_TITLE_BY_CIRCLE_STATE[entry.state] ?? entry.state,
    displayDetail: eventDetail(entry),
    evidenceReference: entry.detail?.txHash ?? proposal.executionTxHash ?? null
  }));
}

/** A spend keeps timestamps rather than a trace, so its history is built from the times it recorded. */
function spendEvents(spend) {
  const out = [];
  const push = (state, at) => {
    if (!at) return;
    out.push({
      id: `${spend.spendId}:${state}`,
      paymentId: spend.spendId,
      state: EVENT_STATE_BY_CIRCLE_STATE[state] ?? 'requiresAttention',
      circleState: state,
      source: EVENT_SOURCE_BY_CIRCLE_STATE[state] ?? 'backend',
      occurredAt: at,
      displayTitle: EVENT_TITLE_BY_CIRCLE_STATE[state] ?? state,
      displayDetail: null,
      evidenceReference: spend.transactionHash ?? null
    });
  };
  push(CirclePaymentState.CREATED, spend.createdAt);
  push(CirclePaymentState.APPROVED, spend.createdAt);
  push(CirclePaymentState.SUBMITTED, spend.submittedAt);
  push(CirclePaymentState.COMPLETED, spend.completedAt);
  if (spend.status === 'FAILED') push(CirclePaymentState.FAILED, spend.completedAt ?? spend.submittedAt ?? spend.createdAt);
  return out;
}

function eventDetail(entry) {
  const d = entry.detail ?? {};
  if (d.reason) return d.reason;
  if (d.collected != null && d.required != null) return `${d.collected} of ${d.required} approvals`;
  if (d.collected != null && d.threshold != null) return `${d.collected} of ${d.threshold} approvals`;
  if (d.transfer) return `USDC Transfer verified`;
  return null;
}

function traceTime(proposal, state) {
  return (proposal.trace ?? []).find((e) => e.state === state)?.at ?? null;
}
