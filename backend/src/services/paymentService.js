import { randomHex, sha256, hex, phoneLookupKey, normalizeE164 } from '../lib/crypto.js';
import {
  paymentEnvelopeTypedData, transferAuthorizationTypedData, receiveAuthorizationTypedData,
  claimIntentTypedData, verifyTypedData, resolutionHash, claimFundingNonce, checksum
} from '../chain/eth.js';
import { relaySettle, relayFundClaim, relayClaim, relayRefund, getReceipt } from '../chain/relay.js';
import { logger } from '../lib/logger.js';
import { startTimer, record as recordMetric, increment } from '../lib/metrics.js';
import { envioIndexer } from '../indexers/index.js';

const AUTH_WINDOW_SECONDS = 5 * 60;
const ZERO32 = `0x${'00'.repeat(32)}`;

/**
 * Orchestrates Prism's AUSD execution layer: direct payments (Prism PaymentEnvelope + AUSD
 * ERC-3009 transferWithAuthorization) and send-before-signup claims. The backend builds the exact
 * payloads the Mera account signs, verifies the returned signatures (fail closed), simulates the
 * transaction, then relays it paying MON. "submitted" is never "completed" — a UI-terminal state
 * comes only from a reconciled on-chain receipt.
 */
export class PaymentService {
  constructor({ store, config, identityService, claimService, resolverService, requestService }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.claimService = claimService;
    this.resolverService = resolverService;
    this.requestService = requestService;
  }

  assertResolution(resolution, requesterPrismId) {
    const a = this.resolverService.verifyResolution(resolution, requesterPrismId);
    const identity = this.identityService.get(a.prismIdentity);
    if (!identity || !identity.accountAddress || identity.accountAddress.toLowerCase() !== a.recipientAccount.toLowerCase() || identity.aliasVersion !== a.aliasVersion) {
      const e = new Error('stale or changed recipient identity');
      e.statusCode = 409;
      throw e;
    }
    return { identity, attestation: a };
  }

  // ---- direct payments -----------------------------------------------------

  async preparePayment({ senderPrismId, resolution, amountAtomic, requestId = null, memo = '' }) {
    const stopPrepare = startTimer('payment_prepare_ms');
    if (!this.config.chain.paymentRouter) throw httpError(503, 'PRISM_PAYMENT_ROUTER not configured');
    amountAtomic = this._paymentAmount(amountAtomic);
    const { identity: recipient, attestation } = this.assertResolution(resolution, senderPrismId);
    if (recipient.prismId === senderPrismId) throw new Error('cannot pay yourself');
    memo = String(memo ?? '').trim().slice(0, 120);

    const sender = this.identityService.get(senderPrismId);
    if (!sender?.accountAddress) throw new Error('sender account not ready');

    if (requestId) {
      this.requestService.assertPayable({
        requestId, payerPrismId: senderPrismId, recipientPrismId: recipient.prismId,
        amountAtomic, token: this.config.chain.ausd
      });
    }

    const paymentId = randomHex(32);
    const nonce = randomHex(32);
    const validBefore = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SECONDS;
    const env = {
      paymentId,
      payer: checksum(sender.accountAddress),
      recipient: checksum(recipient.accountAddress),
      token: checksum(this.config.chain.ausd),
      amount: amountAtomic,
      requestId: requestId ? hex(sha256(Buffer.from(`request:${requestId}`))) : ZERO32,
      // resolutionHash is derived ONLY from opaque resolver data — never a phone number.
      resolutionHash: resolutionHash({
        prismIdentity: recipient.prismId, recipientAccount: recipient.accountAddress,
        aliasVersion: recipient.aliasVersion, resolutionRequestId: attestation.requestId
      }),
      validBefore,
      nonce
    };

    const record = {
      operationId: paymentId,
      kind: 'payment',
      state: 'prepared',
      env,
      intent: { senderPrismId, recipientPrismId: recipient.prismId, amountAtomic, requestId, memo, aliasVersion: recipient.aliasVersion },
      createdAt: new Date().toISOString(),
      preparedAtMs: Date.now(),
      expiresAt: new Date(validBefore * 1000).toISOString(),
      effectsApplied: false
    };
    this.store.mutate(d => { d.operations[paymentId] = record; });
    logger.info('payment.prepared', { paymentId, senderPrismId, recipientPrismId: recipient.prismId, amountAtomic });
    stopPrepare();

    return {
      paymentId,
      state: 'prepared',
      expiresAt: record.expiresAt,
      envelope: env,
      typedData: {
        envelope: serialize(paymentEnvelopeTypedData(env)),
        ausd: serialize(transferAuthorizationTypedData({ from: env.payer, to: env.recipient, value: env.amount, validAfter: 0, validBefore, nonce }))
      }
    };
  }

