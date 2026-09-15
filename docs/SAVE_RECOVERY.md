# SAVE — Recovery (no stranded funds)

The one rule: **a user's money is never stranded and never mislabeled "failed."** Every withdrawal
failure mode has a truthful state and a next step.

## The critical recovery state

A queued withdrawal can finish such that the user **has received AUSD**, but the final **AUSD → USDC
conversion cannot execute** (the swap route is momentarily unavailable, etc.). This is **not** a failure —
the savings *were* withdrawn; only the last conversion leg is pending.

`reconcileWithdrawEvidence` returns **`RECOVERY_AUSD_HELD`** (with `ausdHeldAtomic`) — never `FAILED` —
whenever `ausdReceived ≥ minAUSD` but `usdcReceived < minUSDC`. The AUSD is safe in the user's own Prism
account (they own it; nothing is lost), and the flow presents (`WithdrawView` → `WithdrawTerminalView`):

> **Your savings were withdrawn.**
> $200.xx AUSD is safe in your Prism account.
> We're having trouble converting it to your available USDC balance.
> **[ Try conversion again ]**

"Try conversion again" retries only the AUSD → USDC leg against a refreshed route; the shares are already
redeemed, so it never re-redeems and never double-withdraws.

## Ambiguous submission

If a broadcast's status is unknown, the operation goes to **`REQUIRES_RECONCILIATION`** and is **not
retryable** (`isRetryable` → false). Before any retry, Prism checks the UserOperation / transaction / USDC
delta / AUSD delta / earnAUSD shares — so a Save or a withdrawal request is **never** duplicated.

## Failure → recovery map (`withdrawFailureAction`)

| failure | recovery |
|---|---|
| `conversion_failed_after_claim` | `ausd_recovery` — the state above; AUSD held, retry conversion |
| `swap_unavailable` | `retry_conversion` — AUSD remains the user's, retry when a route returns |
| `submission_ambiguous` | `reconcile_no_duplicate` — check chain state before any retry |
| `instant_unavailable` | `offer_standard` — fall back to the queued path |
| `fee_changed` | `requote` — re-price before authorizing |
| `insufficient_shares` | `refresh_state` — re-read the position |
| `still_queued` | `wait` — the vault hasn't released it yet |
| `vault_paused` | `unavailable` — truthful, no fabricated availability |

## What we never do

- Never call a completed-but-unconverted withdrawal "failed."
- Never strand AUSD without a visible balance + a retry path.
- Never duplicate a request after an ambiguous submission.
- Never claim USDC arrived until canonical evidence shows it reached the user's account.

## Tests

`backend/test/save-withdraw.test.js`: RECOVERY on incomplete conversion; ambiguous → not retryable;
failure actions; duplicate-request rejection.
