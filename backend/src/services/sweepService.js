import { getAddress } from 'viem';
import { receiveAuthorizationTypedData } from '../chain/eth.js';
import { randomHex } from '../lib/crypto.js';

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

// SweepService — the second hop of a RECEIVE→Circle/Savings request. It builds the authorization the
// requester pre-signs at request time (validBefore = request expiry), stores it PENDING on the request,
// and — on settlement — relays it into the Circle Safe (live contribution) or the demo MockVault
// (SAVINGS). Non-custodial: the relayer only relays a signature the requester already made.
export class SweepService {
  constructor({ store, circleService, saveService, config, demoSaveExecutor = null, identityService = null }) {
    this.store = store;
    this.circles = circleService;
    this.saves = saveService;
    this.saveExecutor = demoSaveExecutor;
    this.identities = identityService;
    this.config = config;
  }

  _validBefore(request) { return Math.floor(Date.parse(request.expiresAt) / 1000); }

  async prepareForDraft(request) {
    const dest = request.destination ?? 'PRIMARY';
    if (dest === 'PRIMARY') return null;
    const validBefore = this._validBefore(request);

    if (dest === 'CIRCLE') {
      if (!request.circleId) throw httpError(400, 'circleId is required for a CIRCLE request');
      const prepared = await this.circles.prepareContribution({
        circleId: request.circleId, prismId: request.requesterPrismId, amountAtomic: request.amountAtomic, validBefore
      });
      const sweep = { destination: 'CIRCLE', circleId: request.circleId, preparedId: prepared.contribution.contributionId, state: 'PREPARING', createdAt: new Date().toISOString() };
      this.store.mutate((d) => { d.requests[request.requestId].sweep = sweep; });
      return { destination: 'CIRCLE', preparedId: sweep.preparedId, authorization: { envelope: prepared.typedData.envelope, tokenAuthorization: prepared.typedData.tokenAuthorization } };
    }

    if (dest === 'SAVINGS') {
      if (this.config.save.mode !== 'demo') throw httpError(503, 'SAVINGS destination requires demo Save');
      const account = getAddress(this.identities.get(request.requesterPrismId).accountAddress);
      const vault = getAddress(this.config.save.mockVault);
      const nonce = randomHex(32);
      const authorization = receiveAuthorizationTypedData({ from: account, to: vault, value: String(request.amountAtomic), validAfter: 0, validBefore, nonce });
      const quoteId = `sweep_${randomHex(16).slice(2)}`;
      // Persist a saveQuotes record demoSaveExecutor.submitDeposit can consume at settlement.
      this.store.mutate((d) => {
        d.saveQuotes ??= {};
        d.saveQuotes[quoteId] = { quoteId, kind: 'SAVE', prismId: request.requesterPrismId, account, amountAtomic: String(request.amountAtomic), vault, nonce, deadline: validBefore, minimumShares: null, estimatedShares: null, createdAt: new Date().toISOString() };
        const sweep = { destination: 'SAVINGS', preparedId: quoteId, state: 'PREPARING', createdAt: new Date().toISOString() };
        d.requests[request.requestId].sweep = sweep;
      });
      return { destination: 'SAVINGS', preparedId: quoteId, authorization };
    }
    throw httpError(400, `unknown destination '${dest}'`);
  }

  async attachSignatures({ requestId, requesterPrismId, sweepSignatures }) {
    return this.store.mutate((d) => {
      const r = d.requests[requestId];
      if (!r || r.requesterPrismId !== requesterPrismId) throw httpError(404, 'request not found');
      if (!r.sweep || r.sweep.state !== 'PREPARING') throw httpError(409, 'no sweep awaiting signatures');
      r.sweep.signatures = sweepSignatures;
      r.sweep.state = 'PENDING';
      return r.sweep;
    });
  }

  // Settlement-time sweep. Called from the settlement hook and from read-retry, so it must be safe to
  // call repeatedly: exactly one submit ever happens per sweep. We claim the sweep (PENDING -> SUBMITTED)
  // synchronously before any await; a concurrent/repeated call then finds state !== 'PENDING' and no-ops.
  //
  // Money-truth (INV-M1/M2): SWEPT means the second hop CONFIRMED on-chain — never merely broadcast. A
  // reverted second hop settles FAILED (the funds are still safe in the requester's primary account); a
  // broadcast-but-unconfirmed hop stays SUBMITTED ("Depositing…"), reconciled to a terminal state on the
  // next read. `_settle` submits then maps confirmation; `_reconcile` re-reads without resubmitting.
  async executeFor(requestId) {
    const r = (this.store.read().requests ?? {})[requestId];
    const current = r?.sweep?.state;

    if (current === 'PENDING') {
      // Single-flight: claim the sweep before any await so a concurrent/repeated call can't double-submit.
      this.store.mutate((d) => { d.requests[requestId].sweep.state = 'SUBMITTED'; d.requests[requestId].sweep.submittedAt = new Date().toISOString(); });
      try {
        const outcome = await this._settle(r);
        return this._applyOutcome(requestId, outcome);
      } catch (err) {
        // Safe fallback: the money stays in the requester's primary account. Never lost, never faked.
        this.store.mutate((d) => { const s = d.requests[requestId].sweep; s.state = 'FAILED'; s.failure = String(err?.message ?? 'sweep failed'); });
        return { state: 'FAILED' };
      }
    }

    if (current === 'SUBMITTED') {
      // Re-entry from the read-retry: the hop was already broadcast — never resubmit, only reconcile.
      try {
        const outcome = await this._reconcile(r);
        return this._applyOutcome(requestId, outcome);
      } catch {
        // A transient reconcile failure leaves the sweep SUBMITTED so the next read can retry.
        return { state: 'SUBMITTED' };
      }
    }

    return { state: current ?? 'NONE' };
  }