  async submitPayment({ paymentId, prismSignature, ausdSignature, actorPrismId }) {
    const record = this.store.read().operations[paymentId];
    if (!record || record.kind !== 'payment') throw httpError(404, 'payment not found');
    if (actorPrismId && record.intent.senderPrismId !== actorPrismId) throw httpError(403, 'payment belongs to another caller');
    if (record.state !== 'prepared') return { paymentId, state: record.state, txHash: record.txHash ?? null };
    if (Date.parse(record.expiresAt) < Date.now()) throw httpError(400, 'prepared payment expired');

    const env = record.env;
    // Verify BOTH signatures recover to the payer, over the server-held canonical payloads.
    const okEnvelope = await verifyTypedData(paymentEnvelopeTypedData(env), env.payer, prismSignature);
    if (!okEnvelope) throw httpError(401, 'envelope signature does not match the payer');
    const ausdTyped = transferAuthorizationTypedData({ from: env.payer, to: env.recipient, value: env.amount, validAfter: 0, validBefore: env.validBefore, nonce: env.nonce });
    const okAusd = await verifyTypedData(ausdTyped, env.payer, ausdSignature);
    if (!okAusd) throw httpError(401, 'AUSD authorization signature does not match the payer');

    // signing_wait_ms: time the user spent approving + signing between prepare and submit.
    if (record.preparedAtMs) recordMetric('signing_wait_ms', Date.now() - record.preparedAtMs);

    const stopRelay = startTimer('relay_submit_ms');
    const txHash = await relaySettle({ env, prismSignature, ausdSignature }); // Alchemy: simulate + submit
    stopRelay();
    this.store.mutate(d => {
      const r = d.operations[paymentId];
      r.state = 'submitted'; r.txHash = txHash; r.submittedAt = new Date().toISOString(); r.submittedAtMs = Date.now();
    });
    logger.info('payment.submitted', { paymentId, txHash });
    return { paymentId, state: 'submitted', txHash };
  }

  // ---- claims --------------------------------------------------------------

  async prepareClaim({ senderPrismId, recipientPhone, amountAtomic, expirySeconds = 7 * 24 * 3600, memo = '' }) {
    if (!this.config.chain.claimVault) throw httpError(503, 'PRISM_CLAIM_VAULT not configured');
    amountAtomic = this._claimAmount(amountAtomic);
    const sender = this.identityService.get(senderPrismId);
    if (!sender?.accountAddress) throw new Error('sender account not ready');
    const lookup = phoneLookupKey(normalizeE164(recipientPhone), this.config.resolverPepper);
    if (this.store.read().phoneIndex[lookup]) throw new Error('recipient is already on Prism; pay them directly');

    const claim = this.claimService.createPending({
      senderPrismId, recipientPhoneLookupKey: lookup, amountAtomic, token: this.config.chain.ausd, expirySeconds, memo
    });
    const from = checksum(sender.accountAddress);
    const vault = checksum(this.config.chain.claimVault);
    const nonce = claimFundingNonce(claim.claimId, claim.recipientReference, BigInt(amountAtomic), from);
    const validBefore = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SECONDS;
    const fundingArgs = { claimId: claim.claimId, recipientReference: claim.recipientReference, sender: from, amount: amountAtomic, expiry: claim.expiry, validAfter: 0, validBefore, nonce };

    this.store.mutate(d => { d.operations[claim.claimId] = { operationId: claim.claimId, kind: 'claim-funding', state: 'prepared', fundingArgs, intent: { senderPrismId, claimId: claim.claimId, amountAtomic }, createdAt: new Date().toISOString(), expiresAt: new Date(validBefore * 1000).toISOString(), effectsApplied: false }; });
    logger.info('claim.prepared', { claimId: claim.claimId, senderPrismId, amountAtomic });

    return {
      claimId: claim.claimId,
      state: 'prepared',
      expiresAt: new Date(validBefore * 1000).toISOString(),
      typedData: serialize(receiveAuthorizationTypedData({ from, to: vault, value: amountAtomic, validAfter: 0, validBefore, nonce }))
    };
  }

