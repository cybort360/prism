/**
 * IntentDispatcherService — unified PREPARE facade over the existing intent surfaces.
 *
 * Purely additive: it imports and delegates to the audited services and never
 * reimplements them. It performs NO store writes, NO state transitions, NO submissions,
 * NO balance reads and NO completions of its own:
 *
 *   SPEND       -> circleService.previewPayment decides the route from live chain state.
 *                  ALLOWANCE  -> circleService.prepareSpend (member signs module hash).
 *                  THRESHOLD  -> circleService.proposePayment (Graceful Overflow; the
 *                                overflowMessage travels as display memo ONLY and never
 *                                touches thresholds, digests, or approvals — INV-A1).
 *   RECEIVE     -> requestService.draft with destination recorded ALONGSIDE the signed
 *                  request. The signed payload is untouched (zero-regression on the
 *                  request envelope); destination selects where settlement lands.
 *   CROSS_CHAIN -> auroraService.quoteSend (quote) and auroraService.prepareSend
 *                  (freeze into a routeHash-bound envelope). Settlement itself stays
 *                  inside auroraService -> paymentService; this facade never signs,
 *                  submits, or reconciles.
 *
 * Guardrails (enforced before any delegation):
 *   - INV-P1: any phone-looking value in params or memo is rejected with 400.
 *   - INV-M1/M2: no balance caching, no completion states — only `prepared`-level
 *     artifacts from the delegates are returned.
 */
export const IntentKind = Object.freeze({
  SPEND: 'SPEND',
  RECEIVE: 'RECEIVE',
  CROSS_CHAIN: 'CROSS_CHAIN'
});

export const ReceiveDestination = Object.freeze({
  PRIMARY: 'PRIMARY',
  SAVINGS: 'SAVINGS',
  CIRCLE: 'CIRCLE'
});
const DESTINATIONS = new Set(Object.values(ReceiveDestination));

const MAX_CONTEXT_CHARS = 120;

const PHONE_PATTERNS = [
  /tel:/i,
  /\+\d{7,15}/,
  /\b\d{3}[-.\s()]*\d{3}[-.\s()]*\d{4}\b/
];

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

function assertNoPhone(value, field = 'parameter') {
  for (const s of collectStrings(value, [])) {
    for (const re of PHONE_PATTERNS) {
      if (re.test(s)) throw httpError(400, `${field} must not contain a phone number (INV-P1)`);
    }
  }
}

function assertPositiveAtomic(amountAtomic) {
  if (!/^\d+$/.test(String(amountAtomic ?? '')) || BigInt(String(amountAtomic)) <= 0n) {
    throw httpError(400, 'amount must be a positive integer');
  }
  return String(BigInt(String(amountAtomic)));
}

function assertContextMessage(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw httpError(400, 'context message must be a string');
  const text = value.trim().slice(0, MAX_CONTEXT_CHARS);
  assertNoPhone(text, 'context message');
  return text;
}

export class IntentDispatcherService {
  constructor({ circleService, requestService, auroraService, config = null } = {}) {
    if (!circleService) throw new Error('circleService is required');
    if (!requestService) throw new Error('requestService is required');
    if (!auroraService) throw new Error('auroraService is required');
    this.circles = circleService;
    this.requests = requestService;
    this.aurora = auroraService;
    this.config = config;
  }

  kinds() {
    return [IntentKind.SPEND, IntentKind.RECEIVE, IntentKind.CROSS_CHAIN];
  }

  async prepareIntent({ kind, ...params } = {}) {
    assertNoPhone(params, 'intent parameters');
    switch (kind) {
      case IntentKind.SPEND:
        return this._prepareSpend(params);
      case IntentKind.RECEIVE:
        return this._prepareReceive(params);
      case IntentKind.CROSS_CHAIN:
        return this._prepareCrossChain(params);
      default:
        throw httpError(400, `unknown intent kind '${String(kind)}'`);
    }
  }

