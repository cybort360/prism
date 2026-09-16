// Prism Save — proof of a completed Save. Assembled ONLY from observed evidence (the operation record +
// canonical on-chain evidence). Any field that has not been observed stays null; `complete` is true only
// when every load-bearing field is present. No field is ever fabricated to look complete.

const has = (v) => v !== null && v !== undefined && v !== '';

/**
 * @param {object} p
 * @param {object} p.operation  a PrismSaveOperation (projection of the lifecycle)
 * @param {string|null} p.usdcBefore  the account's USDC balance before the Save (observed)
 * @param {object|null} p.evidence  canonical evidence { txStatus, ausdConvertedAtomic, sharesMintedAtomic, blockNumber }
 */
export function assembleSaveProof({ operation = {}, usdcBefore = null, evidence = null } = {}) {
  const proof = {
    owner: operation.owner ?? null,
    usdcBefore: has(usdcBefore) ? String(usdcBefore) : null,
    usdcInput: has(operation.inputUSDC) ? String(operation.inputUSDC) : null,
    routeProvider: operation.routeProvider ?? null,
    quotedAUSD: has(operation.quotedAUSD) ? String(operation.quotedAUSD) : null,
    // actual AUSD prefers observed evidence over the operation's recorded value.
    actualAUSD: has(evidence?.ausdConvertedAtomic) ? String(evidence.ausdConvertedAtomic)
      : (has(operation.actualAUSD) ? String(operation.actualAUSD) : null),
    sharePriceBefore: has(operation.vaultSharePriceBefore) ? String(operation.vaultSharePriceBefore) : null,
    sharesReceived: has(evidence?.sharesMintedAtomic) ? String(evidence.sharesMintedAtomic)
      : (has(operation.sharesReceived) ? String(operation.sharesReceived) : null),
    transactionHash: operation.transactionHash ?? null,
    blockNumber: has(evidence?.blockNumber) ? String(evidence.blockNumber)
      : (has(operation.blockNumber) ? String(operation.blockNumber) : null)
  };
  // A proof is complete only when the evidence actually proves a Save: the tx succeeded and every
  // load-bearing field is present. Acceptance alone (no evidence) is never "complete".
  const txSucceeded = evidence?.txStatus === 'success';
  proof.complete = txSucceeded && [
    proof.owner, proof.usdcInput, proof.actualAUSD, proof.sharesReceived, proof.transactionHash
  ].every(has);
  return proof;
}

const lc = (v) => String(v ?? '').toLowerCase();
const big = (v) => { try { return BigInt(String(v)); } catch { return null; } };
const gte = (a, b) => { const x = big(a), y = big(b); return x != null && y != null && x >= y; };

// A verification status is one of: 'verified' (evidence proves it), 'failed' (evidence contradicts it),
// or 'unavailable' (the evidence needed to prove it hasn't been observed). Nothing is ever 'verified'
// without evidence.
function check(name, { present, ok, blocked }) {
  if (blocked) return { check: name, status: 'failed' };
  if (!present) return { check: name, status: 'unavailable' };
  return { check: name, status: ok ? 'verified' : 'failed' };
}

/**
 * The canonical PrismSaveProof for one Save operation. Assembled from the operation record + canonical
 * on-chain evidence + an optional independent chain readback. Every consequential fact is verified from
 * evidence, never from a quote or acceptance — and a tx-hash mismatch between the operation and the
 * evidence marks the whole proof failed (a proof must correlate to the operation it claims).
 *
 * @param {object} p
 * @param {object} p.operation  a PrismSaveOperation
 * @param {object} p.save       config.save (network/vault/share-token/verified defaults)
 * @param {string} p.ownerAccount
 * @param {object|null} p.evidence  { txStatus, transactionHash, usdcDebitedAtomic, ausdConvertedAtomic,
 *                                    sharesMintedAtomic, sharesReceiver, blockNumber }
 * @param {object|null} p.stateReadback  independent read: { available, shares, valueAtomic }
 */
