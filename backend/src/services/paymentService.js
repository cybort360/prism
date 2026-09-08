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
import { appendEvent, ensureEvents, canonicalPayment, receiptFor, lifecycleState, assertTransition } from '../lib/lifecycle.js';
import { assertFreshResolution } from '../lib/continuity.js';

const AUTH_WINDOW_SECONDS = 5 * 60;
// Operation kinds settled through PrismPaymentRouter.settle(). Both are a signed PaymentEnvelope
// plus an ERC-3009 receive-authorization; they differ only in what the opaque hash slot binds —
// a Prism resolution for a direct payment, an Aurora route for a cross-chain send.
const SETTLE_KINDS = new Set(['payment', 'aurora-send']);
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
    // Continuity enforcement: the signed attestation must still match the LIVE identity (same account
    // AND same alias version). Delegated to the shared continuity model (assertFreshResolution) so the
    // enforcement path and the domain classifier can never drift. STALE_RESOLUTION / mismatch → 409.
    if (!assertFreshResolution(a, identity).ok) {
      const e = new Error('stale or changed recipient identity');
      e.statusCode = 409;
      throw e;
    }
    return { identity, attestation: a };
  }

  // ---- direct payments -----------------------------------------------------

  async preparePayment({ senderPrismId, resolution, amountAtomic, requestId = null, memo = '', entryMethod = null }) {
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
        aliasVersion: recipient.aliasVersion,
        // entryMethod is a client hint (qr | paymentLink | contact); route comes from the resolver.
        entryMethod: entryMethod ?? null, route: attestation.route ?? null,
        resolutionRequestId: attestation.requestId
      },
      events: [],
      createdAt: new Date().toISOString(),
      preparedAtMs: Date.now(),
      expiresAt: new Date(validBefore * 1000).toISOString(),
      effectsApplied: false
    };
    appendEvent(record, { state: 'created', source: 'app', title: 'Payment created' });
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
        // Receive-authorization addressed to the router (not the recipient): only the router can
        // consume it, so the settlement can't be bypassed by submitting the auth directly (F-01).
        tokenAuthorization: serialize(receiveAuthorizationTypedData({
          from: env.payer, to: checksum(this.config.chain.paymentRouter), value: env.amount,
          validAfter: 0, validBefore, nonce
        }))
      }
    };
  }

  /**
   * Prepare a payment to an address that is NOT a Prism identity.
   *
   * Used only by the cross-chain path, where the on-Monad recipient is an Aurora deposit address and
   * there is no identity to resolve. Everything else is identical to `preparePayment` — same
   * envelope, same ERC-3009 receive-authorization to the router, same relayer, same reconciliation —
   * so the money leg reuses the audited path rather than forking it.
   *
   * `boundHash` occupies the envelope's opaque hash slot and is what makes this safe to expose: the
   * caller must bind the meaning of the payment into it (see `routeHash`), so the payer's signature
   * covers the real destination and not merely the address the funds pass through. Callers are
   * responsible for that binding; this method deliberately has no opinion about its contents.
   */
  async prepareExternalSend({ senderPrismId, recipientAddress, amountAtomic, boundHash, kind, intent = {} }) {
    if (!this.config.chain.paymentRouter) throw httpError(503, 'PRISM_PAYMENT_ROUTER not configured');
    const stablecoin = usdcAsset(this.config);
    amountAtomic = this._paymentAmount(amountAtomic);

    const sender = this.identityService.get(senderPrismId);
    if (!sender?.accountAddress) throw new Error('sender account not ready');
    const recipient = checksum(recipientAddress);
    if (recipient.toLowerCase() === sender.accountAddress.toLowerCase()) throw httpError(400, 'cannot send to your own account');

    const paymentId = randomHex(32);
    const nonce = randomHex(32);
    const validBefore = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SECONDS;
    const env = {
      paymentId,
      payer: checksum(sender.accountAddress),
      recipient,
      amount: amountAtomic,
      requestId: ZERO32,
      resolutionHash: boundHash,
      validBefore,
      nonce
    };

    const record = {
      operationId: paymentId,
      kind,
      state: 'prepared',
      env,
      intent: {
        kind, senderPrismId, recipientPrismId: null, amountAtomic,
        token: stablecoin.address, tokenSymbol: stablecoin.symbol,
        requestId: null, memo: '', ...intent
      },
      events: [],
      createdAt: new Date().toISOString(),
      preparedAtMs: Date.now(),
      expiresAt: new Date(validBefore * 1000).toISOString(),
      effectsApplied: false
    };
    appendEvent(record, { state: 'created', source: 'app', title: 'Payment created' });
    this.store.mutate(d => { d.operations[paymentId] = record; });
    logger.info('payment.prepared.external', { paymentId, kind, senderPrismId, amountAtomic });

    return {
      paymentId,
      state: 'prepared',
      expiresAt: record.expiresAt,
      asset: publicToken(stablecoin),
      envelope: env,
      typedData: {
        envelope: serialize(paymentEnvelopeTypedData(env)),
        tokenAuthorization: serialize(receiveAuthorizationTypedData({
          from: env.payer, to: checksum(this.config.chain.paymentRouter), value: env.amount,
          validAfter: 0, validBefore, nonce
        }))
      }
    };
  }

  /**
   * Re-issue the signable payload for a payment that is still awaiting a signature.
   *
   * A client that lost the prepare response must be able to ask again without a second operation
   * being created — two live envelopes for one intent would both be signable, and only one of them
   * is the one anybody is tracking. Returns null when the payment has moved past `prepared`, so the
   * caller can refuse rather than hand out a payload for money that is already in flight.
   */
  resumePrepared(paymentId, actorPrismId) {
    const record = this.store.read().operations[paymentId];
    if (!record || !SETTLE_KINDS.has(record.kind)) return null;
    if (actorPrismId && record.intent?.senderPrismId !== actorPrismId) throw httpError(403, 'payment belongs to another caller');
    if (record.state !== 'prepared') return null;
    if (Date.parse(record.expiresAt) <= Date.now()) return null;

    const env = record.env;
    return {
      paymentId,
      state: 'prepared',
      expiresAt: record.expiresAt,
      asset: publicToken(usdcAsset(this.config)),
      envelope: env,
      typedData: {
        envelope: serialize(paymentEnvelopeTypedData(env)),
        tokenAuthorization: serialize(receiveAuthorizationTypedData({
          from: env.payer, to: checksum(this.config.chain.paymentRouter), value: env.amount,
          validAfter: 0, validBefore: env.validBefore, nonce: env.nonce
        }))
      }
    };
  }

  async submitPayment({ paymentId, prismSignature, tokenSignature, actorPrismId }) {
    const record = this.store.read().operations[paymentId];
    // Direct payments and cross-chain sends share this path: both are a signed PaymentEnvelope
    // settled through the router, and differ only in what their opaque hash slot binds.
    if (!record || !SETTLE_KINDS.has(record.kind)) throw httpError(404, 'payment not found');
    if (actorPrismId && record.intent.senderPrismId !== actorPrismId) throw httpError(403, 'payment belongs to another caller');
    // A previous attempt broadcast but never returned a hash. Ask the chain whether it landed
    // before doing anything else — never blindly re-broadcast an authorization (MUT-16).
    if (record.state === 'broadcasting' || record.state === 'requires_attention') return this._resolveAmbiguousBroadcast(record);
    if (record.state !== 'prepared') return { paymentId, state: record.state, txHash: record.txHash ?? null };
    if (Date.parse(record.expiresAt) < Date.now()) throw httpError(400, 'prepared payment expired');

    const env = record.env;
    // Verify BOTH signatures recover to the payer, over the server-held canonical payloads.
    const okEnvelope = await verifyTypedData(paymentEnvelopeTypedData(env), env.payer, prismSignature);
    if (!okEnvelope) throw httpError(401, 'envelope signature does not match the payer');
    const tokenTyped = receiveAuthorizationTypedData({
      from: env.payer, to: checksum(this.config.chain.paymentRouter), value: env.amount,
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
    this._event(paymentId, { state: 'authorized', source: 'userAuthorization', title: 'Authorized on device' });

    const stopRelay = startTimer('relay_submit_ms');
    let txHash;
    try {
      txHash = await relaySettle({ env, prismSignature, tokenSignature }); // Alchemy: simulate + submit
    } catch (error) {
      // A pre-broadcast failure (simulation revert, bad args) provably never reached the network, so
      // it is safe to re-arm for retry. Anything else is AMBIGUOUS — the tx may already be moving
      // money — so we enter requires_attention and NEVER blindly resubmit; the next call reconciles
      // from chain truth first.
      if (isPreBroadcastFailure(error)) {
        this._transitionPayment(paymentId, 'broadcasting', 'prepared', {
          extra: { broadcastAt: null }, failureCode: 'SUBMISSION_FAILED',
          event: { state: 'failedRetryable', source: 'relayer', title: 'Submission failed — safe to retry' }
        });
      } else {
        this._transitionPayment(paymentId, 'broadcasting', 'requires_attention', {
          failureCode: 'SUBMISSION_AMBIGUOUS',
          event: { state: 'requiresAttention', source: 'relayer', title: 'Checking whether this payment was submitted' }
        });
        logger.error('payment.broadcast.ambiguous', { paymentId, error: error.message });
      }
      throw error;
    }
    stopRelay();
    this.store.mutate(d => {
      const r = d.operations[paymentId];
      r.state = 'submitted'; r.txHash = txHash; r.submittedAt = new Date().toISOString(); r.submittedAtMs = Date.now();
    });
    this._event(paymentId, { state: 'submitted', source: 'relayer', title: 'Submitted to the network', evidence: txHash });
    logger.info('payment.submitted', { paymentId, txHash });
    return { paymentId, operationId: paymentId, state: 'submitted', txHash };
  }

  /**
   * A broadcast was attempted but no transaction hash came back. The token authorization nonce is
   * the source of truth: it is consumed in the same transaction that moves the money, so if it is
   * used, the payment reached the chain and must be reconciled — never re-signed, never re-sent.
   */
  async _resolveAmbiguousBroadcast(record) {
    const { operationId, env } = record;
    // Chain truth: the ERC-3009 nonce is consumed in the same tx that moves the money. Only after
    // PROVING absence (nonce unused) may a retry be re-armed — never a blind resubmit.
    const used = await usdcAuthorizationUsed(env.payer, env.nonce);
    if (used) {
      this._transitionPayment(operationId, record.state, 'confirming', {
        extra: { failureCode: null, failureMessage: null },
        event: { state: 'confirming', source: 'monad', title: 'Payment reached the chain — confirming' }
      });
      logger.warn('payment.broadcast.reconciled', { paymentId: operationId, authorizationUsed: true });
      return { paymentId: operationId, state: 'confirming', txHash: record.txHash ?? null };
    }
    this._transitionPayment(operationId, record.state, 'prepared', {
      extra: { broadcastAt: null, failureCode: null, failureMessage: null },
      event: { state: 'created', source: 'backend', title: 'Confirmed not submitted — safe to retry' }
    });
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
    this.store.mutate(d => { d.operations[fundOpId] = { operationId: fundOpId, kind: 'claim-funding', state: 'prepared', fundingArgs, intent: { kind: 'claim-funding', senderPrismId, claimId: claim.claimId, amountAtomic, token: stablecoin.address, tokenSymbol: stablecoin.symbol }, events: [], createdAt: new Date().toISOString(), expiresAt: new Date(validBefore * 1000).toISOString(), effectsApplied: false }; });
    this._event(fundOpId, { state: 'created', source: 'app', title: 'Claim funding created' });
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
      this.store.mutate(d => { d.operations[fundOpId].state = 'submitted'; d.operations[fundOpId].txHash = txHash; d.operations[fundOpId].submittedAt = new Date().toISOString(); });
      this._event(fundOpId, { state: 'submitted', source: 'relayer', title: 'Claim funding submitted', evidence: txHash });
      this.claimService.markFundingSubmitted(claimId, txHash, fundOpId);
      logger.info('claim.funding.submitted', { claimId, txHash });
      return { claimId, operationId: fundOpId, state: 'submitted', txHash };
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
    this.store.mutate(d => { d.operations[collectOpId] = { operationId: collectOpId, kind: 'claim-collection', state: 'submitted', txHash, intent, events: [], createdAt: new Date().toISOString(), submittedAt: new Date().toISOString(), effectsApplied: false }; });
    this._event(collectOpId, { state: 'created', source: 'app', title: 'Claim collection created' });
    this._event(collectOpId, { state: 'submitted', source: 'relayer', title: 'Claim collection submitted', evidence: txHash });
    this.claimService.markClaimSubmitted(claimId, txHash);
    logger.info('claim.collect.submitted', { claimId, txHash });
    return { claimId, operationId: collectOpId, state: 'submitted', txHash };
  }

  async refundClaim({ senderPrismId, claimId }) {
    if (!this.config.chain.claimVault) throw httpError(503, 'PRISM_CLAIM_VAULT not configured');
    this.claimService.assertRefundable({ claimId, senderPrismId });
    const txHash = await relayRefund({ claimId });
    const claim = this.store.read().claims[claimId];
    const refundOpId = claimOpId('claim-refund', claimId);
    const intent = { kind: 'claim-refund', senderPrismId, claimId, token: claim?.token, tokenSymbol: claim?.tokenSymbol, amountAtomic: claim?.amountAtomic };
    this.store.mutate(d => { d.operations[refundOpId] = { operationId: refundOpId, kind: 'claim-refund', state: 'submitted', txHash, intent, events: [], createdAt: new Date().toISOString(), submittedAt: new Date().toISOString(), effectsApplied: false }; });
    this._event(refundOpId, { state: 'created', source: 'app', title: 'Refund created' });
    this._event(refundOpId, { state: 'submitted', source: 'relayer', title: 'Refund submitted', evidence: txHash });
    this.claimService.markRefundSubmitted(claimId, txHash);
    logger.info('claim.refund.submitted', { claimId, txHash });
    return { claimId, operationId: refundOpId, state: 'submitted', txHash };
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
      this._event(operationId, { state: 'confirming', source: 'monad', title: 'Confirming on Monad', evidence: record.txHash });
      return { operationId, state: 'confirming', txHash: record.txHash };
    }
    const success = receipt.status === 'success' || receipt.status === '0x1' || receipt.status === 1;
    const clearRevert = receipt.status === 'reverted' || receipt.status === '0x0' || receipt.status === 0 || receipt.status === false;
    if (!success && !clearRevert) {
      // The receipt is neither a clear success nor a clear revert — the providers disagree or returned
      // something unexpected. Never silently pick a convenient result: enter reconciliation.
      record = this._transitionPayment(operationId, record.state, 'reconciliation_required', {
        failureCode: 'PROVIDER_DISAGREEMENT',
        failureMessage: `indeterminate receipt status: ${String(receipt.status)}`,
        event: { state: 'requiresAttention', source: 'backend', title: 'Verifying final payment details' }
      });
      logger.warn('operation.reconciliation_required', { operationId, status: receipt.status });
      return publicOp(record);
    }
    // Guarded transition: submitted/confirming -> completed/failed only, driven by the real receipt.
    record = this._transitionPayment(operationId, record.state, success ? 'completed' : 'failed', {
      extra: {
        transactionHash: receipt.transactionHash ?? record.txHash,
        blockNumber: receipt.blockNumber ? receipt.blockNumber.toString() : null,
        completedAt: new Date().toISOString(), completedAtMs: Date.now()
      },
      event: success
        ? { state: 'confirmed', source: 'monad', title: 'Confirmed on-chain', evidence: receipt.transactionHash ?? record.txHash }
        : { state: 'reverted', source: 'monad', title: 'Reverted on-chain', evidence: record.txHash },
      failureCode: success ? null : 'TRANSACTION_REVERTED'
    });
    // Latency + failure-rate metrics for the payment path.
    if (SETTLE_KINDS.has(record.kind)) {
      increment('payment', success);
      if (success) {
        if (record.submittedAtMs) recordMetric('chain_confirmation_ms', record.completedAtMs - record.submittedAtMs);
        if (record.preparedAtMs) recordMetric('end_to_end_payment_ms', record.completedAtMs - record.preparedAtMs);
      }
    }
    if (success && !record.effectsApplied) {
      this._applySuccess(record);
      this.store.mutate(d => { d.operations[operationId].effectsApplied = true; });
      this._event(operationId, { state: 'reconciled', source: 'backend', title: 'Reconciled from chain state' });
      this._event(operationId, { state: 'completed', source: 'backend', title: 'Completed' });
      record = this.store.read().operations[operationId];
    } else if (!success) {
      this._event(operationId, { state: 'failedTerminal', source: 'monad', title: 'Failed on-chain' });
      if (record.kind === 'claim-funding') this.claimService.markFundingFailed(record.intent.claimId);
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

  /** Append an ordered lifecycle event to an operation, persisted so history survives a relaunch. */
  _event(operationId, spec) {
    this.store.mutate((d) => { const r = d.operations[operationId]; if (r) appendEvent(r, spec); });
  }

  /**
   * The one guarded state transition. Rejects an illegal transition (e.g. submitted -> completed
   * without confirmation, or any mutation of a terminal op) and an optimistic-lock mismatch, then
   * applies extra fields, records the failure code, and appends the lifecycle event — atomically.
   */
  _transitionPayment(operationId, expectedCurrentState, nextState, { extra = {}, event = null, failureCode = null, failureMessage = null } = {}) {
    let error = null;
    this.store.mutate((d) => {
      const r = d.operations[operationId];
      if (!r) { error = httpError(404, 'operation not found'); return; }
      if (expectedCurrentState != null && r.state !== expectedCurrentState) {
        error = httpError(409, `state changed: expected ${expectedCurrentState}, found ${r.state}`); return;
      }
      try { assertTransition(r.state, nextState); } catch (e) { error = e; return; }
      Object.assign(r, extra);
      r.state = nextState;
      if (failureCode) r.failureCode = failureCode;
      if (failureMessage) r.failureMessage = failureMessage;
      if (event) appendEvent(r, event);
    });
    if (error) throw error;
    return this.store.read().operations[operationId];
  }

  /** The canonical projection of an operation: { payment, events, receipt }. */
  canonicalFor(operationId, actorPrismId) {
    const op = this.store.read().operations[operationId];
    if (!op) throw httpError(404, 'operation not found');
    const owner = op.intent?.senderPrismId ?? op.intent?.recipientPrismId;
    if (actorPrismId && owner && owner !== actorPrismId) throw httpError(403, 'operation belongs to another caller');
    const claim = op.intent?.claimId ? this.store.read().claims[op.intent.claimId] : null;
    const route = op.intent?.routeId ? (this.store.read().auroraRoutes ?? {})[op.intent.routeId] : null;
    const ctx = { viewerPrismId: actorPrismId, identityService: this.identityService, claim, route };
    return { payment: canonicalPayment(op, ctx), events: ensureEvents(op), receipt: receiptFor(op, ctx) };
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
    if (!SETTLE_KINDS.has(record.kind) || record.state !== 'completed' || record.indexed) return record;
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
    this._event(record.operationId, { state: 'indexed', source: 'envio', title: 'Indexed by Envio' });
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

  /**
   * Any operation (payment, claim funding/collection/refund) for the canonical proof surface,
   * gated to a caller who owns/can see it. Reconciles live chain state first so the proof reflects
   * the latest confirmation, then returns the raw record for ProofService to assemble evidence from.
   */
  async proofOperation(operationId, actorPrismId) {
    let record = this.store.read().operations[operationId];
    if (!record) throw httpError(404, 'operation not found');
    const owner = record.intent?.senderPrismId ?? record.intent?.recipientPrismId;
    if (actorPrismId && owner && owner !== actorPrismId) throw httpError(403, 'operation belongs to another caller');
    try { await this.reconcile(operationId, actorPrismId); } catch { /* proof reflects last-known state on read failure */ }
    return this.store.read().operations[operationId];
  }

  /** Read-only accessors ProofService uses to assemble evidence without reaching into the store. */
  identity(prismId) { return this.identityService.get(prismId); }
  claim(claimId) { return claimId ? this.store.read().claims[claimId] : null; }

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
    indexed: r.indexed ?? false, indexedAt: r.indexedAt ?? null,
    lifecycleState: lifecycleState(r), events: ensureEvents(r)
  };
}
