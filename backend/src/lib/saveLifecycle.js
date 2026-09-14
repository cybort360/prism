// Prism Save — lifecycle state machines. Pure. Three machines (deposit, instant withdraw, queued
// withdraw), their allowed transitions, the consumer-facing phase each maps to, and the rule that a
// semantic step (SWAPPING/DEPOSITING/…) is NOT a separately-observed timestamp — a single atomic receipt
// stamps `confirmedAt` once, and the intermediate steps are proof states, not fabricated observed times.

export const SaveDepositState = Object.freeze({
  CREATED: 'CREATED', QUOTING: 'QUOTING', QUOTED: 'QUOTED',
  AWAITING_AUTHORIZATION: 'AWAITING_AUTHORIZATION', AUTHORIZED: 'AUTHORIZED', SUBMITTED: 'SUBMITTED',
  SWAPPING: 'SWAPPING', DEPOSITING: 'DEPOSITING', CONFIRMING: 'CONFIRMING', CONFIRMED: 'CONFIRMED',
  RECONCILING: 'RECONCILING', SAVED: 'SAVED', FAILED: 'FAILED'
});

export const WithdrawInstantState = Object.freeze({
  CREATED: 'CREATED', QUOTED: 'QUOTED', AUTHORIZED: 'AUTHORIZED', REDEEMING: 'REDEEMING',
  CONVERTING_TO_USDC: 'CONVERTING_TO_USDC', CONFIRMING: 'CONFIRMING', AVAILABLE: 'AVAILABLE', FAILED: 'FAILED'
});

export const WithdrawQueuedState = Object.freeze({
  CREATED: 'CREATED', AUTHORIZED: 'AUTHORIZED', WITHDRAWAL_REQUESTED: 'WITHDRAWAL_REQUESTED',
  QUEUED: 'QUEUED', CLAIMABLE: 'CLAIMABLE', CLAIMING: 'CLAIMING', AUSD_RECEIVED: 'AUSD_RECEIVED',
  CONVERTING_TO_USDC: 'CONVERTING_TO_USDC', AVAILABLE: 'AVAILABLE', FAILED: 'FAILED'
});

const linear = (order) => {
  const t = {};
  order.forEach((state, i) => { t[state] = i + 1 < order.length ? [order[i + 1]] : []; });
  return t;
};

const DEPOSIT_ORDER = ['CREATED', 'QUOTING', 'QUOTED', 'AWAITING_AUTHORIZATION', 'AUTHORIZED', 'SUBMITTED', 'SWAPPING', 'DEPOSITING', 'CONFIRMING', 'CONFIRMED', 'RECONCILING', 'SAVED'];
const INSTANT_ORDER = ['CREATED', 'QUOTED', 'AUTHORIZED', 'REDEEMING', 'CONVERTING_TO_USDC', 'CONFIRMING', 'AVAILABLE'];
const QUEUED_ORDER = ['CREATED', 'AUTHORIZED', 'WITHDRAWAL_REQUESTED', 'QUEUED', 'CLAIMABLE', 'CLAIMING', 'AUSD_RECEIVED', 'CONVERTING_TO_USDC', 'AVAILABLE'];

// FAILED is reachable from any non-terminal state (a fail-closed sink). Terminals go nowhere.
function machine(order, terminal) {
  const t = linear(order);
  for (const state of order) if (state !== terminal) t[state] = [...t[state], 'FAILED'];
  t.FAILED = [];
  return t;
}

export const DEPOSIT_MACHINE = machine(DEPOSIT_ORDER, 'SAVED');
export const INSTANT_MACHINE = machine(INSTANT_ORDER, 'AVAILABLE');
export const QUEUED_MACHINE = machine(QUEUED_ORDER, 'AVAILABLE');

const MACHINES = {
  SAVE: DEPOSIT_MACHINE, WITHDRAW_INSTANT: INSTANT_MACHINE,
  WITHDRAW_STANDARD: QUEUED_MACHINE, CLAIM_WITHDRAWAL: QUEUED_MACHINE
};

/** Whether `to` is a permitted next state of `from` for a Save operation of `kind`. */
export function canTransition(kind, from, to) {
  const m = MACHINES[kind];
  if (!m || !(from in m)) return false;
  return m[from].includes(to);
}

/** Terminal states (nothing follows). */
export function isTerminal(kind, state) {
  const m = MACHINES[kind];
  return !!m && Array.isArray(m[state]) && m[state].length === 0;
}

// Only these states correspond to a REAL observed event and may carry a timestamp. Everything else
// (SWAPPING, DEPOSITING, RECONCILING, REDEEMING, CONVERTING_TO_USDC, QUEUED, CLAIMING, AUSD_RECEIVED) is a
// semantic proof step and must NOT invent an observed time — a single atomic receipt stamps confirmedAt.
const OBSERVED_STAMP = {
  CREATED: 'createdAt', AUTHORIZED: 'authorizedAt', SUBMITTED: 'submittedAt',
  WITHDRAWAL_REQUESTED: 'submittedAt', CONFIRMED: 'confirmedAt', CLAIMABLE: 'confirmedAt',
  SAVED: 'completedAt', AVAILABLE: 'completedAt'
};

/** The timestamp field a state may set, or null if it is a semantic-only proof step. */
export function timestampField(state) { return OBSERVED_STAMP[state] ?? null; }
export function isObservedState(state) { return state in OBSERVED_STAMP; }

/** The consumer phase + label for a backend state. Consumers never see the substrate vocabulary. */
export function consumerPhase(kind, state) {
  if (state === 'FAILED') return { phase: 'failed', label: "That didn't go through" };
  if (kind === 'SAVE') {
    if (state === 'SAVED') return { phase: 'done', label: 'Saved' };
    if (['CREATED', 'QUOTING', 'QUOTED', 'AWAITING_AUTHORIZATION', 'AUTHORIZED'].includes(state)) return { phase: 'preparing', label: 'Preparing…' };
    return { phase: 'working', label: 'Saving…' };
  }
  if (kind === 'WITHDRAW_INSTANT') {
    if (state === 'AVAILABLE') return { phase: 'done', label: 'Available' };
    return { phase: 'working', label: 'Withdrawing…' };
  }
  // Queued withdraw: requested → processing → ready → available.
  if (state === 'AVAILABLE') return { phase: 'done', label: 'Available' };
  if (state === 'CLAIMABLE') return { phase: 'ready', label: 'Ready' };
  if (['WITHDRAWAL_REQUESTED', 'QUEUED', 'CREATED', 'AUTHORIZED'].includes(state)) return { phase: 'requested', label: 'Withdrawal requested' };
  return { phase: 'processing', label: 'Processing' };
}
