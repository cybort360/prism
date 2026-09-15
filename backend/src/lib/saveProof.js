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
