import { randomHex } from '../lib/crypto.js';
import { signClaimEligibility, claimAuthorizerAddress } from '../chain/eth.js';

export class ClaimService {
  constructor({ store, config, identityService }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
  }

  // The claim authorizer is now an isolated secp256k1 key (KMS/HSM in production); the vault
  // verifies its signatures with ecrecover. Exposes only the public address.
  authorizerAddress() {
    try { return claimAuthorizerAddress(); } catch { return null; }
  }

  createPending({ senderPrismId, recipientPhoneLookupKey, amountAtomic, token, tokenSymbol, expirySeconds = 7 * 24 * 3600, memo = '' }) {
    if (!/^\d+$/.test(String(amountAtomic)) || BigInt(amountAtomic) <= 0n) throw new Error('claim amount must be positive');
    if (BigInt(amountAtomic) > this.config.limits.maxClaimAtomic) throw new Error('claim exceeds Prism pre-user limit');
    const boundedExpiry = Math.min(Math.max(Number(expirySeconds), 3600), 14 * 24 * 3600);
    const claim = {
      claimId: randomHex(32),
      recipientReference: randomHex(32),
      senderPrismId,
      recipientPhoneLookupKey,
      amountAtomic: String(amountAtomic),
      token,
      tokenSymbol,
      memo: String(memo ?? '').trim().slice(0, 120),
      expiry: Math.floor(Date.now() / 1000) + boundedExpiry,
      status: 'created',
      createdAt: new Date().toISOString()
    };
    return this.store.mutate(data => { data.claims[claim.claimId] = claim; return claim; });
  }

  markFundingSubmitted(claimId, fundingTxHash, operationId) {
    return this._update(claimId, c => {
      c.status = 'funding_submitted';
      c.fundingTxHash = fundingTxHash;
      c.fundingOperationId = operationId;
      c.updatedAt = new Date().toISOString();
    });
  }

  markFunded(claimId, fundingTxHash, transactionHash) {
    return this._update(claimId, c => {
      c.status = 'funded';
      c.fundingTxHash = fundingTxHash;
      c.fundingTransactionHash = transactionHash ?? null;
      c.fundedAt = new Date().toISOString();
    });
  }

  markFundingFailed(claimId) {
    return this._update(claimId, c => {
      if (c.status === 'created' || c.status === 'funding_submitted') c.status = 'funding_failed';
      c.updatedAt = new Date().toISOString();
    });
  }

  markClaimed(claimId, transactionHash) {
    return this._update(claimId, c => {
      c.status = 'claimed';
      c.claimTransactionHash = transactionHash ?? null;
      c.claimedAt = new Date().toISOString();
    });
  }

  markRefunded(claimId, transactionHash) {
    return this._update(claimId, c => {
      c.status = 'refunded';
      c.refundTransactionHash = transactionHash ?? null;
      c.refundedAt = new Date().toISOString();
    });
  }

  eligibleClaimsFor(identity) {
    if (!identity?.phoneLookupKey) return [];
    const now = Math.floor(Date.now() / 1000);
    return Object.values(this.store.read().claims)
      .filter(c => c.recipientPhoneLookupKey === identity.phoneLookupKey && c.status === 'funded' && c.expiry >= now)
      .map(publicClaim);
  }

  listFor(identity) {
    if (!identity) return [];
    const now = Math.floor(Date.now() / 1000);
    return Object.values(this.store.read().claims)
      .filter(c => c.senderPrismId === identity.prismId || (identity.phoneLookupKey && c.recipientPhoneLookupKey === identity.phoneLookupKey))
      .map(c => ({ ...publicClaim(c), refundAvailable: c.senderPrismId === identity.prismId && c.status === 'funded' && c.expiry < now }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  assertRefundable({ claimId, senderPrismId }) {
    const c = this.store.read().claims[claimId];
    if (!c) throw new Error('claim not found');
    if (c.senderPrismId !== senderPrismId) throw new Error('not claim sender');
    if (c.status !== 'funded') throw new Error('claim is not funded');
    if (c.expiry >= Math.floor(Date.now() / 1000)) throw new Error('claim has not expired');
    return c;
  }

  /**
   * Issue a short-lived eligibility authorization for a recipient who has proven alias control.
   * The isolated authorizer key signs an EIP-712 ClaimEligibility; the vault verifies it AND the
   * recipient's own Mera-account ClaimIntent, so possession of an alias alone never releases funds.
   */
  async issueEligibility({ claimId, recipientPrismId }) {
    if (!this.config.chain.claimVault) throw new Error('PRISM_CLAIM_VAULT not configured');
    const identity = this.identityService.get(recipientPrismId);
    if (!identity?.accountAddress) throw new Error('recipient account not ready');
    const claim = this.store.read().claims[claimId];
    if (!claim || claim.status !== 'funded') throw new Error('claim not funded');
    if (claim.expiry < Math.floor(Date.now() / 1000)) throw new Error('claim expired');
    if (!identity.phoneLookupKey || claim.recipientPhoneLookupKey !== identity.phoneLookupKey) throw new Error('claim not eligible for this alias');

    const eligibilityNonce = randomHex(32);
    const eligibilityExpiry = Math.floor(Date.now() / 1000) + 5 * 60;
    const authorizerSig = await signClaimEligibility({
      claimId,
      recipient: identity.accountAddress,
      aliasVersion: identity.aliasVersion,
      expiry: eligibilityExpiry,
      nonce: eligibilityNonce
    });
    return {
      claimId,
      recipient: identity.accountAddress,
      aliasVersion: identity.aliasVersion,
      eligibilityExpiry,
      eligibilityNonce,
      authorizerSig
    };
  }

  markClaimSubmitted(claimId, txHash) {
    return this._update(claimId, c => { c.status = 'claim_submitted'; c.claimTxHash = txHash; c.updatedAt = new Date().toISOString(); });
  }
  markRefundSubmitted(claimId, txHash) {
    return this._update(claimId, c => { c.status = 'refund_submitted'; c.refundTxHash = txHash; c.updatedAt = new Date().toISOString(); });
  }

  _update(claimId, fn) {
    return this.store.mutate(data => {
      const c = data.claims[claimId];
      if (!c) throw new Error('claim not found');
      fn(c);
      return c;
    });
  }
}

function publicClaim(c) {
  return {
    claimId: c.claimId,
    recipientReference: c.recipientReference,
    senderPrismId: c.senderPrismId,
    amountAtomic: c.amountAtomic,
    token: c.token,
    tokenSymbol: c.tokenSymbol ?? null,
    memo: c.memo ?? '',
    expiry: c.expiry,
    status: c.status,
    createdAt: c.createdAt,
    fundingTransactionHash: c.fundingTransactionHash ?? null,
    claimTransactionHash: c.claimTransactionHash ?? null,
    refundTransactionHash: c.refundTransactionHash ?? null
  };
}
