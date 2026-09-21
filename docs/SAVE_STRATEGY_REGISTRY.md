# Save — Future Strategy Registry

Status: **architected, not enabled.** V1 uses exactly one approved strategy (earnAUSD). This document
describes the framework that lets more be added later — allowlisted and governed — without turning Save
into a yield-chaser. Source: `backend/src/lib/saveStrategy.js`; tests: `backend/test/save-strategy.test.js`.

## Why this exists

"Optimized yield" in Prism Save means: deposit into the **one approved strategy**, whose curator
reallocates within its own policy. Prism never autonomously chases the numerically highest APY across
arbitrary protocols, and never auto-migrates a user's funds. The registry encodes that discipline so it
survives future expansion — adding a strategy is a governed, deliberate act, not an optimizer's decision.

## The strategy shape

```
SaveStrategy {
  strategyId          // stable id, e.g. "earnausd-upshift"
  name                // consumer-facing, e.g. "earnAUSD"
  depositAsset        // what Prism converts into (AUSD)
  positionAsset       // the yield-bearing position (earnAUSD)
  adapter             // integration seam ("upshift-earnausd")
  riskTier            // conservative | moderate | higher
  enabled             // false unless governance enables it
  maxAllocation       // bps of Save capital this strategy may hold
  withdrawalProfile   // { instant: {...}, queued: {...} }
  curator             // who manages reallocation within policy
}
```

The single V1 entry is `APPROVED_EARNAUSD_STRATEGY` (`earnAUSD`, moderate tier, curated by Gamma
Research), and it is the only `enabled` strategy.

## Governance & the allowlist

`SaveStrategyRegistry` is constructed with an explicit `governance` allowlist of principals.

- `add(strategy, { governedBy })` — requires a governed principal, and the strategy **always arrives
  disabled** regardless of an `enabled: true` in the payload. The allowlist, not the caller's data,
  decides.
- `enable(strategyId, { governedBy })` — also requires a governed principal. Enabling is never
  automatic and never a side effect of a quote or a metric crossing a threshold.
- `active()` — returns the approved earnAUSD strategy. V1 deposits here, always. It is never a computed
  "best APY".
- `shouldAutoMigrate()` — returns `false`. V1 never moves existing funds between strategies.

## Selection: many factors, never raw APY

When a future version selects among enabled strategies, `compareStrategies(a, b, weights)` scores on the
factors below. APY is one positive input; risk, illiquidity, slow withdrawals, concentration, stablecoin
risk and execution cost all pull against it. A higher-APY but riskier or less-liquid strategy does **not**
automatically win (proven by test).

`netApy · liquidity · withdrawalTime · smartContractRisk · strategyConcentration · stablecoinRisk ·
capacity · executionCost`

Default weights deliberately weight `smartContractRisk` and `stablecoinRisk` above `netApy`.

## What V1 does NOT do

- Does not enable any strategy other than earnAUSD.
- Does not rank or switch strategies at runtime.
- Does not auto-migrate funds.
- Does not treat a higher APY as sufficient reason to move money.
