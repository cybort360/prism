// Prism Save — execution policy gates, reconciliation, and the executor seam. Pure where possible.
//
// Nothing here ever marks a Save SAVED because a quote succeeded, an RPC accepted a tx, or a bundler
// accepted a UserOperation. SAVED requires canonical on-chain evidence (see `reconcileSaveEvidence`).

const big = (v) => BigInt(String(v ?? '0'));

/**
 * Validate a refreshed quote against Prism execution policy right before authorization. If the economics
 * are outside policy or the route can't settle, execution is BLOCKED — never silently attempted.
 *
 * @returns {{ ok: boolean, blockers: string[] }}
 */
export function validateExecutionQuote(quote, { policy, now = Date.now() } = {}) {
  const blockers = [];
  if (!quote) return { ok: false, blockers: ['no_quote'] };
  if (quote.live !== true || quote.planExecutable !== true) blockers.push('route_unavailable');
  const expires = Date.parse(quote.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) blockers.push('quote_expired');
  if (quote.vaultPaused === true) blockers.push('vault_paused');
  if (quote.vaultDepositCapReached === true) blockers.push('vault_deposit_capped');
  if (quote.priceImpactBps != null && policy?.maxPriceImpactBps != null && Number(quote.priceImpactBps) > policy.maxPriceImpactBps) blockers.push('price_impact_too_high');
  if (quote.slippageBps != null && policy?.maxSlippageBps != null && Number(quote.slippageBps) > policy.maxSlippageBps) blockers.push('slippage_too_high');
  if (quote.minimumAUSD == null || big(quote.minimumAUSD) <= 0n) blockers.push('missing_min_ausd');
  if (quote.minimumShares == null || big(quote.minimumShares) <= 0n) blockers.push('missing_min_shares');
  return { ok: blockers.length === 0, blockers };
}

export const SaveExecOutcome = Object.freeze({
  SAVED: 'SAVED', FAILED: 'FAILED', REQUIRES_RECONCILIATION: 'REQUIRES_RECONCILIATION'
});

/**
 * Decide the terminal outcome from CANONICAL evidence, never from acceptance. Evidence:
 *   { txStatus: 'success'|'failed'|'unknown', usdcDebitedAtomic, ausdConvertedAtomic,
 *     sharesMintedAtomic, sharesReceiver }
 * Intent supplies the floors the evidence must clear (maxInputUSDC, minAUSDOut, minSharesOut, receiver).
 */
export function reconcileSaveEvidence(evidence, intent) {
  const reasons = [];
  if (!evidence || evidence.txStatus === 'unknown') return { outcome: SaveExecOutcome.REQUIRES_RECONCILIATION, reasons: ['broadcast_unknown'] };
  if (evidence.txStatus === 'failed') return { outcome: SaveExecOutcome.FAILED, reasons: ['tx_reverted'] };

  const usdc = big(evidence.usdcDebitedAtomic);
  const ausd = big(evidence.ausdConvertedAtomic);
  const shares = big(evidence.sharesMintedAtomic);
  const receiverOk = String(evidence.sharesReceiver ?? '').toLowerCase() === String(intent.receiver ?? '').toLowerCase();

  if (usdc <= 0n || usdc > big(intent.maxInputUSDC)) reasons.push('usdc_debit_out_of_range');
  if (ausd < big(intent.minAUSDOut)) reasons.push('ausd_below_minimum');
  if (shares < big(intent.minSharesOut)) reasons.push('shares_below_minimum');
  if (!receiverOk) reasons.push('shares_not_to_owner');

  // A partial (USDC/AUSD moved but shares not minted to the user) is NOT a success and NOT a clean fail —
  // it needs recovery, so it fails closed to reconciliation rather than being hidden.
  if (reasons.length) {
    const movedButNoShares = usdc > 0n && ausd > 0n && shares < big(intent.minSharesOut);
    return { outcome: movedButNoShares ? SaveExecOutcome.REQUIRES_RECONCILIATION : SaveExecOutcome.FAILED, reasons };
  }
  return { outcome: SaveExecOutcome.SAVED, reasons: [] };
}

/** A broadcast whose status is unknown must not trigger another Save. */
export function isRetryable(operationState) {
  return operationState !== 'SUBMITTED' && operationState !== 'REQUIRES_RECONCILIATION';
}

/** The executor seam. A real executor validates the intent + quote, builds the minimal sponsored batch,
 *  submits one UserOperation, and reconciles from evidence. The preview executor announces itself and
 *  refuses, because the substrate is unverified and no route/batch account is live. */
export class PreviewSaveExecutor {
  constructor(config) { this.config = config; }
  available() { return this.config.save.substrateVerified === true; }
  async execute() {
    const e = new Error('Save execution is not enabled on this deployment: earnAUSD substrate is unverified (see docs/SAVE_DEPENDENCY_AUDIT.md)');
    e.statusCode = 409; e.code = 'save_not_live';
    throw e;
  }
}
