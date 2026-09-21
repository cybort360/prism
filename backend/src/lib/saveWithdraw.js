import { getAddress } from 'viem';
import { verifyTypedData } from '../chain/eth.js';

// Prism Save — withdrawal. Saving is not complete until money can return to spendable USDC:
//   earnAUSD → AUSD → USDC → the user's normal Prism available balance.
// A normal consumer is never left holding AUSD unless they intentionally choose an advanced AUSD option.
//
// This module carries the withdrawal INTENT (what the user authorizes), the reconciliation that decides
// the true outcome from evidence, the claimability read (from chain, never a local timer), the failure
// classifier, and the CRITICAL recovery state (AUSD received but AUSD→USDC not yet converted — never
// "failed", never stranded). All monetary values are integer base-unit strings.

const lc = (v) => String(v ?? '').toLowerCase();
const big = (v) => BigInt(String(v ?? '0'));

export const WithdrawMode = Object.freeze({ INSTANT: 'INSTANT', STANDARD: 'STANDARD' });

// ---- Intent (authorization) ------------------------------------------------

const WITHDRAW_INTENT_FIELDS = [
  { name: 'owner', type: 'address' },
  { name: 'mode', type: 'string' },          // INSTANT | STANDARD
  { name: 'vault', type: 'address' },         // earnAUSD vault
  { name: 'shareToken', type: 'address' },    // earnAUSD share token
  { name: 'maxShares', type: 'uint256' },     // upper bound of shares to redeem
  { name: 'minAUSDOut', type: 'uint256' },
  { name: 'minUSDCOut', type: 'uint256' },
  { name: 'receiver', type: 'address' },       // MUST be the owner (money returns to the user)
  { name: 'quoteId', type: 'bytes32' },
  { name: 'deadline', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'chainId', type: 'uint256' }
];

export function withdrawIntentTypedData(intent, { verifyingContract }) {
  return {
    domain: { name: 'PrismSaveWithdraw', version: '1', chainId: Number(intent.chainId), verifyingContract: getAddress(verifyingContract) },
    primaryType: 'WithdrawIntent',
    types: { WithdrawIntent: WITHDRAW_INTENT_FIELDS },
    message: {
      owner: getAddress(intent.owner), mode: String(intent.mode), vault: getAddress(intent.vault),
      shareToken: getAddress(intent.shareToken), maxShares: BigInt(intent.maxShares),
      minAUSDOut: BigInt(intent.minAUSDOut), minUSDCOut: BigInt(intent.minUSDCOut), receiver: getAddress(intent.receiver),
      quoteId: intent.quoteId, deadline: BigInt(intent.deadline), nonce: intent.nonce, chainId: BigInt(intent.chainId)
    }
  };
}

export async function verifyWithdrawIntentSignature(intent, signature, { verifyingContract }) {
  try { return await verifyTypedData(withdrawIntentTypedData(intent, { verifyingContract }), intent.owner, signature); }
  catch { return false; }
}

export function validateWithdrawIntent(intent, { save, expectedOwner, maxShares, now = Math.floor(Date.now() / 1000) }) {
  const v = [];
  if (lc(intent.owner) !== lc(expectedOwner)) v.push('owner_mismatch');
  if (lc(intent.receiver) !== lc(expectedOwner)) v.push('receiver_not_owner');
  if (intent.mode !== WithdrawMode.INSTANT && intent.mode !== WithdrawMode.STANDARD) v.push('bad_mode');
  if (lc(intent.vault) !== lc(save.earnAusdVault)) v.push('vault_not_verified_earnausd');
  if (Number(intent.chainId) !== Number(save.substrateChainId)) v.push('wrong_chain');
  if (big(intent.maxShares) <= 0n || big(intent.maxShares) > big(maxShares)) v.push('shares_out_of_bounds');
  if (big(intent.minAUSDOut) <= 0n) v.push('missing_min_ausd');
  // A STANDARD (queued) withdraw only guarantees AUSD at claim time; the USDC floor applies to the
  // instant path and to the final conversion. Both paths still require a USDC floor for the conversion leg.
  if (big(intent.minUSDCOut) <= 0n) v.push('missing_min_usdc');
  if (!(Number(intent.deadline) > now)) v.push('expired_intent');
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(intent.nonce))) v.push('bad_nonce');
  return { ok: v.length === 0, violations: v };
}

// ---- Withdraw-mode quote ---------------------------------------------------

/**
 * Build the two withdraw modes for the screen. A mode is only "available" when its economics were
 * actually observed from the vault — a fee/estimate is NEVER invented, and "free" is never shown unless
 * observed (an absent fee stays null, not 0). Money fields are integer base-unit strings.
 *
 * @param {object} p
 * @param {string} p.sharesAtomic
 * @param {object|null} p.instant  { estimatedUSDCAtomic, vaultFeeAtomic, conversionCostAtomic } when observed
 * @param {object|null} p.standard { estimatedUSDCAtomic, processingWindow } when observed
 */
