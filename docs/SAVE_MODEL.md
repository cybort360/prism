# SAVE — Domain Model

Prism Save is a **first-class financial domain**, not a payment. A payment moves money between people;
Save **transforms a user's available USDC into a yield-bearing earnAUSD position**. It is modeled on its
own types and lifecycle, never forced into the payment model.

> Status: the earnAUSD substrate is Monad-mainnet-only and its deposit ABI is unverified
> (`docs/SAVE_DEPENDENCY_AUDIT.md`), so execution ships as an announced preview. The domain model,
> accounting, lifecycle, and reconstruction below are fully implemented and tested with fixtures; the
> live vault reads drop in behind the `SaveVaultReader` seam once verified.

## PrismSavePosition (`backend/src/domain/savePosition.js`)

A user's position. **Share ownership is canonical on-chain**; the backend store is a projection. The
position **reconstructs from chain** after reinstall/login — no local row is required to prove savings.

| field | meaning |
|---|---|
| `positionId` | deterministic `save_<ownerAccount>` (no DB row needed to identify it) |
| `prismIdentityId`, `ownerAccount` | who owns it; the account that holds the shares |
| `status` | `NONE` (zero shares) · `ACTIVE` (shares > 0) · `UNAVAILABLE` (chain unreadable — never a stale guess) |
| `inputAsset` / `savingsAsset` / `shareAsset` | `USDC` / `AUSD` / `earnAUSD` |
| `totalUSDCDeposited` / `totalAUSDDeposited` | historical sums from the operation projection |
| `earnAUSDShares` | **canonical** shares from the vault |
| `currentAUSDValue` | the vault's OWN share→asset conversion (never shares×price computed by Prism) |
| `principalAUSD` | remaining AUSD cost basis (average-cost; `null` if history is absent) |
| `realizedYieldAUSD` | yield realized on withdrawals |
| `unrealizedYieldAUSD` | `currentAUSDValue − principalAUSD` (signed; `null` without basis) |
| `earnedAUSD` | realized + unrealized (`null` when basis unknown — never guessed) |
| `apy` | resolved `{ available, apy, apySource, apyWindow, observedAt }` — fresh only |
| `estimatedMonthlyEarningsAUSD` | labeled estimate from the current APY (`null` if unavailable) |
| `externalIncentives` | Merkl AUSD/wMON — **kept separate**, never folded into earned/APY/balance |
| `createdAt` / `updatedAt` | first deposit; reconstruction time |

Every monetary value is an **integer base-unit string** (AUSD/USDC 6dp). Never a float.

## PrismSaveOperation (`buildSaveOperation`)

A projection of one lifecycle: `kind ∈ { SAVE, WITHDRAW_INSTANT, WITHDRAW_STANDARD, CLAIM_WITHDRAWAL }`,
with `inputUSDC / quotedAUSD / actualAUSD`, `sharesExpected / sharesReceived / sharesRedeemed`,
`outputAUSD / outputUSDC`, quote + route metadata, slippage/minimums/deadline, share prices before/after,
`transactionHash / blockNumber / withdrawalRequestId`, and the observed timestamps
`createdAt / authorizedAt / submittedAt / confirmedAt / completedAt` (+ `failure`). See
[`SAVE_LIFECYCLE.md`](SAVE_LIFECYCLE.md) for which states may set which timestamp.

## Canonical source map

| value | source of truth |
|---|---|
| Prism USDC available | `USDC.balanceOf(user Prism account)` |
| AUSD conversion amount | actual transaction/event/balance delta (not the quote) |
| earnAUSD shares | live share-token / vault state |
| share price | verified vault calculation |
| position value | vault conversion of the user's shares to underlying |
| APY | Upshift/Agora verified source, with freshness |
| lifecycle | operation store + chain evidence |
| backend cache | **projection only** |
| "earned" | independently observed value − adjusted AUSD cost basis |

## Persistence

The position is reconstructed from `reconstructPosition({ chain, operations, apyRecord })`: shares + value
come from the vault (canonical); the operation projection supplies cost basis + history. With **no**
operations, an existing position still returns its shares + value from chain — `earnedAUSD` is reported
`null` (unknown), never fabricated. Zero shares ⇒ `NONE`.