  // --- SPEND ---------------------------------------------------------------
  // Within limit -> allowance spend prepared for the member to sign.
  // Over limit (or limits unavailable) -> Graceful Overflow: an ordinary threshold
  // proposal. The contextual message is memo/display ONLY.
  async _prepareSpend({ circleId, actorPrismId, resolution, amountAtomic, memo = '', overflowMessage = null }) {
    if (!circleId) throw httpError(400, 'circleId is required');
    if (!actorPrismId) throw httpError(400, 'actorPrismId is required');
    if (!resolution) throw httpError(400, 'resolution is required');
    const amount = assertPositiveAtomic(amountAtomic);
    const context = assertContextMessage(overflowMessage ?? memo);

    const preview = await this.circles.previewPayment({ circleId, actorPrismId, amountAtomic: amount });
    if (preview && preview.route === 'ALLOWANCE') {
      const prepared = await this.circles.prepareSpend({
        circleId, actorPrismId, resolution, amountAtomic: amount, memo: context
      });
      return { kind: IntentKind.SPEND, route: 'ALLOWANCE', requiresApproval: false, overflow: false, ...prepared };
    }

    const proposal = await this.circles.proposePayment({
      circleId, actorPrismId, resolution, amountAtomic: amount,
      memo: context || undefined
    });
    return {
      kind: IntentKind.SPEND,
      route: 'THRESHOLD',
      requiresApproval: true,
      overflow: true,
      overLimit: preview?.overLimit ?? null,
      reason: preview?.reason ?? null,
      requiredApprovals: preview?.requiredApprovals ?? null,
      limit: preview?.limit ?? null,
      proposal
    };
  }

  // --- RECEIVE ---------------------------------------------------------------
  // Records destination ALONGSIDE the signed request; the request envelope itself
  // is built exclusively by requestService.draft (never extended here).
  async _prepareReceive({ requesterPrismId, payerPrismId, amountAtomic, memo = '', destination = ReceiveDestination.PRIMARY, circleId = null, expiresAt } = {}) {
    if (!requesterPrismId) throw httpError(400, 'requesterPrismId is required');
    if (!DESTINATIONS.has(destination)) {
      throw httpError(400, `unknown destination '${String(destination)}' (PRIMARY, SAVINGS, CIRCLE)`);
    }
    if (destination === ReceiveDestination.CIRCLE && !circleId) {
      throw httpError(400, 'circleId is required for CIRCLE destination');
    }
    const amount = assertPositiveAtomic(amountAtomic);
    const note = assertContextMessage(memo);

    const draft = this.requests.draft({
      requesterPrismId, payerPrismId, amountAtomic: amount, memo: note,
      destination, circleId: destination === ReceiveDestination.CIRCLE ? circleId : null,
      expiresAt
    });
    return {
      kind: IntentKind.RECEIVE,
      destination,
      circleId: destination === ReceiveDestination.CIRCLE ? circleId : null,
      savingsNote: destination === ReceiveDestination.SAVINGS
        ? 'auto-deposit into savings on settlement (savings vault integration specified, not yet deployed)'
        : null,
      request: draft.request,
      signable: draft.signable
    };
  }

  // --- CROSS_CHAIN -------------------------------------------------------------
  // Quote-only by default; pass routeId to freeze an existing quote into the
  // routeHash-bound envelope via auroraService.prepareSend (binding computed there:
  // routeId, depositAddress, destinationChain, destinationAssetId,
  // destinationRecipient, minAmountOut, quoteDeadline).
  async _prepareCrossChain({ prismId, destinationChain, destinationAsset, destinationAddress, amountAtomic, contractAddress = null, routeId = null } = {}) {
    if (!prismId) throw httpError(400, 'prismId is required');
    if (routeId) {
      const prepared = await this.aurora.prepareSend({ prismId, routeId });
      return { kind: IntentKind.CROSS_CHAIN, step: 'prepared', ...prepared };
    }
    if (!destinationChain) throw httpError(400, 'destinationChain is required');
    if (!destinationAddress) throw httpError(400, 'destinationAddress is required');
    const amount = assertPositiveAtomic(amountAtomic);
    const route = await this.aurora.quoteSend({
      prismId, destinationChain, destinationAsset, destinationAddress, amountAtomic: amount, contractAddress
    });
    return {
      kind: IntentKind.CROSS_CHAIN,
      step: 'quoted',
      route,
      binding: 'routeHash is bound at prepareSend over (routeId, depositAddress, destinationChain, destinationAssetId, destinationRecipient, minAmountOut, quoteDeadline)'
    };
  }
}
