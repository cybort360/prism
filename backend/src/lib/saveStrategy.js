// Prism Save — future strategy registry. Architected, but NOT a yield-chasing engine.
//
// V1 "optimized yield" means: Prism deposits into the ONE approved strategy (earnAUSD), and earnAUSD's
// curator dynamically reallocates within its own policy. Prism never autonomously chases the numerically
// highest APY across arbitrary protocols, and never auto-migrates existing funds between strategies.
//
// This registry exists so more strategies COULD be added later — allowlisted and governed — but nothing
// beyond the approved earnAUSD strategy is enabled, and selection never ranks on raw APY alone.

export const SaveRiskTier = Object.freeze({ CONSERVATIVE: 'conservative', MODERATE: 'moderate', HIGHER: 'higher' });

/** The single approved V1 strategy. earnAUSD (Upshift), curated by Gamma Research. */
export const APPROVED_EARNAUSD_STRATEGY = Object.freeze({
  strategyId: 'earnausd-upshift',
  name: 'earnAUSD',
  depositAsset: 'AUSD',
  positionAsset: 'earnAUSD',
  adapter: 'upshift-earnausd',
  riskTier: SaveRiskTier.MODERATE,
  enabled: true,
  maxAllocation: 10000,                    // basis points of Save capital (100%)
  withdrawalProfile: { instant: { available: 'subject_to_liquidity', feeBearing: true }, queued: { window: 'up to 72h' } },
  curator: 'Gamma Research'
});

// The factors a future selection MAY weigh. APY is one input among many — never the sole ranking key.
export const SELECTION_FACTORS = Object.freeze(['netApy', 'liquidity', 'withdrawalTime', 'smartContractRisk', 'strategyConcentration', 'stablecoinRisk', 'capacity', 'executionCost']);

export class SaveStrategyRegistry {
  /** @param governance an allowlist of principals permitted to enable a strategy (empty ⇒ none). */
  constructor({ strategies = [APPROVED_EARNAUSD_STRATEGY], governance = [] } = {}) {
    this.strategies = new Map(strategies.map((s) => [s.strategyId, { ...s }]));
    this.governance = new Set(governance.map((g) => String(g).toLowerCase()));
  }

  list() { return [...this.strategies.values()]; }
  enabled() { return this.list().filter((s) => s.enabled); }
  /** The strategy V1 uses. Always the approved earnAUSD strategy — never a computed "best APY". */
  active() { return this.strategies.get(APPROVED_EARNAUSD_STRATEGY.strategyId) ?? null; }

  /** Add a strategy to the allowlist. It arrives DISABLED; enabling requires governance. */
  add(strategy, { governedBy } = {}) {
    if (!strategy?.strategyId) throw new Error('strategy needs a strategyId');
    if (!this.governance.has(String(governedBy ?? '').toLowerCase())) throw new Error('adding a strategy requires a governed principal');
    this.strategies.set(strategy.strategyId, { ...strategy, enabled: false });
    return this.strategies.get(strategy.strategyId);
  }

  /** Enable a registered strategy. Governed — never automatic. */
  enable(strategyId, { governedBy } = {}) {
    if (!this.governance.has(String(governedBy ?? '').toLowerCase())) throw new Error('enabling a strategy requires a governed principal');
    const s = this.strategies.get(strategyId);
    if (!s) throw new Error('unknown strategy');
    s.enabled = true;
    return s;
  }

  /** V1 NEVER auto-migrates funds between strategies. Always false. */
  shouldAutoMigrate() { return false; }
}

/**
 * Multi-factor comparison for a FUTURE selection. Returns > 0 if `a` is preferable to `b`, < 0 if `b`.
 * Deliberately NOT a raw-APY ranking: risk, liquidity, withdrawal time, concentration, capacity and cost
 * all pull against yield. A higher-APY but riskier/less-liquid strategy does not automatically win.
 */
export function compareStrategies(a, b, weights = {}) {
  const w = { netApy: 1, liquidity: 1, withdrawalTime: 1, smartContractRisk: 2, strategyConcentration: 1, stablecoinRisk: 2, capacity: 1, executionCost: 1, ...weights };
  const score = (m) => (
    (m.netApy ?? 0) * w.netApy
    + (m.liquidity ?? 0) * w.liquidity
    - (m.withdrawalTime ?? 0) * w.withdrawalTime
    - (m.smartContractRisk ?? 0) * w.smartContractRisk
    - (m.strategyConcentration ?? 0) * w.strategyConcentration
    - (m.stablecoinRisk ?? 0) * w.stablecoinRisk
    + (m.capacity ?? 0) * w.capacity
    - (m.executionCost ?? 0) * w.executionCost
  );
  return score(a) - score(b);
}