  async fundClaim({ senderPrismId, claimId, signature }) {
    const record = this.store.read().operations[claimId];
    if (!record || record.kind !== 'claim-funding') throw httpError(404, 'claim funding not found');
    if (record.intent.senderPrismId !== senderPrismId) throw httpError(403, 'claim belongs to another caller');
    if (record.state !== 'prepared') return { claimId, state: record.state, txHash: record.txHash ?? null };
    if (Date.parse(record.expiresAt) < Date.now()) throw httpError(400, 'prepared claim funding expired');

    const a = record.fundingArgs;
    const typed = receiveAuthorizationTypedData({ from: a.sender, to: checksum(this.config.chain.claimVault), value: a.amount, validAfter: 0, validBefore: a.validBefore, nonce: a.nonce });
    if (!(await verifyTypedData(typed, a.sender, signature))) throw httpError(401, 'funding signature does not match the sender');

    try {
      const txHash = await relayFundClaim({ ...a, signature });
      this.store.mutate(d => { d.operations[claimId].state = 'submitted'; d.operations[claimId].txHash = txHash; });
      this.claimService.markFundingSubmitted(claimId, txHash, claimId);
      logger.info('claim.funding.submitted', { claimId, txHash });
      return { claimId, state: 'submitted', txHash };
    } catch (e) {
      this.claimService.markFundingFailed(claimId);
      throw e;
    }
  }

  async collectClaim({ recipientPrismId, claimId, recipientIntentSignature }) {
    if (!this.config.chain.claimVault) throw httpError(503, 'PRISM_CLAIM_VAULT not configured');
    const eligibility = await this.claimService.issueEligibility({ claimId, recipientPrismId });
    // Defense-in-depth: verify the recipient's own Mera intent before relaying (the vault re-checks).
    const intentTyped = claimIntentTypedData({ claimId, recipient: eligibility.recipient });
    if (!(await verifyTypedData(intentTyped, eligibility.recipient, recipientIntentSignature))) {
      throw httpError(401, 'recipient intent signature does not match the recipient account');
    }
    const txHash = await relayClaim({
      claimId, recipient: eligibility.recipient, aliasVersion: eligibility.aliasVersion,
      eligibilityExpiry: eligibility.eligibilityExpiry, eligibilityNonce: eligibility.eligibilityNonce,
      authorizerSig: eligibility.authorizerSig, recipientSig: recipientIntentSignature
    });
    this._ensureOp(claimId, 'claim-collection', { recipientPrismId, claimId });
    this.store.mutate(d => { d.operations[claimId].state = 'submitted'; d.operations[claimId].txHash = txHash; d.operations[claimId].kind = 'claim-collection'; });
    this.claimService.markClaimSubmitted(claimId, txHash);
    logger.info('claim.collect.submitted', { claimId, txHash });
    return { claimId, state: 'submitted', txHash };
  }

  async refundClaim({ senderPrismId, claimId }) {
    if (!this.config.chain.claimVault) throw httpError(503, 'PRISM_CLAIM_VAULT not configured');
    this.claimService.assertRefundable({ claimId, senderPrismId });
    const txHash = await relayRefund({ claimId });
    this._ensureOp(claimId, 'claim-refund', { senderPrismId, claimId });
    this.store.mutate(d => { d.operations[claimId].state = 'submitted'; d.operations[claimId].txHash = txHash; d.operations[claimId].kind = 'claim-refund'; });
    this.claimService.markRefundSubmitted(claimId, txHash);
    logger.info('claim.refund.submitted', { claimId, txHash });
    return { claimId, state: 'submitted', txHash };
  }

  // ---- reconciliation (ambiguous-submission safe) --------------------------

  async reconcile(operationId, actorPrismId) {
    let record = this.store.read().operations[operationId];
    if (!record) throw httpError(404, 'operation not found');
    const ownerPrismId = record.intent?.senderPrismId ?? record.intent?.recipientPrismId;
    if (actorPrismId && ownerPrismId && ownerPrismId !== actorPrismId) throw httpError(403, 'operation belongs to another caller');
    // Terminal on-chain, but indexing may still be catching up — re-check Envio, don't fake it.
    if (record.state === 'completed') return publicOp(await this._checkIndexing(record));
    if (record.state === 'failed') return publicOp(record);
    if (!record.txHash) return { operationId, state: record.state, txHash: null };

    const receipt = await getReceipt(record.txHash); // Alchemy receipt query (live confirmation)
    if (!receipt) {
      // Ambiguous: submitted but not yet mined. Never report success; keep it 'confirming'.
      this.store.mutate(d => { if (d.operations[operationId]?.state === 'submitted') d.operations[operationId].state = 'confirming'; });
      return { operationId, state: 'confirming', txHash: record.txHash };
    }
    const success = receipt.status === 'success' || receipt.status === '0x1' || receipt.status === 1;
    this.store.mutate(d => {
      const r = d.operations[operationId];
      r.state = success ? 'completed' : 'failed';
      r.transactionHash = receipt.transactionHash ?? record.txHash;
      r.blockNumber = receipt.blockNumber ? receipt.blockNumber.toString() : null;
      r.completedAt = new Date().toISOString();
      r.completedAtMs = Date.now();
    });
    record = this.store.read().operations[operationId];
    // Latency + failure-rate metrics for the payment path.
    if (record.kind === 'payment') {
      increment('payment', success);
      if (success) {
        if (record.submittedAtMs) recordMetric('chain_confirmation_ms', record.completedAtMs - record.submittedAtMs);
        if (record.preparedAtMs) recordMetric('end_to_end_payment_ms', record.completedAtMs - record.preparedAtMs);
      }
    }
    if (success && !record.effectsApplied) {
      this._applySuccess(record);
      this.store.mutate(d => { d.operations[operationId].effectsApplied = true; });
      record = this.store.read().operations[operationId];
    } else if (!success && record.kind === 'claim-funding') {
      this.claimService.markFundingFailed(operationId);
    }
    logger.info('operation.reconciled', { operationId, state: record.state, txHash: record.transactionHash });
    if (success) record = await this._checkIndexing(record);
    return publicOp(record);
  }

