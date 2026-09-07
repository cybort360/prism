/**
 * Canonical payment vocabulary shared by every monetary action. One operation record is the single
 * PrismPayment; its ordered `events[]` is the lifecycle history (never derived from one mutable
 * status field); `canonicalPayment` / `receiptFor` project it for the client. The chain stays the
 * source of truth for money — these are representations, not a ledger.
 */
import crypto from 'node:crypto';

// --- lifecycle events (append-only, ordered) --------------------------------

/** Append a lifecycle event to an operation record (call inside a store.mutate). */
export function appendEvent(record, { state, source, title, detail = null, evidence = null }) {
  record.events ??= [];
  // Idempotent per (state,source): a reconcile poll re-run must not duplicate the same transition.
  if (record.events.some((e) => e.state === state && e.source === source)) return;
  record.events.push({
    id: crypto.randomUUID(),
    paymentId: record.operationId,
    state,
    source,
    occurredAt: new Date().toISOString(),
    displayTitle: title,
    displayDetail: detail,
    evidenceReference: evidence
  });
}

// Backend legacy records may predate events[]; synthesize an ordered history from their timestamps so
// nothing is lost after a relaunch/migration.
export function ensureEvents(record) {
  if (Array.isArray(record.events) && record.events.length) return record.events;
  const ev = [];
  const push = (state, source, title, at) => { if (at) ev.push({ id: crypto.randomUUID(), paymentId: record.operationId, state, source, occurredAt: at, displayTitle: title, displayDetail: null, evidenceReference: record.txHash ?? null }); };
  push('created', 'app', 'Payment created', record.createdAt);
  if (record.broadcastAt) push('submitted', 'relayer', 'Submitted to the network', record.broadcastAt);
  if (record.txHash && record.state !== 'prepared') push('confirming', 'monad', 'Confirming on Monad', record.createdAt);
  if (record.state === 'completed') push('completed', 'backend', 'Completed', record.completedAt ?? record.createdAt);
  if (record.state === 'failed') push('failedTerminal', 'monad', 'Failed', record.completedAt ?? record.createdAt);
  if (record.indexed) push('indexed', 'envio', 'Indexed by Envio', record.indexedAt);
  return ev;
}

// --- canonical projection ---------------------------------------------------

const LIFECYCLE_BY_STATE = {
  prepared: 'created',
  broadcasting: 'submitted',
  submitted: 'submitted',
  confirming: 'confirming',
  completed: 'completed',
  failed: 'failedTerminal',
  requires_attention: 'requiresAttention',
  reconciliation_required: 'requiresAttention',
  expired: 'expired'
};

// --- guarded transitions ----------------------------------------------------
// The coarse persisted op.state machine. The rich lifecycle lives in events[]; this graph guards the
// stored state so "submitted" can never jump to "completed" without a confirmation, a refunded claim
// can never become "claimed", a completed op is immutable, etc. Only real observed transitions.
export const ALLOWED_TRANSITIONS = {
  prepared: ['broadcasting', 'failed', 'expired'],
  broadcasting: ['submitted', 'prepared', 'confirming', 'requires_attention', 'failed'],
  submitted: ['confirming', 'completed', 'failed', 'reconciliation_required'],
  confirming: ['completed', 'failed', 'reconciliation_required'],
  requires_attention: ['confirming', 'prepared', 'completed', 'failed'],
  reconciliation_required: ['completed', 'failed', 'requires_attention'],
  completed: [],                    // terminal — indexing is a flag/event, not a state change
  failed: [],
  expired: ['refunding', 'expired'],
  refunding: ['completed', 'failed']
};

export function canTransition(from, to) {
  if (from === to) return true;     // idempotent re-reads never mutate, always safe
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const e = new Error(`illegal payment transition: ${from} -> ${to}`);
    e.statusCode = 409;
    throw e;
  }
}

// --- failure taxonomy -------------------------------------------------------
// Every failure code maps to a coarse persisted state + a consumer-facing canonical state. Some
// "failures" (indexing delay, RPC blip) are NOT terminal and must not read as failed.
export const FAILURE_TAXONOMY = {
  RESOLUTION_FAILED: { state: 'failed', canonical: 'failedRetryable', retryable: true },
  IDENTITY_CHANGED: { state: 'failed', canonical: 'identityChanged', retryable: false },
  AUTHORIZATION_CANCELLED: { state: 'prepared', canonical: 'cancelled', retryable: true },
  AUTHORIZATION_FAILED: { state: 'prepared', canonical: 'failedRetryable', retryable: true },
  INSUFFICIENT_USDC: { state: 'failed', canonical: 'failedRetryable', retryable: true },
  SIGNATURE_EXPIRED: { state: 'failed', canonical: 'expired', retryable: true },
  RELAY_UNAVAILABLE: { state: 'prepared', canonical: 'failedRetryable', retryable: true },
  SUBMISSION_FAILED: { state: 'prepared', canonical: 'failedRetryable', retryable: true },
  SUBMISSION_AMBIGUOUS: { state: 'requires_attention', canonical: 'requiresAttention', retryable: false },
  TRANSACTION_REVERTED: { state: 'failed', canonical: 'reverted', retryable: false },
  RPC_UNAVAILABLE: { state: 'confirming', canonical: 'confirming', retryable: false },
  PROVIDER_DISAGREEMENT: { state: 'reconciliation_required', canonical: 'requiresAttention', retryable: false },
  INDEXING_DELAYED: { state: 'completed', canonical: 'completed', retryable: false },
  RECONCILIATION_REQUIRED: { state: 'reconciliation_required', canonical: 'requiresAttention', retryable: false },
  CLAIM_VERIFICATION_FAILED: { state: 'failed', canonical: 'failedTerminal', retryable: false },
  CLAIM_EXPIRED: { state: 'expired', canonical: 'expired', retryable: false }
};
export function failureCanonical(code) { return FAILURE_TAXONOMY[code]?.canonical ?? 'failedTerminal'; }
export function isRetryable(code) { return FAILURE_TAXONOMY[code]?.retryable ?? false; }