export function buildSaveProof({ operation = {}, save = {}, ownerAccount = null, evidence = null, stateReadback = null }) {
  const owner = ownerAccount ?? operation.owner ?? null;
  const txSucceeded = evidence?.txStatus === 'success';
  // Correlation: the evidence must be for THIS operation's transaction.
  const txMismatch = has(operation.transactionHash) && has(evidence?.transactionHash) &&
    lc(operation.transactionHash) !== lc(evidence.transactionHash);

  const actualAUSD = evidence?.ausdConvertedAtomic ?? (has(operation.actualAUSD) ? operation.actualAUSD : null);
  const sharesActual = evidence?.sharesMintedAtomic ?? (has(operation.sharesReceived) ? operation.sharesReceived : null);
  const receiver = evidence?.sharesReceiver ?? null;

  const proof = {
    operationId: operation.operationId ?? null,
    positionId: operation.positionId ?? null,
    network: save.substrateChainId ?? null,
    ownerAccount: owner,
    inputAsset: 'USDC',
    inputAmount: has(operation.inputUSDC) ? String(operation.inputUSDC) : null,
    conversionProvider: operation.routeProvider ?? null,
    quotedAUSD: has(operation.quotedAUSD) ? String(operation.quotedAUSD) : null,
    actualAUSD: has(actualAUSD) ? String(actualAUSD) : null,
    minimumAUSD: has(operation.minimumAUSD) ? String(operation.minimumAUSD) : null,
    vault: operation.vault ?? save.earnAusdVault ?? null,
    shareToken: operation.shareToken ?? save.earnAusdVault ?? null,
    sharesQuoted: has(operation.sharesExpected) ? String(operation.sharesExpected) : null,
    sharesActual: has(sharesActual) ? String(sharesActual) : null,
    minimumShares: has(operation.minimumShares) ? String(operation.minimumShares) : null,
    sharePriceAtDeposit: has(operation.vaultSharePriceBefore) ? String(operation.vaultSharePriceBefore) : null,
    transactionHash: operation.transactionHash ?? null,
    blockNumber: has(evidence?.blockNumber) ? String(evidence.blockNumber) : (has(operation.blockNumber) ? String(operation.blockNumber) : null),
    gasSponsored: operation.gasSponsored ?? true,
    stateReadback: stateReadback ?? null,
    txCorrelates: !txMismatch,
    evidence: []
  };

  // Observed facts recorded for inspection (only what was actually seen).
  if (has(evidence?.transactionHash)) proof.evidence.push({ kind: 'tx', value: evidence.transactionHash, status: evidence.txStatus ?? 'unknown' });
  if (has(evidence?.usdcDebitedAtomic)) proof.evidence.push({ kind: 'usdc_debit', atomic: String(evidence.usdcDebitedAtomic) });
  if (has(actualAUSD)) proof.evidence.push({ kind: 'ausd_received', atomic: String(actualAUSD) });
  if (has(sharesActual)) proof.evidence.push({ kind: 'shares_minted', atomic: String(sharesActual), receiver: receiver ?? null });
  if (stateReadback?.available) proof.evidence.push({ kind: 'readback', shares: String(stateReadback.shares ?? '0'), valueAtomic: stateReadback.valueAtomic ?? null });

  proof.verification = [
    check('usdc_debit', { blocked: txMismatch, present: txSucceeded && has(evidence?.usdcDebitedAtomic), ok: gte(evidence?.usdcDebitedAtomic, '1') }),
    check('ausd_conversion', { blocked: txMismatch, present: txSucceeded && has(actualAUSD), ok: !has(operation.minimumAUSD) || gte(actualAUSD, operation.minimumAUSD) }),
    check('earnausd_shares', { blocked: txMismatch, present: txSucceeded && has(sharesActual), ok: !has(operation.minimumShares) || gte(sharesActual, operation.minimumShares) }),
    check('share_ownership', { blocked: txMismatch, present: has(receiver) && has(owner), ok: lc(receiver) === lc(owner) }),
    check('independent_readback', { present: stateReadback?.available === true, ok: gte(stateReadback?.shares, '1') })
  ];

  proof.complete = !txMismatch && txSucceeded &&
    proof.verification.filter((v) => v.check !== 'independent_readback').every((v) => v.status === 'verified');
  return proof;
}
