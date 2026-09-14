# SAVE — Lifecycle

State machines in `backend/src/lib/saveLifecycle.js`. Pure. Three machines; `FAILED` is a fail-closed
sink reachable from any non-terminal state. Transitions are linear (no skipping) — `canTransition(kind,
from, to)` and `isTerminal(kind, state)` enforce this.

## Deposit (`SAVE`)

```
CREATED → QUOTING → QUOTED → AWAITING_AUTHORIZATION → AUTHORIZED → SUBMITTED
        → SWAPPING → DEPOSITING → CONFIRMING → CONFIRMED → RECONCILING → SAVED
```

Consumer sees three phases only (`consumerPhase`):

| consumer | backend states |
|---|---|
| **Preparing…** | CREATED, QUOTING, QUOTED, AWAITING_AUTHORIZATION, AUTHORIZED |
| **Saving…** | SUBMITTED, SWAPPING, DEPOSITING, CONFIRMING, CONFIRMED, RECONCILING |
| **Saved** | SAVED |

## Withdraw — instant (`WITHDRAW_INSTANT`)

```
CREATED → QUOTED → AUTHORIZED → REDEEMING → CONVERTING_TO_USDC → CONFIRMING → AVAILABLE
```
Consumer: **Withdrawing…** → **Available**.

## Withdraw — queued (`WITHDRAW_STANDARD` / `CLAIM_WITHDRAWAL`)

```
CREATED → AUTHORIZED → WITHDRAWAL_REQUESTED → QUEUED → CLAIMABLE
        → CLAIMING → AUSD_RECEIVED → CONVERTING_TO_USDC → AVAILABLE
```
Consumer: **Withdrawal requested** (WITHDRAWAL_REQUESTED, QUEUED) → **Ready** (CLAIMABLE) →
**Processing** (CLAIMING, AUSD_RECEIVED, CONVERTING_TO_USDC) → **Available** (AVAILABLE).

The queued path reflects earnAUSD's real redemption model: a request processed within ~72h (Upshift
processes daily), or an instant redemption for a small fee (the instant machine).

## Semantic steps are NOT fabricated timestamps

A single sponsored transaction may expose only **one** atomic receipt. So intermediate states like
`SWAPPING`, `DEPOSITING`, `RECONCILING`, `REDEEMING`, `CONVERTING_TO_USDC`, `QUEUED`, `CLAIMING`,
`AUSD_RECEIVED` are **semantic proof steps**, not separately-observed times. Only states that correspond
to a real observed event may carry a timestamp (`timestampField`):

| state | timestamp |
|---|---|
| CREATED | `createdAt` |
| AUTHORIZED | `authorizedAt` |
| SUBMITTED / WITHDRAWAL_REQUESTED | `submittedAt` |
| CONFIRMED / CLAIMABLE | `confirmedAt` |
| SAVED / AVAILABLE | `completedAt` |

Everything else returns `null` from `timestampField` — the one receipt stamps `confirmedAt` once, and the
proof steps are shown as structure, never as invented observed times.

## Tested (`backend/test/save-accounting.test.js`)

legal transitions + no skipping · SAVED/AVAILABLE terminal · FAILED reachable · consumer phases hide the
substrate vocabulary · semantic steps carry no fabricated timestamp.