export function withdrawModes({ sharesAtomic, instant = null, standard = null, live = false } = {}) {
  return {
    live,
    sharesAtomic: String(sharesAtomic ?? '0'),
    instant: instant
      ? { available: true, estimatedUSDCAtomic: String(instant.estimatedUSDCAtomic), vaultFeeAtomic: instant.vaultFeeAtomic ?? null, conversionCostAtomic: instant.conversionCostAtomic ?? null, note: 'Available now' }
      : { available: false, reason: 'Instant withdrawal is not available on this deployment' },
    standard: standard
      ? { available: true, estimatedUSDCAtomic: String(standard.estimatedUSDCAtomic), processingWindow: standard.processingWindow ?? 'Up to 72 hours' }
      : { available: false, reason: 'Standard withdrawal is not available on this deployment' }
  };
}

// ---- Reconciliation --------------------------------------------------------

export const WithdrawOutcome = Object.freeze({
  AVAILABLE: 'AVAILABLE',                    // USDC reached the user — done
  QUEUED: 'QUEUED',                          // request recorded, waiting on the vault
  CLAIMABLE: 'CLAIMABLE',                    // vault says it can be claimed now
  RECOVERY_AUSD_HELD: 'RECOVERY_AUSD_HELD',  // AUSD is safe with the user; AUSD→USDC conversion pending
  FAILED: 'FAILED',
  REQUIRES_RECONCILIATION: 'REQUIRES_RECONCILIATION'
});

/**
 * Decide the true outcome of a withdraw execution from CANONICAL evidence.
 * evidence: { txStatus:'success'|'failed'|'unknown', sharesRedeemedAtomic, ausdReceivedAtomic,
 *             usdcReceivedAtomic, usdcReceiver }
 */
export function reconcileWithdrawEvidence(evidence, intent) {
  if (!evidence || evidence.txStatus === 'unknown') return { outcome: WithdrawOutcome.REQUIRES_RECONCILIATION, reasons: ['broadcast_unknown'] };
  if (evidence.txStatus === 'failed') return { outcome: WithdrawOutcome.FAILED, reasons: ['tx_reverted'] };

  const shares = big(evidence.sharesRedeemedAtomic);
  const ausd = big(evidence.ausdReceivedAtomic);
  const usdc = big(evidence.usdcReceivedAtomic);
  const toUser = lc(evidence.usdcReceiver ?? '') === lc(intent.receiver ?? '');

  if (shares <= 0n) return { outcome: WithdrawOutcome.FAILED, reasons: ['no_shares_redeemed'] };

  // Full success: USDC reached the user above the floor.
  if (usdc >= big(intent.minUSDCOut) && toUser && ausd >= big(intent.minAUSDOut)) {
    return { outcome: WithdrawOutcome.AVAILABLE, reasons: [] };
  }
  // CRITICAL recovery: the AUSD was redeemed and is safe with the user, but the AUSD→USDC conversion has
  // not completed. This is NOT a failure and NEVER strands funds — the savings were withdrawn.
  if (ausd >= big(intent.minAUSDOut) && (usdc < big(intent.minUSDCOut))) {
    return { outcome: WithdrawOutcome.RECOVERY_AUSD_HELD, reasons: ['ausd_conversion_incomplete'], ausdHeldAtomic: evidence.ausdReceivedAtomic };
  }
  return { outcome: WithdrawOutcome.FAILED, reasons: ['below_minimums_or_wrong_receiver'] };
}

// ---- Claimability (from chain, never a local timer) ------------------------

/** Claimability is read from verified vault/on-chain state, not a 72h local timer. An unknown state is
 *  treated as still QUEUED (never optimistically claimable). */
export function classifyClaimable(vaultRequestState) {
  if (!vaultRequestState?.known) return WithdrawOutcome.QUEUED;
  return vaultRequestState.claimable === true ? WithdrawOutcome.CLAIMABLE : WithdrawOutcome.QUEUED;
}

// ---- Failure classifier ----------------------------------------------------

export const WithdrawFailure = Object.freeze({
  INSTANT_UNAVAILABLE: 'instant_unavailable',   // → offer Standard
  FEE_CHANGED: 'fee_changed',                    // → requote
  SUBMISSION_AMBIGUOUS: 'submission_ambiguous',  // → reconcile, no duplicate request
  STILL_QUEUED: 'still_queued',                  // → wait
  CONVERSION_FAILED_AFTER_CLAIM: 'conversion_failed_after_claim', // → AUSD recovery state
  SWAP_UNAVAILABLE: 'swap_unavailable',          // → AUSD owned by user, retry conversion
  INSUFFICIENT_SHARES: 'insufficient_shares',    // → refresh current state
  VAULT_PAUSED: 'vault_paused'                   // → truthful unavailable
});

const FAILURE_ACTION = {
  instant_unavailable: 'offer_standard',
  fee_changed: 'requote',
  submission_ambiguous: 'reconcile_no_duplicate',
  still_queued: 'wait',
  conversion_failed_after_claim: 'ausd_recovery',
  swap_unavailable: 'retry_conversion',
  insufficient_shares: 'refresh_state',
  vault_paused: 'unavailable'
};

/** Map a detected condition to its recovery action. Every failure has a truthful next step; none strands. */
export function withdrawFailureAction(failure) {
  return FAILURE_ACTION[failure] ?? 'reconcile_no_duplicate';
}