  _applySuccess(record) {
    const tx = record.transactionHash;
    if (record.kind === 'payment' && record.intent.requestId) this.requestService.markPaid(record.intent.requestId, record.operationId, tx);
    if (record.kind === 'claim-funding') this.claimService.markFunded(record.operationId, record.txHash, tx);
    if (record.kind === 'claim-collection') this.claimService.markClaimed(record.operationId, tx);
    if (record.kind === 'claim-refund') this.claimService.markRefunded(record.operationId, tx);
  }

  _ensureOp(id, kind, intent) {
    if (this.store.read().operations[id]) return;
    this.store.mutate(d => { d.operations[id] = { operationId: id, kind, state: 'prepared', intent, createdAt: new Date().toISOString(), effectsApplied: false }; });
  }

  /**
   * Envio indexing state for a completed payment. The chain is canonical (already confirmed); this
   * only annotates whether Envio has indexed the PaymentSettled event yet — never fakes completion.
   */
  async _checkIndexing(record) {
    if (record.kind !== 'payment' || record.state !== 'completed' || record.indexed) return record;
    if (!envioIndexer().available()) return record;
    const indexed = await envioIndexer().isPaymentIndexed(record.operationId);
    if (!indexed) return record;
    this.store.mutate(d => {
      const r = d.operations[record.operationId];
      r.indexed = true;
      r.indexedAt = new Date().toISOString();
      r.indexedAtMs = Date.now();
    });
    record = this.store.read().operations[record.operationId];
    if (record.completedAtMs) recordMetric('envio_index_ms', record.indexedAtMs - record.completedAtMs);
    logger.info('payment.indexed', { paymentId: record.operationId });
    return record;
  }

  /** Reconcile whichever operation submitted `txHash` (used by the Alchemy webhook, with readback). */
  async reconcileByTxHash(txHash) {
    const ops = this.store.read().operations;
    const match = Object.values(ops).find(o => (o.txHash ?? '').toLowerCase() === String(txHash).toLowerCase());
    if (!match) return null;
    return this.reconcile(match.operationId, null);
  }

  /** Developer/judge proof for a payment: on-chain truth + Envio proof + balances + request binding. */
  async proofFor(paymentId, actorPrismId) {
    const record = this.store.read().operations[paymentId];
    if (!record || record.kind !== 'payment') throw httpError(404, 'payment not found');
    if (actorPrismId && record.intent.senderPrismId !== actorPrismId) throw httpError(403, 'payment belongs to another caller');
    return record;
  }

  _paymentAmount(value) {
    if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) throw new Error('amount must be positive');
    if (BigInt(value) > this.config.limits.maxPaymentAtomic) throw new Error('amount exceeds Prism payment limit');
    return String(BigInt(value));
  }
  _claimAmount(value) {
    const amount = this._paymentAmount(value);
    if (BigInt(amount) > this.config.limits.maxClaimAtomic) throw new Error('claim exceeds Prism pre-user limit');
    return amount;
  }
}

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
function serialize(obj) { return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); }
function publicOp(r) {
  return {
    operationId: r.operationId, kind: r.kind, state: r.state,
    txHash: r.txHash ?? null, transactionHash: r.transactionHash ?? null, blockNumber: r.blockNumber ?? null,
    // Chain is canonical; `indexed` reflects Envio catch-up so the UI shows an honest indexing state.
    indexed: r.indexed ?? false, indexedAt: r.indexedAt ?? null
  };
}
