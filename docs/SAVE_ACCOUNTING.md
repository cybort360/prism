# SAVE — Accounting

All logic in `backend/src/lib/saveAccounting.js`. Pure, deterministic, **integer base units (BigInt)** —
never a float for a balance. AUSD/USDC are 6-decimal.

## The rule that shapes everything: basis starts from AUSD, not USDC

Yield basis begins from the **actual AUSD deposited into the vault**, never from USDC deposited. If earned
were `USDC deposited − current balance`, the USDC→AUSD execution cost would be miscounted as a yield loss.

> Deposit 100 USDC → 99 AUSD received (1 USDC entry/swap cost). Cost basis = **99 AUSD**. If the value
> stays 99 AUSD, earned = **0**, not −1. The entry cost is an entry cost, not negative yield.
> (`accounting: swap cost is an entry cost, NOT negative yield`.)

## Cost basis (average-cost)

`reduceCostBasis(operations)` folds terminal operations in order:

- **SAVE** adds `actualAUSD` to `principalAUSD` and `sharesReceived` to `shares`.
- **WITHDRAW / CLAIM** removes basis in proportion to the shares it redeems:
  `basisRemoved = principalAUSD × sharesRedeemed / sharesBefore` (integer division; remainder stays as
  basis). `realizedYield += outputAUSD − basisRemoved`; then `principal −= basisRemoved`,
  `shares −= sharesRedeemed`.

A partial withdrawal therefore **adjusts the cost basis** and realizes only the yield on the redeemed
portion; a full withdrawal clears basis + shares and realizes all yield.

## Earned

- `unrealizedYieldAUSD = currentAUSDValue − principalAUSD` (signed — negative if the share price fell).
  `currentAUSDValue` MUST be the vault's own share→asset conversion, not shares×price computed by Prism.
- `earnedAUSD = realizedYieldAUSD + currentAUSDValue − principalAUSD`.
- Without a cost basis (no operation history, e.g. right after reinstall), earned is reported **`null`** —
  the position (shares + value) still proves from chain, but earned is unknown, never guessed.

## APY

Never hardcoded. Stored as `{ apy, apySource, apyWindow, observedAt }` from a verified upstream source.
`resolveApy(record, { now, maxAgeMs = 30min })`:

- fresh ⇒ `{ available: true, apy, apySource, apyWindow, observedAt }`
- older than `maxAgeMs` ⇒ `{ available: false, reason: 'rate_stale' }`
- missing/invalid ⇒ `{ available: false, reason: 'rate_unavailable' }`

A stale reading is reported **unavailable** ("Rate unavailable"), never presented as current.

## Estimated monthly earnings

An **estimate**, never a promise. From an annual APY, the mathematically correct effective monthly rate:

```
monthlyRate = (1 + APY)^(1/12) − 1
estimatedMonthlyEarnings = base × monthlyRate      // base = current position value at work
```

The float lives only in the rate; the product is rounded back to an integer base-unit string. Returned
`null` when APY is unavailable. UI labels it "Estimated monthly earnings · Based on the current variable
APY. Rates can change." — never "You will earn $X."

## External incentives (kept separate)

earnAUSD's Merkl incentives (AUSD + wMON) are **not** reflected in the vault share price, and Prism cannot
claim them. They are therefore excluded from `earnedAUSD`, the APY, and the savings balance
(`externalIncentives.included = false`). Vault yield and external incentives are never mixed.

## Tested (`backend/test/save-accounting.test.js`, `save-domain.test.js`)

multiple deposits · partial withdrawal · full withdrawal · share appreciation · share-price decrease ·
APY changes · APY unavailable/stale · **swap cost not counted as negative yield** · withdrawal adjusts
cost basis · reinstall/reconstruct · backend stale value refreshed (chain-first) · zero shares = no
active position · integer base-unit correctness. Backend suite 186/186.
