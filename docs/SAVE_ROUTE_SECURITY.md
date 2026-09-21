# SAVE — Route & Execution Security

How Prism keeps Save execution constrained to exactly what the user authorized, so the backend can never
turn "Save" into an arbitrary transfer.

## Two independent verifications of one constrained plan

A `SaveExecutionPlan` (`backend/src/lib/saveRoute.js`) is fully constrained: input USDC, intermediate
AUSD, output earnAUSD, receiver = owner, real minimums, a deadline, and an allowlisted call list. It is
verified **twice, independently**:

1. **Backend** — `verifySaveExecutionPlan` before returning a quote.
2. **Client** — `SavePlan.verify` (iOS) re-runs the same checks against the app's OWN compiled-in
   substrate addresses (`SaveSubstrate`), never the server's. Plus `SaveIntentGuard.verify` for the
   signed intent's protected fields.

The client refuses to sign on: an **unknown target** (not in the allowlist), an **unknown selector**/kind,
an **unlimited approval** not on policy, a **different receiver**, or a **different amount**. Also rejected:
arbitrary external calls, arbitrary recipients, and any **native MON transfer** (`value != 0`).

The allowlist is the only set of contracts a Save plan may touch: official USDC, official AUSD, the
approved swap router, and the verified earnAUSD vault. An empty swap-router config means **no route is
approved**, so no swap target is allowlisted and no plan can execute — the honest default today.

## Approval hygiene

- **No permanent unlimited approvals by default.** Approvals are for the **exact** amount:
  `approve(spender, amount) → execute → reset remaining allowance` where the protocol requires it. An
  approval whose amount is `MAX_UINT256` is rejected by both verifiers (`*_unlimited_approval`).
- An approve call's `spender` must be exactly the swap router (for USDC) or the earnAUSD vault (for AUSD);
  any other spender is `*_approve_unknown_spender`.
- **If an external routing protocol requires a standing allowance**, it must be documented before use —
  `spender`, `scope`, `risk`, and `revocation mechanism` — and requires explicit architecture approval.
  No such standing allowance is granted today (no route is approved yet).

## SaveIntent binds the economics into the signature

Every protected field (`owner, inputToken, maxInputUSDC, intermediateToken, vault, shareToken, minAUSDOut,
minSharesOut, receiver, quoteId, deadline, nonce, chainId`) is bound into the EIP-712 signature. Mutating
any of them invalidates execution; the `quoteId` binds the exact quote; the `nonce` is single-use. The
signature — not the backend — is the source of truth for what was authorized.

## executeBatch vs a PrismSaveRouter

Prefer the **account batch** (the proven Prism architecture): the user's batch-capable account executes
the minimum calls in one sponsored UserOperation, which reverts entirely if any leg fails — giving
atomicity without a new trusted contract. A dedicated **`PrismSaveRouter` is introduced only if** it
provides a concrete security/atomicity property the account batch cannot express (for example, enforcing
`minAUSDOut`/`minSharesOut` and the deposit atomically in one verified call, so a compromised relayer
cannot reorder or drop a leg). It is **never** introduced for branding. Because the audit found
`executeBatch` archived and no live batch account, V1 first revives/deploys a batch-capable account on the
substrate chain; the router is evaluated against that baseline, not assumed.

## What is NOT trusted

- The backend's returned calldata (re-verified client-side against known addresses).
- Any route/aggregator target that isn't allowlisted.
- Quote acceptance, RPC acceptance, or bundler acceptance as proof of a completed Save — only canonical
  on-chain evidence marks SAVED (see [`SAVE_EXECUTION.md`](SAVE_EXECUTION.md)).

## Tests

`backend/test/save-execution.test.js` (protected-field invalidation, structural validation, replay,
quote gates, reconciliation, ambiguous submission, malicious route/approve targets, preview executor
refuses) and `save.test.js` (plan allowlist). iOS `SaveIntentGuardTests`, `SavePlanTests`.
