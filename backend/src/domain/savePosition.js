import { randomHex } from '../lib/crypto.js';
import { reduceCostBasis, unrealizedYieldAUSD, totalEarnedAUSD, resolveApy, estimatedMonthlyEarningsAtomic } from '../lib/saveAccounting.js';

// PrismSavePosition — a first-class Prism financial position, NOT a payment. It transforms available
// USDC into a yield-bearing earnAUSD position. Share ownership is canonical ON-CHAIN; the backend store
// is a projection (operation ids, quotes, receipts, history). A position therefore RECONSTRUCTS from the
// chain after reinstall/login without needing any local row to prove the savings exist.
//
// `reconstructPosition` is pure: give it the chain-observed values (shares + the vault's own share→asset
// conversion) and the operation projection, and it computes the position + accounting. The service does
// the async chain reads and calls this.

export const SavePositionStatus = Object.freeze({
  NONE: 'NONE',           // zero shares — no active position
  ACTIVE: 'ACTIVE',       // shares > 0
  UNAVAILABLE: 'UNAVAILABLE' // chain could not be read right now (never guessed from a stale cache)
});

/** Build a Save operation record (projection of a lifecycle). Money fields are integer base-unit strings. */
export function buildSaveOperation({ positionId, kind, state, ...rest }) {
  const now = new Date().toISOString();
  return {
    operationId: `saveop_${randomHex(16).slice(2)}`,
    positionId, kind, state,
    inputUSDC: null, quotedAUSD: null, actualAUSD: null,
    sharesExpected: null, sharesReceived: null, sharesRedeemed: null,
    outputAUSD: null, outputUSDC: null,
    quoteId: null, routeProvider: null,
    maxSlippageBps: null, minimumAUSD: null, minimumShares: null, deadline: null,
    vaultSharePriceBefore: null, vaultSharePriceAfter: null,
    transactionHash: null, blockNumber: null, withdrawalRequestId: null,
    createdAt: now, authorizedAt: null, submittedAt: null, confirmedAt: null, completedAt: null,
    failure: null,
    ...rest
  };
}

const big = (v) => BigInt(String(v ?? '0'));
const s = (v) => v.toString();

/**
 * Reconstruct a PrismSavePosition from chain-observed state + the operation projection. Pure.
 *
 * @param {object} p
 * @param {string} p.prismIdentityId
 * @param {string} p.ownerAccount
 * @param {object} p.chain  { available:boolean, shares:string|null, currentAUSDValue:string|null }
 *                          shares/currentAUSDValue are CANONICAL (from the vault); value is the vault's
 *                          own share→asset conversion, never shares×price computed here.
 * @param {Array}  p.operations terminal Save operations (SAVE / WITHDRAW_* / CLAIM_WITHDRAWAL)
 * @param {object|null} p.apyRecord { apy, apySource, apyWindow, observedAt }
 * @param {number} p.now
 */
export function reconstructPosition({ prismIdentityId, ownerAccount, chain, operations = [], apyRecord = null, now = Date.now() }) {
  const positionId = `save_${String(ownerAccount).toLowerCase()}`;
  const base = {
    positionId, prismIdentityId, ownerAccount,
    inputAsset: 'USDC', savingsAsset: 'AUSD', shareAsset: 'earnAUSD',
    updatedAt: new Date(now).toISOString()
  };

  // Chain is the source of truth for shares + value. Never fall back to a stale cache.
  if (!chain?.available) {
    return { ...base, status: SavePositionStatus.UNAVAILABLE, earnAUSDShares: null, currentAUSDValue: null,
      valueKnown: false, principalKnown: false, notLiveReason: 'position value could not be read from chain' };
  }

  const shares = big(chain.shares);
  // Historical totals + remaining cost basis from the projection (not needed to prove the position exists).
  const saves = operations.filter((o) => o.kind === 'SAVE');
  const totalUSDCDeposited = s(saves.reduce((a, o) => a + big(o.inputUSDC), 0n));
  const totalAUSDDeposited = s(saves.reduce((a, o) => a + big(o.actualAUSD), 0n));
  const { principalAUSD, realizedYieldAUSD } = reduceCostBasis(operations);
  const principalKnown = operations.length > 0;

  if (shares === 0n) {
    return {
      ...base, status: SavePositionStatus.NONE,
      earnAUSDShares: '0', currentAUSDValue: '0',
      totalUSDCDeposited, totalAUSDDeposited,
      principalAUSD: principalKnown ? principalAUSD : null,
      realizedYieldAUSD: principalKnown ? realizedYieldAUSD : null,
      unrealizedYieldAUSD: '0', earnedAUSD: principalKnown ? realizedYieldAUSD : null,
      valueKnown: true, principalKnown, apy: resolveApy(apyRecord, { now }), estimatedMonthlyEarningsAUSD: null,
      externalIncentives: incentives(), createdAt: firstCreatedAt(operations)
    };
  }

  const currentAUSDValue = chain.currentAUSDValue == null ? null : s(big(chain.currentAUSDValue));
  const valueKnown = currentAUSDValue != null;
  const apy = resolveApy(apyRecord, { now });

  // "Earned" needs a cost basis (from history). Without history we still show the position (shares +
  // value from chain); earned is simply unavailable rather than guessed.
  const unrealized = valueKnown && principalKnown ? unrealizedYieldAUSD(currentAUSDValue, principalAUSD) : null;
  const earned = valueKnown && principalKnown ? totalEarnedAUSD({ realizedYieldAUSD, currentAUSDValue, principalAUSD }) : null;
  // Estimate compounds on the money currently at work (the position value), labeled as an estimate.
  const estimate = valueKnown ? estimatedMonthlyEarningsAtomic(currentAUSDValue, apy) : null;

  return {
    ...base, status: SavePositionStatus.ACTIVE,
    earnAUSDShares: s(shares), currentAUSDValue,
    totalUSDCDeposited, totalAUSDDeposited,
    principalAUSD: principalKnown ? principalAUSD : null,
    realizedYieldAUSD: principalKnown ? realizedYieldAUSD : null,
    unrealizedYieldAUSD: unrealized,
    earnedAUSD: earned,
    valueKnown, principalKnown,
    apy, estimatedMonthlyEarningsAUSD: estimate,
    externalIncentives: incentives(),
    createdAt: firstCreatedAt(operations)
  };
}

// External incentives (Merkl AUSD/wMON) are NOT reflected in the vault share price and Prism cannot claim
// them, so they are kept entirely separate from earned/APY/balance and never folded in.
function incentives() {
  return { included: false, source: 'merkl', note: 'earnAUSD Merkl incentives (AUSD/wMON) are not reflected in this balance or rate' };
}
function firstCreatedAt(operations) {
  const saved = operations.filter((o) => o.kind === 'SAVE' && o.createdAt).map((o) => o.createdAt).sort();
  return saved[0] ?? null;
}