  // Apply a mapped outcome { txHash, terminalState } to the stored sweep. terminalState non-null is
  // terminal: 'SWEPT' (confirmed) or 'FAILED' (reverted). null leaves the sweep SUBMITTED.
  _applyOutcome(requestId, { txHash, terminalState }) {
    if (terminalState === 'SWEPT') {
      this.store.mutate((d) => { const s = d.requests[requestId].sweep; s.state = 'SWEPT'; s.transactionHash = txHash ?? s.transactionHash ?? null; s.sweptAt = new Date().toISOString(); });
      return { state: 'SWEPT', transactionHash: txHash ?? null };
    }
    if (terminalState === 'FAILED') {
      this.store.mutate((d) => { const s = d.requests[requestId].sweep; s.state = 'FAILED'; if (txHash) s.transactionHash = txHash; s.failure = s.failure ?? 'the destination deposit reverted on-chain'; });
      return { state: 'FAILED' };
    }
    // Not terminal yet: stay SUBMITTED ("Depositing…"). Record the broadcast tx hash if we now have one.
    if (txHash) this.store.mutate((d) => { const s = d.requests[requestId].sweep; if (!s.transactionHash) s.transactionHash = txHash; });
    return { state: 'SUBMITTED', transactionHash: txHash ?? null };
  }

  // First settlement: submit the second hop, then map its confirmation to a terminal outcome.
  async _settle(r) {
    if (r.sweep.destination === 'CIRCLE') {
      await this.circles.submitContribution({
        circleId: r.sweep.circleId, contributionId: r.sweep.preparedId, prismId: r.requesterPrismId,
        prismSignature: r.sweep.signatures.prismSignature, tokenSignature: r.sweep.signatures.tokenSignature
      });
      return this._reconcileCircle(r);
    }
    if (r.sweep.destination === 'SAVINGS') {
      const res = await this.saveExecutor.submitDeposit({ prismId: r.requesterPrismId, quoteId: r.sweep.preparedId, signature: r.sweep.signatures.signature });
      // demoSaveExecutor.submitDeposit RETURNS on revert (it does not throw): 'SAVED' confirmed,
      // 'FAILED' reverted, 'CONFIRMING' unmined. Map to money-truth terminal state.
      return this._mapSavings(res);
    }
    throw httpError(400, `unknown sweep destination '${r.sweep.destination}'`);
  }

  // Re-entry reconcile (SUBMITTED): re-read confirmation WITHOUT resubmitting the hop.
  async _reconcile(r) {
    if (r.sweep.destination === 'CIRCLE') return this._reconcileCircle(r);
    // SAVINGS: no cheap terminal re-read is available here (the op state is owned by the executor and
    // not keyed off the sweep), so leave it SUBMITTED for the next read to reconcile.
    if (r.sweep.destination === 'SAVINGS') return { txHash: r.sweep.transactionHash ?? null, terminalState: null };
    throw httpError(400, `unknown sweep destination '${r.sweep.destination}'`);
  }

  _mapSavings(res) {
    const terminalState = res?.state === 'SAVED' ? 'SWEPT' : (res?.state === 'FAILED' ? 'FAILED' : null);
    return { txHash: res?.txHash ?? null, terminalState };
  }

  async _reconcileCircle(r) {
    const rec = await this.circles.reconcileContribution({ circleId: r.sweep.circleId, contributionId: r.sweep.preparedId, prismId: r.requesterPrismId });
    const c = rec?.contribution ?? {};
    // ContributionStatus: COMPLETED = confirmed as this contribution; FAILED = reverted/mismatch; else pending.
    const terminalState = c.status === 'COMPLETED' ? 'SWEPT' : (c.status === 'FAILED' ? 'FAILED' : null);
    return { txHash: c.transactionHash ?? null, terminalState };
  }
}
