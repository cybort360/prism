# SAVE — Execution

The execution path for Prism Save. The whole safety architecture is built and tested; the final
**broadcast is gated** because the substrate isn't executable from Prism's chain yet (see status below).

## What the user authorizes: SaveIntent (`backend/src/lib/saveIntent.js`)

Not "arbitrary DeFi calls" — a single explicit intent:

> *Move exactly up to X USDC from my Prism balance into the approved Prism Save strategy, subject to a
> minimum output and a deadline.*

`SaveIntent { owner, inputToken=USDC, maxInputUSDC, intermediateToken=AUSD, vault, shareToken,
minAUSDOut, minSharesOut, receiver=owner, quoteId, deadline, nonce, chainId }` is signed as EIP-712
(`saveIntentTypedData`, domain `PrismSave`). **Changing any protected field after authorization
invalidates execution** — the recovered signer no longer matches `owner`. Proven by
`save-execution.test.js` (mutating each of the 12 fields → signature invalid) and by the iOS
`SaveIntentGuard` / `SaveIntentGuardTests`.

`nonce` is single-use (`consumeSaveNonce`) so an authorization cannot be replayed. `validateSaveIntent`
independently rejects a non-owner receiver, a foreign vault, a raised amount, the wrong chain, or a past
deadline — the backend twin of the client guard.

## Quote validation before Face ID / PIN

The quote is refreshed and shown as: **You save $500.00 · Estimated invested $499.xx · Conversion cost
$x.xx / x bps · Current APY x.xx% · Minimum invested $xxx.xx · Quote expires xx s** (the `review` block on
the quote, money-safe integer base units; in preview the invested amount is an illustrative 1:1 and the
conversion cost is 0, both flagged, never invented). `validateExecutionQuote`
BLOCKS execution (never silently attempts) on any of: `route_unavailable`, `quote_expired`, `vault_paused`,
`vault_deposit_capped`, `slippage_too_high`, `price_impact_too_high`, missing minimums.

## Client-side signing guard (`ios/Prism/Models/SaveModels.swift`)

The Swift app decodes the execution payload and independently validates every consequential field against
the app's OWN compiled-in substrate + the user's review: USDC amount, AUSD destination, earnAUSD vault,
share receiver, minimum outputs, deadline, chain, account. It REFUSES to sign on an unknown target,
unknown selector, an unlimited approval not on policy, a different receiver, or a different amount
(`SavePlan.verify` for the calldata plan; `SaveIntentGuard.verify` for the intent).

## Sponsored execution

`PIN / Face ID → cryptographic account authorization → sponsored UserOperation → Monad`. The PIN is a
**local approval only** — it never becomes a chain key; the account's own key authorizes, and a relayer/
paymaster sponsors gas (the zero-MON posture Prism already uses for payments).

## Reconciliation — SAVED only on canonical evidence (`reconcileSaveEvidence`)

A Save is **never** SAVED because a quote succeeded, an RPC accepted the tx, or a bundler accepted the
UserOp. SAVED requires: tx succeeded · USDC debited within the authorized bound · AUSD conversion
occurred · **earnAUSD shares minted to the USER's account** · `sharesReceived ≥ minSharesOut`. Anything
short fails closed:

- atomic revert (router < minAUSD, vault < minShares, vault paused) → `FAILED`
- USDC/AUSD moved but shares not minted to the user → `REQUIRES_RECONCILIATION` (a partial, never hidden)
- shares to the wrong receiver → `FAILED`

## Atomicity & ambiguous submission

V1 prefers **atomic**: one sponsored batch (approve → swap → approve → deposit); any failed leg reverts
the whole operation, so there is no partial state. If a selected route cannot be atomic, the partial state
is modeled explicitly (USDC converted / AUSD waiting / Save not completed) with a recovery path, never
hidden. If a broadcast's status is **unknown**, the op goes to `REQUIRES_RECONCILIATION` and is **not
retryable** (`isRetryable`) until the UserOp / tx / USDC-delta / AUSD-delta / share state is checked.

## Save proof (persisted evidence)

USDC before · USDC input · route provider · quoted AUSD · actual AUSD · earnAUSD share price before ·
shares received · transaction · block · owner (`assembleSaveProof`, `backend/src/lib/saveProof.js`). No
fabricated proof: each field is filled only from the operation record or canonical evidence — `quotedAUSD`
is never presented as `actualAUSD`, and `complete` is true only when the tx succeeded and every
load-bearing field is observed. Acceptance (quote/RPC/bundler) is never "complete".

## Architecture decision (executeBatch vs PrismSaveRouter)

The audit found **no live `executeBatch` account** — it is archived (`archive/erc4337-p256/`), and the
live `PrismP256Account` only exposes `pay()`. So V1 targets a **revived batch-capable account** and builds
the *minimum* call batch. A `PrismSaveRouter` is introduced **only** if it provides a concrete
atomicity/security property the account batch cannot (e.g. binding min-out enforcement + the deposit in
one call the account can't express) — never for branding. See
[`SAVE_ROUTE_SECURITY.md`](SAVE_ROUTE_SECURITY.md).

## Status — execution is gated (announced, not faked)

`PreviewSaveExecutor.execute()` refuses with a clear reason. To go live, three things from
[`SAVE_DEPENDENCY_AUDIT.md`](SAVE_DEPENDENCY_AUDIT.md) must be resolved: the earnAUSD deposit ABI verified,
a proven USDC→AUSD route, and a batch-capable account on the substrate chain (mainnet 143). Until then no
broadcast occurs, and every safety component above is nonetheless real and tested.
