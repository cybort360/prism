import crypto from 'node:crypto';
import { canonicalJson } from '../lib/crypto.js';
import { verifyAccountMessage } from '../chain/eth.js';

function signable(r) {
  const { requestId, requesterPrismId, payerPrismId, amountAtomic, token, memo, createdAt, expiresAt } = r;
  return { requestId, requesterPrismId, payerPrismId, amountAtomic, token, memo, createdAt, expiresAt };
}

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

  draft({ requesterPrismId, payerPrismId, amountAtomic, token, memo = '', expiresAt }) {
    if (!this.identityService.get(requesterPrismId)) throw new Error('requester not found');
    if (!this.identityService.get(payerPrismId)) throw new Error('payer not found');
    if (requesterPrismId === payerPrismId) throw new Error('cannot request yourself');
    amountAtomic = positiveAtomic(amountAtomic);
    if (BigInt(amountAtomic) > this.config.limits.maxPaymentAtomic) throw new Error('amount exceeds Prism payment limit');
    if (String(token).toLowerCase() !== this.config.chain.ausd.toLowerCase()) throw new Error('unsupported request token');
    memo = String(memo ?? '').trim().slice(0, 120);
    const expiry = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 24 * 60 * 60_000);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now() || expiry.getTime() > Date.now() + 30 * 24 * 60 * 60_000) throw new Error('invalid request expiry');

    const request = {
      requestId: `req_${crypto.randomUUID()}`,
      requesterPrismId,
      payerPrismId,
      amountAtomic,
      token: this.config.chain.ausd,
      memo,
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
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  assertPayable({ requestId, payerPrismId, recipientPrismId, amountAtomic, token }) {
    this._expireOpenRequests();
    const r = this.store.read().requests[requestId];
    if (!r || r.status !== 'OPEN') throw new Error('request is not open');
    if (r.payerPrismId !== payerPrismId) throw new Error('request belongs to another payer');
    if (r.requesterPrismId !== recipientPrismId) throw new Error('payment recipient does not match requester');
    if (String(r.amountAtomic) !== String(amountAtomic)) throw new Error('payment amount does not match request');
    if (r.token.toLowerCase() !== String(token).toLowerCase()) throw new Error('payment token does not match request');
    return r;
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