export function lifecycleState(op) {
  // Consumer completion = money settled on-chain + effects reconciled (backend 'completed').
  // Envio indexing is a later, non-blocking projection surfaced by the separate `indexed` flag/event
  // — it never downgrades a delivered payment.
  if ((op.state === 'failed' || op.state === 'requires_attention' || op.state === 'reconciliation_required') && op.failureCode) {
    return failureCanonical(op.failureCode);
  }
  return LIFECYCLE_BY_STATE[op.state] ?? 'requiresAttention';
}

export function paymentKind(op) {
  switch (op.kind) {
    case 'claim-funding': return 'claimFunding';
    case 'claim-collection': return 'claimSettlement';
    case 'claim-refund': return 'refund';
    default: break;
  }
  const i = op.intent ?? {};
  if (i.requestId) return 'requestPayment';
  if (i.entryMethod === 'qr') return 'qrPayment';
  if (i.entryMethod === 'paymentLink') return 'linkPayment';
  return 'direct';
}

export function entryMethod(op) {
  if (op.kind && op.kind.startsWith('claim-')) return 'claim';
  const i = op.intent ?? {};
  if (i.requestId) return 'request';
  if (i.entryMethod) return i.entryMethod;                 // client hint: qr | paymentLink | contact
  if (i.route === 'phone') return 'phone';
  if (i.route === 'handle') return 'handle';
  return 'contact';
}

function direction(op, viewerPrismId) {
  const i = op.intent ?? {};
  if (op.kind === 'claim-collection') return 'received';
  if (op.kind === 'claim-funding' || op.kind === 'claim-refund') return 'sent';
  if (viewerPrismId && i.recipientPrismId === viewerPrismId) return 'received';
  return 'sent';
}

function party(identity) {
  if (!identity) return { prismIdentityId: null, displayName: 'Someone', handle: null, accountAddress: null };
  return {
    prismIdentityId: identity.prismId ?? null,
    displayName: identity.displayName || (identity.handle ? `@${identity.handle}` : 'Someone'),
    handle: identity.handle ? `@${identity.handle}` : null,
    accountAddress: identity.account ?? identity.accountAddress ?? null
  };
}

/** The canonical PrismPayment projection for a viewer. `identityService` resolves the counterparties. */
export function canonicalPayment(op, { viewerPrismId = null, identityService, claim = null } = {}) {
  const i = op.intent ?? {};
  const get = (id) => (id && identityService ? identityService.get(id) : null);
  const senderId = i.senderPrismId ?? claim?.senderPrismId ?? null;
  const recipientId = i.recipientPrismId ?? null;
  return {
    paymentId: op.operationId,
    operationId: op.operationId,
    kind: paymentKind(op),
    direction: direction(op, viewerPrismId),
    entryMethod: entryMethod(op),
    sender: party(get(senderId)),
    recipient: party(get(recipientId)),
    amountAtomic: i.amountAtomic ?? claim?.amountAtomic ?? null,
    asset: i.tokenSymbol ?? claim?.tokenSymbol ?? 'USDC',
    memo: i.memo ?? null,
    requestId: i.requestId ?? null,
    claimId: i.claimId ?? claim?.claimId ?? null,
    resolutionId: i.resolutionRequestId ?? null,
    resolutionVersion: i.aliasVersion ?? null,
    lifecycleState: lifecycleState(op),
    createdAt: op.createdAt ?? null,
    authorizedAt: op.broadcastAt ?? null,
    submittedAt: op.submittedAt ?? (op.broadcastAt ?? null),
    confirmedAt: op.completedAt ?? null,
    indexedAt: op.indexedAt ?? null,
    reconciledAt: op.completedAt ?? null,
    completedAt: op.state === 'completed' ? (op.completedAt ?? null) : null,
    transactionHash: op.transactionHash ?? op.txHash ?? null,
    blockNumber: op.blockNumber ?? null,
    gasSponsored: true, // Prism relayer pays MON; users hold MON = 0.
    // Surface the failure/attention code (not just terminal failures) so the UI can show the right
    // recovery language. Retryable is derived from the taxonomy.
    failureCode: op.failureCode ?? (op.state === 'failed' ? 'TRANSACTION_REVERTED' : null),
    failureMessage: op.failureMessage ?? null,
    retryable: op.failureCode ? isRetryable(op.failureCode) : (op.state === 'prepared')
  };
}

/**
 * A durable receipt derived from real settlement state. It must NOT claim 'completed' merely because
 * submission succeeded — finalStatus mirrors the canonical lifecycle, which only reaches 'completed'
 * after the chain receipt confirmed and effects reconciled.
 */
export function receiptFor(op, ctx = {}) {
  const p = canonicalPayment(op, ctx);
  return {
    receiptId: `rcpt_${op.operationId}`,
    paymentId: op.operationId,
    operationId: op.operationId,
    amountAtomic: p.amountAtomic,
    asset: p.asset,
    memo: p.memo,
    sender: p.sender,
    recipient: p.recipient,
    entryMethod: p.entryMethod,
    resolutionId: p.resolutionId,
    resolutionVersion: p.resolutionVersion,
    finalStatus: p.lifecycleState,
    transactionHash: p.transactionHash,
    blockNumber: p.blockNumber,
    gasSponsored: p.gasSponsored,
    createdAt: p.createdAt,
    settledAt: op.state === 'completed' ? (op.completedAt ?? null) : null,
    requestId: p.requestId,
    claimId: p.claimId
  };
}
