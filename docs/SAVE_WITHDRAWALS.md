# SAVE — Withdrawals

Saving is not complete until money can return to spendable USDC. Prism Save withdrawal returns:

```
earnAUSD → AUSD → USDC → the user's normal Prism available balance
```

A normal consumer is **never** left holding AUSD unless they intentionally choose an advanced AUSD
option. Logic in `backend/src/lib/saveWithdraw.js`; the state machines (instant + queued) in
`saveLifecycle.js`; the accounting in `saveAccounting.js`.

> Status: the earnAUSD withdrawal interface is unverified and mainnet-only (`SAVE_DEPENDENCY_AUDIT.md`),
> so both modes report **unavailable** in preview and no broadcast occurs. Every safety component below is
> nonetheless real and tested with fixtures.

## Vault withdrawal modes (discovered)

From Upshift/Veda docs (the exact ABI is unverified — see the audit):

- **Instant** — redeem for a **fee**, available up to a liquidity cap. Fee/preview must be **observed**;
  Prism never invents a fee or shows "free" unless the vault says so (`withdrawModes`).
- **Standard / queued** — submit a withdrawal request, processed within the vault's window (~72h, Upshift
  processes daily), then claimed. Request identifier + claimability come from **on-chain state**.

## Withdraw screen modes (`ios/Prism/Features/Save/WithdrawView.swift`)

Two cards. Instant shows **Estimated USDC · Vault fee · Conversion cost · [Withdraw now]** (only when the
economics were observed). Standard shows **Expected processing (Up to 72 hours) · Estimated USDC ·
[Request withdrawal]**. In preview both are unavailable with an honest reason.

## Instant withdraw (atomic where supported)

`earnAUSD shares → redeem to AUSD → AUSD → USDC → user account`, requiring `minAUSD`, `minUSDC`,
`deadline`, `receiver == user`. If the final swap fails, the **whole transaction reverts** — no partial
state.

## Queued withdraw

`user authorizes request → earnAUSD withdrawal requested → recorded on-chain → Prism records the request
reference → QUEUED`. Displayed as **Withdrawal requested · $X · Processing · Expected within the vault's
documented window** — Prism never promises an exact arrival time.

## Claimable detection (`classifyClaimable`)

Claimability is read from **verified vault/on-chain state**, never a 72-hour local timer. An unknown state
stays `QUEUED` (never optimistically claimable). Once `CLAIMABLE`: **Your withdrawal is ready · $X · [Move
to available balance]** → claim AUSD → convert AUSD→USDC → USDC reaches the user's account.

## Background refresh

The client refreshes withdrawal state on **app launch**, **Save screen open**, and **Activity open**; an
optional backend observer may notify "Your withdrawal is ready." But **chain/vault state determines
claimability** — a notification is a hint, not the source of truth.

## The authorized withdrawal: WithdrawIntent

`WithdrawIntent { owner, mode, vault, shareToken, maxShares, minAUSDOut, minUSDCOut, receiver=owner,
quoteId, deadline, nonce, chainId }`, EIP-712 (domain `PrismSaveWithdraw`). Changing any protected field
invalidates it (`save-withdraw.test.js`); `validateWithdrawIntent` and the iOS `WithdrawIntentGuard`
independently reject a non-owner receiver, foreign vault, over-redeem, wrong chain, or expiry. `nonce` is
single-use → a duplicate request is rejected.

## Reconciliation (`reconcileWithdrawEvidence`)

`AVAILABLE` only when the tx succeeded, shares were redeemed, `ausdReceived ≥ minAUSD`, and
`usdcReceived ≥ minUSDC` **to the user**. Below-minimum / wrong-receiver → `FAILED`. Unknown broadcast →
`REQUIRES_RECONCILIATION` (not retryable — no duplicate request). AUSD received but USDC conversion
incomplete → `RECOVERY_AUSD_HELD` (see [`SAVE_RECOVERY.md`](SAVE_RECOVERY.md)).

## Failures (each has a truthful next step — `withdrawFailureAction`)

| condition | action |
|---|---|
| instant liquidity unavailable | offer Standard |
| instant fee changed | requote |
| request submission ambiguous | reconcile, no duplicate request |
| still queued | wait |
| processed but AUSD→USDC fails | AUSD recovery state (never "failed") |
| swap unavailable | AUSD remains owned by the user, retry conversion |
| share balance insufficient | refresh current state |
| vault paused | truthful unavailable |

## Accounting on withdrawal

Reduce the share position, use the **actual** AUSD redeemed (never quote values), realize yield on the
redeemed portion, reduce the remaining AUSD cost basis **proportionally** (average-cost), and record the
**actual** USDC received. The position reconstructs from chain + the operation projection after restart
(`save-withdraw.test.js` "partial + full withdrawal, then position reconstructs after restart").

## Tests

`backend/test/save-withdraw.test.js` (11): intent mutation, structural validation, instant AVAILABLE,
minimum-output/​wrong-receiver failure, RECOVERY, ambiguous/not-retryable, claimability, duplicate request,
failure actions, modes (no invented fee), partial/full accounting + reconstruction. iOS
`WithdrawIntentGuardTests`.
