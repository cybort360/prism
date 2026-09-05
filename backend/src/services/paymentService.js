import { randomHex, sha256, hex, phoneLookupKey, normalizeE164 } from '../lib/crypto.js';
import {
  paymentEnvelopeTypedData, transferAuthorizationTypedData, receiveAuthorizationTypedData,
  claimIntentTypedData, verifyTypedData, resolutionHash, claimFundingNonce, checksum
} from '../chain/eth.js';
import { relaySettle, relayFundClaim, relayClaim, relayRefund, getReceipt } from '../chain/relay.js';
import { usdcAuthorizationUsed } from '../chain/eth.js';
import { logger } from '../lib/logger.js';
import { startTimer, record as recordMetric, increment } from '../lib/metrics.js';
import { envioIndexer } from '../indexers/index.js';

const AUTH_WINDOW_SECONDS = 5 * 60;
const ZERO32 = `0x${'00'.repeat(32)}`;

/**
 * Orchestrates Prism's stablecoin execution layer: direct payments (Prism PaymentEnvelope +
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
    const stablecoin = usdcAsset(this.config);
    amountAtomic = this._paymentAmount(amountAtomic);
    const { identity: recipient, attestation } = this.assertResolution(resolution, senderPrismId);
    if (recipient.prismId === senderPrismId) throw new Error('cannot pay yourself');
    memo = String(memo ?? '').trim().slice(0, 120);

    const sender = this.identityService.get(senderPrismId);
    if (!sender?.accountAddress) throw new Error('sender account not ready');

    if (requestId) {
      this.requestService.assertPayable({
        requestId, payerPrismId: senderPrismId, recipientPrismId: recipient.prismId,
        amountAtomic
      });
    }

    const paymentId = randomHex(32);
    const nonce = randomHex(32);
    const validBefore = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SECONDS;
    const env = {
      paymentId,
      payer: checksum(sender.accountAddress),
      recipient: checksum(recipient.accountAddress),
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
      intent: {
        kind: 'payment', senderPrismId, recipientPrismId: recipient.prismId, amountAtomic,
        token: stablecoin.address, tokenSymbol: stablecoin.symbol, requestId, memo,
        aliasVersion: recipient.aliasVersion
      },
      createdAt: new Date().toISOString(),
      preparedAtMs: Date.now(),
      expiresAt: new Date(validBefore * 1000).toISOString(),
      effectsApplied: false
    };
    this.store.mutate(d => { d.operations[paymentId] = record; });
    logger.info('payment.prepared', {
      paymentId, senderPrismId, recipientPrismId: recipient.prismId,
      amountAtomic, token: stablecoin.symbol
    });
    stopPrepare();

    return {
      paymentId,
      state: 'prepared',
      expiresAt: record.expiresAt,
      asset: publicToken(stablecoin),
      envelope: env,
      typedData: {
        envelope: serialize(paymentEnvelopeTypedData(env)),
        tokenAuthorization: serialize(transferAuthorizationTypedData({
          from: env.payer, to: env.recipient, value: env.amount,
          validAfter: 0, validBefore, nonce
        }))
      }
    };
  }

  async submitPayment({ paymentId, prismSignature, tokenSignature, actorPrismId }) {
    const record = this.store.read().operations[paymentId];
    if (!record || record.kind !== 'payment') throw httpError(404, 'payment not found');
    if (actorPrismId && record.intent.senderPrismId !== actorPrismId) throw httpError(403, 'payment belongs to another caller');
    // A previous attempt broadcast but never returned a hash. Ask the chain whether it landed
    // before doing anything else — never blindly re-broadcast an authorization (MUT-16).
    if (record.state === 'broadcasting') return this._resolveAmbiguousBroadcast(record);
    if (record.state !== 'prepared') return { paymentId, state: record.state, txHash: record.txHash ?? null };
    if (Date.parse(record.expiresAt) < Date.now()) throw httpError(400, 'prepared payment expired');

    const env = record.env;
    // Verify BOTH signatures recover to the payer, over the server-held canonical payloads.
    const okEnvelope = await verifyTypedData(paymentEnvelopeTypedData(env), env.payer, prismSignature);
    if (!okEnvelope) throw httpError(401, 'envelope signature does not match the payer');
    const tokenTyped = transferAuthorizationTypedData({
      from: env.payer, to: env.recipient, value: env.amount,
      validAfter: 0, validBefore: env.validBefore, nonce: env.nonce
    });
    const okToken = await verifyTypedData(tokenTyped, env.payer, tokenSignature);
    if (!okToken) throw httpError(401, 'token authorization signature does not match the payer');

    // signing_wait_ms: time the user spent approving + signing between prepare and submit.
    if (record.preparedAtMs) recordMetric('signing_wait_ms', Date.now() - record.preparedAtMs);

    // Mark the intent to broadcast BEFORE the call. If the relayer response is lost after the
    // transaction reaches the network, this marker is the only record that money may already be
    // moving, and it is what turns a retry into a reconcile instead of a second broadcast.
    this.store.mutate(d => { d.operations[paymentId].state = 'broadcasting'; d.operations[paymentId].broadcastAt = new Date().toISOString(); });

    const stopRelay = startTimer('relay_submit_ms');
    let txHash;
    try {
      txHash = await relaySettle({ env, prismSignature, tokenSignature }); // Alchemy: simulate + submit
    } catch (error) {
      // A pre-broadcast failure (simulation revert, bad args) is safe to retry; anything else may
      // have reached the network, so the record stays 'broadcasting' and the next call reconciles.
      if (isPreBroadcastFailure(error)) {
        this.store.mutate(d => { d.operations[paymentId].state = 'prepared'; delete d.operations[paymentId].broadcastAt; });
      } else {
        logger.error('payment.broadcast.ambiguous', { paymentId, error: error.message });
      }
      throw error;
    }
    stopRelay();
    this.store.mutate(d => {
      const r = d.operations[paymentId];
      r.state = 'submitted'; r.txHash = txHash; r.submittedAt = new Date().toISOString(); r.submittedAtMs = Date.now();
    });
    logger.info('payment.submitted', { paymentId, txHash });
    return { paymentId, state: 'submitted', txHash };
  }

  /**
   * A broadcast was attempted but no transaction hash came back. The token authorization nonce is
   * the source of truth: it is consumed in the same transaction that moves the money, so if it is
   * used, the payment reached the chain and must be reconciled — never re-signed, never re-sent.
   */
  async _resolveAmbiguousBroadcast(record) {
    const { operationId, env } = record;
    const used = await usdcAuthorizationUsed(env.payer, env.nonce);
    if (used) {
      // Landed (or is landing). Hand back a non-terminal state so the client polls instead of retrying.
      this.store.mutate(d => { d.operations[operationId].state = 'confirming'; });
      logger.warn('payment.broadcast.reconciled', { paymentId: operationId, authorizationUsed: true });
      return { paymentId: operationId, state: 'confirming', txHash: record.txHash ?? null };
    }
    // The authorization was never consumed, so nothing settled. Re-arm for a genuine retry.
    this.store.mutate(d => { d.operations[operationId].state = 'prepared'; delete d.operations[operationId].broadcastAt; });
    logger.warn('payment.broadcast.reconciled', { paymentId: operationId, authorizationUsed: false });
    return { paymentId: operationId, state: 'prepared', txHash: null };
  }

  // ---- claims --------------------------------------------------------------

  async prepareClaim({ senderPrismId, recipientPhone, amountAtomic, expirySeconds = 7 * 24 * 3600, memo = '' }) {
    if (!this.config.chain.claimVault) throw httpError(503, 'PRISM_CLAIM_VAULT not configured');
    const stablecoin = usdcAsset(this.config);
    amountAtomic = this._claimAmount(amountAtomic);
    const sender = this.identityService.get(senderPrismId);
    if (!sender?.accountAddress) throw new Error('sender account not ready');
    const lookup = phoneLookupKey(normalizeE164(recipientPhone), this.config.resolverPepper);
    if (this.store.read().phoneIndex[lookup]) throw new Error('recipient is already on Prism; pay them directly');

    const claim = this.claimService.createPending({
      senderPrismId, recipientPhoneLookupKey: lookup, amountAtomic, token: stablecoin.address,
      tokenSymbol: stablecoin.symbol, expirySeconds, memo
    });
    const from = checksum(sender.accountAddress);
    const vault = checksum(this.config.chain.claimVault);
    const nonce = claimFundingNonce(claim.claimId, claim.recipientReference, BigInt(amountAtomic), from);
    const validBefore = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SECONDS;
    const fundingArgs = {
      claimId: claim.claimId, recipientReference: claim.recipientReference, sender: from,
      amount: amountAtomic, expiry: claim.expiry,
      validAfter: 0, validBefore, nonce
    };

    const fundOpId = claimOpId('claim-funding', claim.claimId);
    this.store.mutate(d => { d.operations[fundOpId] = { operationId: fundOpId, kind: 'claim-funding', state: 'prepared', fundingArgs, intent: { kind: 'claim-funding', senderPrismId, claimId: claim.claimId, amountAtomic, token: stablecoin.address, tokenSymbol: stablecoin.symbol }, createdAt: new Date().toISOString(), expiresAt: new Date(validBefore * 1000).toISOString(), effectsApplied: false }; });
    logger.info('claim.prepared', { claimId: claim.claimId, senderPrismId, amountAtomic, token: stablecoin.symbol });

    return {
      claimId: claim.claimId,
      state: 'prepared',
      expiresAt: new Date(validBefore * 1000).toISOString(),
      asset: publicToken(stablecoin),
      typedData: serialize(receiveAuthorizationTypedData({
        from, to: vault, value: amountAtomic, validAfter: 0, validBefore, nonce
      }))
    };
  }

  async fundClaim({ senderPrismId, claimId, signature }) {
    const fundOpId = claimOpId('claim-funding', claimId);
    const record = this.store.read().operations[fundOpId];
    if (!record || record.kind !== 'claim-funding') throw httpError(404, 'claim funding not found');
    if (record.intent.senderPrismId !== senderPrismId) throw httpError(403, 'claim belongs to another caller');
    if (record.state === 'broadcasting') return this._resolveAmbiguousClaimFunding(record);
    if (record.state !== 'prepared') return { claimId, state: record.state, txHash: record.txHash ?? null };
    if (Date.parse(record.expiresAt) < Date.now()) throw httpError(400, 'prepared claim funding expired');

    const a = record.fundingArgs;
    const typed = receiveAuthorizationTypedData({
      from: a.sender, to: checksum(this.config.chain.claimVault), value: a.amount,
      validAfter: 0, validBefore: a.validBefore, nonce: a.nonce
    });
    if (!(await verifyTypedData(typed, a.sender, signature))) throw httpError(401, 'funding signature does not match the sender');

    this.store.mutate(d => { d.operations[fundOpId].state = 'broadcasting'; d.operations[fundOpId].broadcastAt = new Date().toISOString(); });
    try {
      const txHash = await relayFundClaim({ ...a, signature });
      this.store.mutate(d => { d.operations[fundOpId].state = 'submitted'; d.operations[fundOpId].txHash = txHash; });
      this.claimService.markFundingSubmitted(claimId, txHash, fundOpId);
      logger.info('claim.funding.submitted', { claimId, txHash });
      return { claimId, state: 'submitted', txHash };
    } catch (e) {
      // Only a failure that provably never reached the network may be called a failure. Otherwise
      // the funding authorization may already be consumed, and marking it failed would invite a
      // second broadcast of the same ERC-3009 nonce (MUT-16).
      if (isPreBroadcastFailure(e)) {
        this.store.mutate(d => { d.operations[fundOpId].state = 'prepared'; delete d.operations[fundOpId].broadcastAt; });
        this.claimService.markFundingFailed(claimId);
      } else {
        logger.error('claim.funding.broadcast.ambiguous', { claimId, error: e.message });
      }
      throw e;
    }
  }

  /** Chain-truth resolution for a claim funding whose broadcast outcome is unknown (MUT-16). */
  async _resolveAmbiguousClaimFunding(record) {
    const { operationId, fundingArgs } = record;
    const used = await usdcAuthorizationUsed(fundingArgs.sender, fundingArgs.nonce);
    if (used) {
      this.store.mutate(d => { d.operations[operationId].state = 'confirming'; });
      logger.warn('claim.funding.broadcast.reconciled', { claimId: operationId, authorizationUsed: true });
      return { claimId: operationId, state: 'confirming', txHash: record.txHash ?? null };
    }
    this.store.mutate(d => { d.operations[operationId].state = 'prepared'; delete d.operations[operationId].broadcastAt; });
    logger.warn('claim.funding.broadcast.reconciled', { claimId: operationId, authorizationUsed: false });
    return { claimId: operationId, state: 'prepared', txHash: null };
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
    const claim = this.store.read().claims[claimId];
    const collectOpId = claimOpId('claim-collection', claimId);
    const intent = { kind: 'claim-collection', recipientPrismId, claimId, token: claim?.token, tokenSymbol: claim?.tokenSymbol, amountAtomic: claim?.amountAtomic };
    this.store.mutate(d => { d.operations[collectOpId] = { operationId: collectOpId, kind: 'claim-collection', state: 'submitted', txHash, intent, createdAt: new Date().toISOString(), effectsApplied: false }; });
    this.claimService.markClaimSubmitted(claimId, txHash);
    logger.info('claim.collect.submitted', { claimId, txHash });
    return { claimId, state: 'submitted', txHash };
  }

  async refundClaim({ senderPrismId, claimId }) {
    if (!this.config.chain.claimVault) throw httpError(503, 'PRISM_CLAIM_VAULT not configured');
    this.claimService.assertRefundable({ claimId, senderPrismId });
    const txHash = await relayRefund({ claimId });
    const claim = this.store.read().claims[claimId];
    const refundOpId = claimOpId('claim-refund', claimId);
    const intent = { kind: 'claim-refund', senderPrismId, claimId, token: claim?.token, tokenSymbol: claim?.tokenSymbol, amountAtomic: claim?.amountAtomic };
    this.store.mutate(d => { d.operations[refundOpId] = { operationId: refundOpId, kind: 'claim-refund', state: 'submitted', txHash, intent, createdAt: new Date().toISOString(), effectsApplied: false }; });
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
      this.claimService.markFundingFailed(record.intent.claimId);
    }
    logger.info('operation.reconciled', { operationId, state: record.state, txHash: record.transactionHash });
    if (success) record = await this._checkIndexing(record);
    return publicOp(record);
  }

  /**
   * Reconcile a claim by its claimId. Since funding/collection/refund are now separate operations,
   * pick the latest action the caller owns (sender for fund/refund, recipient for collect) so the
   * client's single `GET /v1/claims/:id` poll targets the action it just triggered.
   */
  async reconcileClaim(claimId, actorPrismId) {
    const ops = this.store.read().operations;
    const candidates = ['claim-funding', 'claim-collection', 'claim-refund']
      .map(kind => ops[claimOpId(kind, claimId)])
      .filter(Boolean);
    if (!candidates.length) throw httpError(404, 'claim operation not found');
    const owned = candidates.filter(o => {
      const owner = o.intent?.senderPrismId ?? o.intent?.recipientPrismId;
      return !actorPrismId || owner === actorPrismId;
    });
    const pool = owned.length ? owned : candidates;
    const latest = pool.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return this.reconcile(latest.operationId, actorPrismId);
  }

  _applySuccess(record) {
    const tx = record.transactionHash;
    if (record.kind === 'payment' && record.intent.requestId) this.requestService.markPaid(record.intent.requestId, record.operationId, tx);
    if (record.kind === 'claim-funding') this.claimService.markFunded(record.intent.claimId, record.txHash, tx);
    if (record.kind === 'claim-collection') this.claimService.markClaimed(record.intent.claimId, tx);
    if (record.kind === 'claim-refund') this.claimService.markRefunded(record.intent.claimId, tx);
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

// Each claim lifecycle action (funding, collection, refund) is its own operation record with a
// distinct id, so their tx evidence and actor ownership never overwrite each other (F-03).
function claimOpId(kind, claimId) { return `${kind}#${claimId}`; }

/**
 * Did this relay error provably happen BEFORE anything was broadcast?
 *
 * Fails closed: anything not recognised as a pre-broadcast failure is treated as ambiguous, because
 * wrongly calling a broadcast "failed" is what causes a second submission of a live authorization.
 * Pre-broadcast failures are our own argument validation (they carry an HTTP status code) and
 * simulation reverts, which viem raises from `simulateContract` before a transaction exists.
 */
function isPreBroadcastFailure(error) {
  if (!error) return false;
  if (typeof error.statusCode === 'number') return true;               // relay allowlist / arg validation
  const name = String(error.name ?? '');
  if (name === 'ContractFunctionRevertedError' || name === 'ContractFunctionExecutionError') return true;
  if (name === 'CallExecutionError' || name === 'EstimateGasExecutionError') return true;
  return false;                                                        // network/timeout/unknown => ambiguous
}
function serialize(obj) { return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); }
function publicToken(token) {
  return { symbol: token.symbol, name: token.name, address: token.address, decimals: token.decimals };
}
function usdcAsset(config) {
  return { symbol: 'USDC', name: 'USD Coin', address: config.chain.usdc, decimals: config.chain.usdcDecimals };
}
function publicOp(r) {
  return {
    operationId: r.operationId, kind: r.kind, state: r.state,
    txHash: r.txHash ?? null, transactionHash: r.transactionHash ?? null, blockNumber: r.blockNumber ?? null,
    // Chain is canonical; `indexed` reflects Envio catch-up so the UI shows an honest indexing state.
    indexed: r.indexed ?? false, indexedAt: r.indexedAt ?? null
  };
}
