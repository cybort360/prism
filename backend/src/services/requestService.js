import crypto from 'node:crypto';
import { canonicalJson } from '../lib/crypto.js';
import { verifyAccountMessage } from '../chain/eth.js';

function signable(r) {
  const { requestId, requesterPrismId, amountAtomic, token, tokenSymbol, memo, createdAt, expiresAt } = r;
  // Explicit null normalization: a universal request (no designated payer) serializes
  // `"payerPrismId":null` deterministically, so the requester signs the canonical commitment.
  return { requestId, requesterPrismId, payerPrismId: r.payerPrismId ?? null, amountAtomic, token, tokenSymbol, memo, createdAt, expiresAt };
}

const PHONE_PATTERNS = [
  /tel:/i,
  /\+\d{7,15}/,
  /\b\d{3}[-.\s()]*\d{3}[-.\s()]*\d{4}\b/
];

function positiveAtomic(value) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) throw new Error('amount must be a positive integer');
  return String(BigInt(value));
}

export class RequestService {
  constructor({ store, identityService, config }) {
    this.store = store;
    this.identityService = identityService;
    this.config = config;
  }

  draft({ requesterPrismId, payerPrismId = null, amountAtomic, memo = '', destination = 'PRIMARY', circleId = null, expiresAt }) {
    if (!this.identityService.get(requesterPrismId)) throw new Error('requester not found');
    // A designated payer is validated exactly as before. An omitted payer makes this a
    // universal public request payable by anyone — no identity check is possible or required.
    if (payerPrismId !== null && payerPrismId !== undefined) {
      if (!this.identityService.get(payerPrismId)) throw new Error('payer not found');
      if (requesterPrismId === payerPrismId) throw new Error('cannot request yourself');
    } else {
      payerPrismId = null;
    }
    amountAtomic = positiveAtomic(amountAtomic);
    if (BigInt(amountAtomic) > this.config.limits.maxPaymentAtomic) throw new Error('amount exceeds Prism payment limit');
    memo = String(memo ?? '').trim().slice(0, 120);
    for (const re of PHONE_PATTERNS) {
      if (re.test(memo)) {
        const err = new Error('memo must not contain a phone number (INV-P1)');
        err.statusCode = 400;
        throw err;
      }
    }
    const expiry = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 24 * 60 * 60_000);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now() || expiry.getTime() > Date.now() + 30 * 24 * 60 * 60_000) throw new Error('invalid request expiry');

    const request = {
      requestId: `req_${crypto.randomUUID()}`,
      requesterPrismId,
      payerPrismId,
      // Universal public requests carry no designated payer and may be fulfilled by anyone.
      isPublic: payerPrismId === null,
      amountAtomic,
      token: this.config.chain.usdc,
      tokenSymbol: 'USDC',
      memo,
      // Where settlement lands (PRIMARY, SAVINGS, CIRCLE + Circle id). Stored
      // metadata ONLY — signable() below is unchanged, so the signed envelope
      // stays byte-identical and backward compatible.
      destination,
      circleId,
      createdAt: new Date().toISOString(),
      expiresAt: expiry.toISOString(),
      status: 'DRAFT'
    };
    this.store.mutate(data => { data.requests[request.requestId] = request; });
    return { request, signable: canonicalJson(signable(request)) };
  }

  async commit({ requesterPrismId, requestId, signature }) {
    const requester = this.identityService.get(requesterPrismId);
    if (!requester) throw new Error('requester not found');
    const draftRequest = this.store.read().requests[requestId];
    if (!draftRequest || draftRequest.requesterPrismId !== requesterPrismId) throw new Error('request not found');
    if (draftRequest.status !== 'DRAFT') throw new Error('request is not a draft');
    if (Date.parse(draftRequest.expiresAt) <= Date.now()) throw new Error('request expired');
    // The requester authorizes the request with their Mera account (personal_sign).
    const ok = await verifyAccountMessage(requester.account, canonicalJson(signable(draftRequest)), signature);
    if (!ok) throw new Error('invalid request signature');
    return this.store.mutate(data => {
      const r = data.requests[requestId];
      if (!r || r.status !== 'DRAFT') throw new Error('request is not a draft');
      r.signature = signature;
      r.status = 'OPEN';
      r.committedAt = new Date().toISOString();
      return r;
    });
  }

  listFor(prismId) {
    this._expireOpenRequests();
    return Object.values(this.store.read().requests)
      .filter(r => (r.requesterPrismId === prismId || r.payerPrismId === prismId) && r.status !== 'DRAFT')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(r => this._record(r));
  }

  /**
   * The payer/requester-facing record of a request. Explicit field list (not the raw stored object)
   * so the requester's second-hop sweep/destination never leaks to the payer, and so both parties'
   * handles are resolved — a payer must see WHO is asking for money, not "Prism requester".
   */
  _record(r) {
    const requester = this.identityService.get(r.requesterPrismId);
    const payer = r.payerPrismId ? this.identityService.get(r.payerPrismId) : null;
    return {
      requestId: r.requestId,
      requesterPrismId: r.requesterPrismId,
      requesterHandle: requester?.handle ?? null,
      requesterDisplayName: requester?.displayName ?? null,
      payerPrismId: r.payerPrismId ?? null,
      payerHandle: payer?.handle ?? null,
      payerDisplayName: payer?.displayName ?? null,
      amountAtomic: r.amountAtomic,
      token: r.token,
      tokenSymbol: r.tokenSymbol ?? null,
      memo: r.memo ?? '',
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      status: r.status,
      signature: r.signature ?? null,
      transactionHash: r.transactionHash ?? null
    };
  }

  assertPayable({ requestId, payerPrismId, recipientPrismId, amountAtomic }) {
    this._expireOpenRequests();
    const r = this.store.read().requests[requestId];
    if (!r || r.status !== 'OPEN') throw new Error('request is not open');
    if (r.payerPrismId !== null && r.payerPrismId !== undefined) {
      // Designated 1-to-1 request: strict payer binding, byte-identical behavior.
      if (r.payerPrismId !== payerPrismId) throw new Error('request belongs to another payer');
    } else if (!payerPrismId) {
      // Universal request: anyone may fulfill (direct payer or cross-chain relayer id),
      // but a payer must still be named — anonymous fulfillment is never recorded.
      throw new Error('payer is required to fulfill this request');
    }
    if (r.requesterPrismId !== recipientPrismId) throw new Error('payment recipient does not match requester');
    if (String(r.amountAtomic) !== String(amountAtomic)) throw new Error('payment amount does not match request');
    return r;
  }

  /**
   * Public, unauthenticated view of a request for universal payment links.
   *
   * Only public profile metadata leaves this function — handle/name, amount, token, memo,
   * destination, status, expiry. Phone numbers, HMAC lookup keys, and session details are
   * never read here, so they cannot leak through it (INV-P1).
   */
  getPublicView(requestId) {
    this._expireOpenRequests();
    const r = this.store.read().requests[requestId];
    if (!r || r.isPublic !== true) {
      const e = new Error('request not found');
      e.statusCode = 404;
      throw e;
    }
    const requester = this.identityService.get(r.requesterPrismId);
    return {
      requestId: r.requestId,
      requesterHandle: requester?.handle ?? null,
      requesterDisplayName: requester?.displayName ?? null,
      requesterAccount: requester?.accountAddress ?? null,
      amountAtomic: r.amountAtomic,
      token: r.token,
      tokenSymbol: r.tokenSymbol,
      memo: r.memo,
      destination: r.destination ?? 'PRIMARY',
      status: r.status,
      expiresAt: r.expiresAt
    };
  }

  /**
   * The requester's own view of a request, including its sweep state (Circle/Savings
   * second hop). 404s if the request doesn't exist or isn't owned by the caller, so a
   * request can never be read by anyone other than its requester through this path.
   */
  getOwn(requestId, prismId) {
    const r = this.store.read().requests[requestId];
    if (!r || r.requesterPrismId !== prismId) { const e = new Error('request not found'); e.statusCode = 404; throw e; }
    const sweep = r.sweep ? { state: r.sweep.state, destination: r.sweep.destination, transactionHash: r.sweep.transactionHash ?? null, failure: r.sweep.failure ?? null } : null;
    return { requestId: r.requestId, status: r.status, amountAtomic: r.amountAtomic, destination: r.destination ?? 'PRIMARY', sweep };
  }

  setStatus(requestId, status, actorPrismId) {
    const allowed = new Set(['DECLINED', 'CANCELLED']);
    if (!allowed.has(status)) throw new Error('invalid user-controlled request status');
    return this.store.mutate(data => {
      const r = data.requests[requestId];
      if (!r) throw new Error('request not found');
      if (r.status !== 'OPEN') throw new Error('request is not open');
      if (status === 'CANCELLED' && r.requesterPrismId !== actorPrismId) throw new Error('not requester');
      if (status === 'DECLINED' && r.payerPrismId !== actorPrismId) throw new Error('not payer');
      r.status = status;
      r.updatedAt = new Date().toISOString();
      return r;
    });
  }

  markPaid(requestId, operationId, transactionHash) {
    if (!requestId) return;
    this.store.mutate(data => {
      const r = data.requests[requestId];
      if (!r || r.status !== 'OPEN') return;
      r.status = 'PAID';
      r.paymentOperationId = operationId;
      r.transactionHash = transactionHash ?? null;
      r.paidAt = new Date().toISOString();
    });
  }

  _expireOpenRequests() {
    this.store.mutate(data => {
      const now = Date.now();
      for (const r of Object.values(data.requests)) {
        if (r.status === 'OPEN' && Date.parse(r.expiresAt) <= now) {
          r.status = 'EXPIRED';
          r.updatedAt = new Date().toISOString();
        }
      }
    });
  }
}
