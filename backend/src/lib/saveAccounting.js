// Prism Save — accounting. Pure, deterministic, integer base units (BigInt). No floats for balances.
//
// The one rule that shapes everything: yield basis starts from the ACTUAL AUSD deposited into the vault,
// never from USDC deposited. The USDC→AUSD execution cost is an entry cost, not negative yield. So
// "earned" = independently observed position value − adjusted AUSD cost basis, and is derived here, never
// from (USDC in − current balance).
//
// Cost basis is average-cost: a withdrawal removes principal in proportion to the shares it redeems.

const toBig = (v) => BigInt(String(v ?? '0'));
const s = (v) => v.toString();

/**
 * Fold an ORDERED list of terminal Save operations into position accounting. Deposits add AUSD cost
 * basis + shares; withdrawals remove basis proportionally and realize yield. Returns integer strings.
 *
 * @param {Array} operations items of { kind, actualAUSD?, sharesReceived?, sharesRedeemed?, outputAUSD? }
 * @returns {{ principalAUSD, shares, realizedYieldAUSD }}
 */
export function reduceCostBasis(operations = []) {
  let principal = 0n;   // remaining AUSD cost basis
  let shares = 0n;      // remaining earnAUSD shares (projection; chain is canonical — see reconciliation)
  let realized = 0n;    // realized yield in AUSD, accumulated over withdrawals

  for (const op of operations) {
    if (op.kind === 'SAVE') {
      principal += toBig(op.actualAUSD);
      shares += toBig(op.sharesReceived);
    } else if (op.kind === 'WITHDRAW_INSTANT' || op.kind === 'WITHDRAW_STANDARD' || op.kind === 'CLAIM_WITHDRAWAL') {
      const redeemed = toBig(op.sharesRedeemed);
      const out = toBig(op.outputAUSD);
      if (redeemed <= 0n || shares <= 0n) continue;
      const capped = redeemed > shares ? shares : redeemed;
      // Average-cost basis removed for the redeemed shares (integer division; the remainder stays as basis).
      const basisRemoved = (principal * capped) / shares;
      realized += out - basisRemoved;
      principal -= basisRemoved;
      shares -= capped;
    }
  }
  return { principalAUSD: s(principal), shares: s(shares), realizedYieldAUSD: s(realized) };
}

/**
 * Unrealized yield = current independently-observed AUSD value of the remaining shares − remaining cost
 * basis. `currentAUSDValue` MUST come from the vault's own share→asset conversion, not shares×price done
 * here. Returns a signed integer string (can be negative if the share price fell).
 */
export function unrealizedYieldAUSD(currentAUSDValue, principalAUSD) {
  return s(toBig(currentAUSDValue) - toBig(principalAUSD));
}

/** Total earned = realized + unrealized. Signed integer string. Excludes any external (Merkl) incentives. */
export function totalEarnedAUSD({ realizedYieldAUSD, currentAUSDValue, principalAUSD }) {
  return s(toBig(realizedYieldAUSD) + toBig(currentAUSDValue) - toBig(principalAUSD));
}

/**
 * APY freshness. A stored APY is only usable while it is fresh; a stale reading is reported unavailable
 * rather than presented as current. Never hardcodes or fabricates a rate.
 *
 * @param {object|null} record { apy (decimal e.g. 0.0708), apySource, apyWindow, observedAt (ISO) }
 * @param {object} opts { now = Date.now(), maxAgeMs = 30min }
 * @returns {{ available: boolean, apy?: number, apySource?, apyWindow?, observedAt?, reason? }}
 */
export function resolveApy(record, { now = Date.now(), maxAgeMs = 30 * 60_000 } = {}) {
  if (!record || record.apy == null || !Number.isFinite(Number(record.apy))) {
    return { available: false, reason: 'rate_unavailable' };
  }
  const observed = Date.parse(record.observedAt);
  if (!Number.isFinite(observed) || now - observed > maxAgeMs) {
    return { available: false, reason: 'rate_stale', observedAt: record.observedAt };
  }
  return { available: true, apy: Number(record.apy), apySource: record.apySource ?? null, apyWindow: record.apyWindow ?? null, observedAt: record.observedAt };
}

/**
 * Effective monthly rate from an annual APY: (1 + APY)^(1/12) − 1. This is the mathematically correct
 * compounding conversion, used ONLY for a labeled estimate — never to record a balance.
 */
export function effectiveMonthlyRate(apy) {
  return Math.pow(1 + Number(apy), 1 / 12) - 1;
}

/**
 * Estimated monthly earnings on a principal, as a base-unit integer string. This is an ESTIMATE derived
 * from the current variable APY (which can change), never a promise. Returns null when APY is unavailable.
 */
export function estimatedMonthlyEarningsAtomic(principalAtomic, apyResolved) {
  if (!apyResolved?.available) return null;
  const rate = effectiveMonthlyRate(apyResolved.apy);
  // principal is integer base units; the estimate multiplies by a rate and rounds to base units. The
  // float lives only in the rate — the product is rounded back to an integer string.
  const principal = Number(toBig(principalAtomic));
  if (!Number.isFinite(principal)) return null;
  return s(BigInt(Math.round(principal * rate)));
}
