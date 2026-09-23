# RECEIVE → Circle/Savings sweep (Sub-project B of 4)

**Date:** 2026-09-23. **Status:** Approved (design).

## Program context

Sub-project B of four that turn dark/preview backend seams into working features (see
`2026-09-23-save-demo-foundation-design.md` for A). Branch `feat/receive-destination-sweep` is cut
from `feat/save-demo-foundation` (A, PR #9) because B's SAVINGS sweep reuses A's MockVault deposit
path + `demoSaveExecutor`; rebase onto `main` once A merges.

Cross-cutting decisions still apply: money-truth (INV-M1/M2 — balances/positions are on-chain reads,
never fabricated); SAVINGS runs in A's demo mode (testnet MockVault), CIRCLE is fully live (real Safe).

## Problem

The RECEIVE facade records a request `destination` (PRIMARY/SAVINGS/CIRCLE) + `circleId`, but
settlement ignores it: a paid request always lands in the requester's primary Mera account. The
SAVINGS branch self-declares "not yet deployed". So "request money straight into my Circle / Savings"
is a data model with no execution.

## Decisions (from brainstorming)

1. **Pre-signed auto-sweep.** The requester signs the sweep authorization at request-creation time
   (exact amount → known Safe/vault, valid until the request expires). On settlement the relayer
   submits it. Non-custodial: funds move only with the requester's signature.
2. **Trigger = the existing settlement hook.** `paymentService.js:595` already calls
   `requestService.markPaid(requestId, …)` when a request payment confirms; the sweep fires from
   there. No background worker; a request-status read also re-tries a PENDING sweep.
3. **Both CIRCLE + SAVINGS, full stack.** All Prism requests are fixed-amount, so exact-amount
   pre-signing always applies.

## Design

### 1. Request-time pre-signing

`prepareReceive({ requesterPrismId, amountAtomic, destination, circleId })` (extends the existing
RECEIVE prepare) returns the request signable PLUS a `sweepAuthorization` to sign:
- **CIRCLE** → a prepared contribution via `circleService.prepareContribution({ circleId, prismId:
  requesterPrismId, amountAtomic })`: its envelope (prismSignature target) + ERC-3009 token
  authorization to the Safe, bound by `contributionHash`. Requester must be an ACTIVE member (checked
  at prepare). Returns `preparedId = contributionId`.
- **SAVINGS** → a MockVault `ReceiveWithAuthorization` (the deposit authorization A already uses),
  built via the demo Save quote path; `preparedId = the persisted save quoteId`.

**Critical — validity window.** A sweep may execute long after request creation (whenever the payer
pays), so every sweep authorization's `validBefore` MUST be set to the request's `expiresAt`, NOT the
short interactive windows A/contributions default to (A's Save quote deadline is 300s; a contribution
prepare sets its own window). The prepare path for a sweep destination therefore overrides the
authorization deadline to the request expiry, and the persisted record (save quote's `deadline` /
contribution's `validBefore`) carries that longer value so the settlement-time submit's expiry check
passes. Both the signed authorization and the stored record use the same `validBefore = expiresAt`.

iOS signs the request (as today) AND the sweep authorization(s) on the Mera account, then commits.
`commit` stores a `sweep` record on the request:
`{ destination, circleId?, preparedId, signatures:{...}, state: 'PENDING', createdAt }`.
PRIMARY requests carry no `sweep` (unchanged behavior).

### 2. SweepService — settlement execution

New `SweepService.executeFor(requestId)`:
- Loads the request; returns early unless it has a `sweep` with `state === 'PENDING'`.
- Transitions `PENDING → SUBMITTED` (guarded, single-flight) then submits via the destination adapter:
  - **CIRCLE** → `circleService.submitContribution({ circleId, contributionId: preparedId,
    prismSignature, tokenSignature })` (relayer; funds → Safe).
  - **SAVINGS** → the MockVault deposit submit from A (`demoSaveExecutor.submitDeposit` against the
    stored quoteId + signature; funds → shares).
- On confirmed success → `state: 'SWEPT'` with the tx hash. On failure/revert/expired → `state:
  'FAILED'` (funds remain safely in the requester's primary account).

Wiring: in the `markPaid` path (`paymentService.js:595`), after `markPaid`, call
`sweepService.executeFor(requestId)` best-effort (never blocks or fails the payer's flow — a thrown
sweep error is caught and logged; the sweep stays retryable). A `GET /v1/requests/:id` (or the
request's activity projection) also calls `executeFor` so a sweep missed at settlement is retried on
read.

### 3. Money-truth, failure & idempotency

- Non-custodial: the sweep is the requester's own exact-amount ERC-3009 signature; balances/positions
  stay on-chain reads (INV-M1/M2). No optimistic credit at the destination.
- **Safe fallback:** a failed sweep leaves the received funds in the requester's primary account —
  never lost, never faked. Surfaced honestly ("received in your balance; couldn't auto-move to
  <destination>").
- **Idempotent:** on-chain ERC-3009 nonce single-use + the `sweep.state` guard means repeated
  `markPaid`/reconciles/reads submit at most once. `SUBMITTED` is not re-submitted; a stuck
  `SUBMITTED` is reconciled from chain, not re-broadcast.

### 4. iOS

Request-creation gains a **destination picker** (Primary / Circle / Savings). Choosing Circle/Savings
calls `prepareReceive` with the destination, then signs the returned `sweepAuthorization` alongside
the request and commits. The request surface shows intent ("auto-deposits into Lagos Trip when paid");
a SAVINGS request shows a demo label (it uses A's demo vault). After settlement the funds appear in
the Circle balance / Savings position via existing reads. A `FAILED` sweep shows the honest fallback
copy.

### 5. Testing

Backend: `prepareReceive` returns + `commit` stores the sweep authorization; `markPaid` triggers
`executeFor`; CIRCLE submits a contribution and SAVINGS submits a vault deposit; a failed sweep leaves
state FAILED and does not touch the primary balance claim; idempotent under repeated `executeFor`
(single submit); a read re-tries a PENDING sweep. iOS: build succeeds; smoke a Circle request and a
Savings request end to end against a demo backend.

## Out of scope (YAGNI)

Open-amount requests (all requests are fixed-amount). The intent-facade migration (sub-project D).
Mainnet/real earnAUSD savings. Multi-destination or partial sweeps.
