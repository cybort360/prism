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

// --- Aurora cross-chain route lifecycle -------------------------------------
// The routed leg of a cross-chain transfer is a SEPARATE state machine from the Monad payment above.
// It is kept separate on purpose: the payment machine is audited and its transition table must not
// be widened for a different subsystem's states. A route and its funding payment reference each
// other by id; neither one's state is derived from the other's.
// Progress is observed by POLLING a remote state machine, so intermediate states are routinely
// missed — a fast route can be seen as `quoted` and then `delivered` with nothing in between. The
// guard therefore enforces "never backwards, never out of a terminal state", not "one step at a
// time": any forward state in this progression is reachable from any earlier one.
export const AURORA_PROGRESSION = ['quoted', 'funding', 'funded', 'routing', 'delivered'];

// Branch states are reachable from any non-terminal state, because Aurora can report a refund or a
// failure at any point. `expired` only applies before funds move, so it hangs off the early states.
const AURORA_BRANCHES = ['requires_attention', 'refunding', 'refunded', 'route_failed'];

export const AURORA_TERMINAL_STATES = ['delivered', 'refunded', 'route_failed', 'expired'];

export const AURORA_TRANSITIONS = buildAuroraTransitions();

function buildAuroraTransitions() {
  const table = {};
  AURORA_PROGRESSION.forEach((state, index) => {
    const forward = AURORA_PROGRESSION.slice(index + 1);
    // A quote can lapse before it is funded; once funds are in flight the outcome is a refund or a
    // failure, never a silent expiry.
    const expiry = index <= 1 ? ['expired'] : [];
    table[state] = [...forward, ...AURORA_BRANCHES, ...expiry];
  });
  table.requires_attention = ['routing', 'delivered', 'refunding', 'refunded', 'route_failed'];
  table.refunding = ['refunded', 'route_failed'];
  for (const terminal of AURORA_TERMINAL_STATES) table[terminal] = [];
  return table;
}

/**
 * Aurora's execution status -> Prism's route state.
 * INCOMPLETE_DEPOSIT is deliberately `requires_attention`, not a failure: the funds are there, they
 * are just short of the quoted amount, and a person has to decide what to do.
 */
export const AURORA_STATUS_STATE = {
  PENDING_DEPOSIT: 'funding',
  KNOWN_DEPOSIT_TX: 'funded',
  INCOMPLETE_DEPOSIT: 'requires_attention',
  PROCESSING: 'routing',
  SUCCESS: 'delivered',
  REFUNDED: 'refunded',
  FAILED: 'route_failed'
};

export function canTransitionRoute(from, to) {
  if (from === to) return true;     // idempotent status polls never mutate, always safe
  return (AURORA_TRANSITIONS[from] ?? []).includes(to);
}
export function assertRouteTransition(from, to) {
  if (!canTransitionRoute(from, to)) {
    const e = new Error(`illegal route transition: ${from} -> ${to}`);
    e.statusCode = 409;
    throw e;
  }
}

/** Map an Aurora status string onto a route state, or null when the status is unknown to us. */
export function routeStateForStatus(status) {
  return AURORA_STATUS_STATE[status] ?? null;
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
  CLAIM_EXPIRED: { state: 'expired', canonical: 'expired', retryable: false },
  // --- shared-account (Circle) payments. One vocabulary, not a parallel one. ---
  // A field the admins' signatures cover changed, so every approval stopped verifying. Recoverable
  // only by proposing the payment again — which is a retry a person performs, not one Prism does.
  CIRCLE_APPROVAL_INVALIDATED: { state: 'requires_attention', canonical: 'requiresAttention', retryable: true },
  // The Safe consumed this nonce elsewhere; the transaction can never execute.
  CIRCLE_NONCE_CONSUMED: { state: 'expired', canonical: 'expired', retryable: true },
  // Broadcast, mined, and not the payment that was approved (or the Safe reported ExecutionFailure).
  CIRCLE_EXECUTION_FAILED: { state: 'failed', canonical: 'failedTerminal', retryable: false }
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
  // A Circle payment is still a PrismPayment; the kind says which authority released it, and the
  // `circle` block on the canonical projection says which shared account it came from.
  const source = op.intent?.circle ?? null;
  if (source) {
    if (source.flow === 'in') return 'circleContribution';
    return source.approvalPolicy === 'SPENDING_LIMIT' ? 'circleSpend' : 'circlePayment';
  }
  switch (op.kind) {
    case 'claim-funding': return 'claimFunding';
    case 'claim-collection': return 'claimSettlement';
    case 'claim-refund': return 'refund';
    case 'aurora-send': return 'crossChainSend';
    default: break;
  }
  const i = op.intent ?? {};
  if (i.requestId) return 'requestPayment';
  if (i.entryMethod === 'qr') return 'qrPayment';
  if (i.entryMethod === 'paymentLink') return 'linkPayment';
  return 'direct';
}

export function entryMethod(op) {
  if (op.intent?.circle) return 'circle';
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
export function canonicalPayment(op, { viewerPrismId = null, identityService, claim = null, route = null } = {}) {
  const i = op.intent ?? {};
  const get = (id) => (id && identityService ? identityService.get(id) : null);
  const senderId = i.senderPrismId ?? claim?.senderPrismId ?? null;
  const recipientId = i.recipientPrismId ?? null;
  // A shared account is a party too. When the money left a Circle the payer is the Circle itself —
  // showing the proposer there would name a person who did not spend their own money.
  const circle = i.circle ?? null;
  const circleParty = circle ? {
    prismIdentityId: null,
    displayName: circle.circleName,
    handle: null,
    accountAddress: circle.circleSafeAddress ?? null
  } : null;
  return {
    paymentId: op.operationId,
    operationId: op.operationId,
    kind: paymentKind(op),
    direction: direction(op, viewerPrismId),
    entryMethod: entryMethod(op),
    // Which kind of account this payment came out of. Absent context means personal, always.
    sourceType: circle ? 'circle' : 'personal',
    circle,
    sender: circle?.flow === 'out' ? circleParty : party(get(senderId)),
    recipient: circle?.flow === 'in' ? circleParty : party(get(recipientId)),
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
    retryable: op.failureCode ? isRetryable(op.failureCode) : (op.state === 'prepared'),
    // Where a cross-chain send is actually going. Null for every other kind. The route's own state
    // is carried separately from `lifecycleState`: that field describes the Monad leg, and a
    // confirmed Monad leg is not delivery.
    route: route ? {
      routeId: route.routeId,
      state: route.state,
      destinationChain: route.destination?.chain ?? null,
      destinationChainLabel: route.destination?.chainLabel ?? null,
      destinationSymbol: route.destination?.symbol ?? null,
      destinationAddress: route.destination?.address ?? null,
      minAmountOut: route.minAmountOut ?? null,
      destinationDecimals: route.destination?.decimals ?? null
    } : null
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
    // Same receipt, one extra block: paid from which Circle, requested by whom, approved by whom,
    // under which rule. Null on a personal payment, and never partially invented on a Circle one.
    sourceType: p.sourceType,
    circle: p.circle,
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
