# Payment Lifecycle

The one rule: **no screen treats "transaction submitted" as "payment delivered."** A payment is
delivered only after the chain confirms and effects reconcile. Money truth is the chain; the backend
records a guarded state machine + an append-only event log, and projects consumer language on top.

## Two layers

- **Coarse persisted `op.state`** — the guarded state machine (`backend/src/lib/lifecycle.js`
  `ALLOWED_TRANSITIONS`). Small, auditable, optimistic-locked via `transitionPayment(id,
  expectedCurrentState, nextState, evidence)`.
- **Ordered `events[]`** — the rich lifecycle history (created → authorized → submitted → confirming →
  confirmed → reconciled → completed → indexed …), each with a `source` and real `occurredAt`. Never
  derived from one mutable field; never synthesized (missing = unknown, `nil`).

The canonical `lifecycleState` (consumer vocabulary) is projected from `op.state` + `failureCode`.

## Internal states → consumer labels

| Persisted `op.state` | Canonical | Direct payment | Claim funding | Recipient claim | Refund |
|---|---|---|---|---|---|
| prepared | created | Preparing… | Protecting $X for D… | — | Refund created |
| broadcasting | submitted | Sending… | Protecting $X for D… | Verifying… | Returning your money… |
| submitted | submitted | Sending… | Protecting $X for D… | Verifying… | Returning your money… |
| confirming | confirming | Settling… | Protecting $X for D… | Receiving… | Returning your money… |
| completed | completed | **Sent** | **Protected for David** | **Received** | **Refunded** |
| requires_attention (SUBMISSION_AMBIGUOUS) | requiresAttention | Checking whether this was submitted | | | |
| reconciliation_required (PROVIDER_DISAGREEMENT) | requiresAttention | Verifying final details | | | |
| failed | reverted / failedTerminal | Failed | | | |
| expired | expired | Expired | | Claim expired | |

Envio **indexing** is a later, non-blocking projection surfaced by a separate `indexed` flag/event —
it never downgrades a delivered payment.

## Allowed transitions (guarded)

```
prepared            → broadcasting | failed | expired
broadcasting        → submitted | prepared | confirming | requires_attention | failed
submitted           → confirming | completed | failed | reconciliation_required
confirming          → completed | failed | reconciliation_required
requires_attention  → confirming | prepared | completed | failed
reconciliation_required → completed | failed | requires_attention
expired             → refunding | expired
refunding           → completed | failed
completed           → (terminal — immutable)
failed              → (terminal)
```

Rejected examples: `prepared → completed`, `submitted → completed` without a receipt (the code only
calls that transition *with* a confirmed receipt), `completed → processing`, `refunded → claimed`.
`assertTransition` throws HTTP 409 on any illegal transition or optimistic-lock mismatch.

## Failure / recovery matrix

| Code | Persisted state | Canonical | Retryable | Recovery |
|---|---|---|---|---|
| RESOLUTION_FAILED | failed | failedRetryable | yes | re-resolve recipient |
| IDENTITY_CHANGED | failed | identityChanged | no | re-confirm the recipient identity |
| AUTHORIZATION_CANCELLED | prepared | cancelled | yes | re-authorize |
| AUTHORIZATION_FAILED | prepared | failedRetryable | yes | re-authorize |
| INSUFFICIENT_USDC | failed | failedRetryable | yes | add money |
| SIGNATURE_EXPIRED | failed | expired | yes | re-prepare |
| RELAY_UNAVAILABLE | prepared | failedRetryable | yes | retry |
| SUBMISSION_FAILED | prepared | failedRetryable | yes | retry (provably not broadcast) |
| SUBMISSION_AMBIGUOUS | requires_attention | requiresAttention | **no** | Prism reconciles from chain first |
| TRANSACTION_REVERTED | failed | reverted | no | inspect + re-prepare |
| RPC_UNAVAILABLE | confirming | confirming | no | keep polling |
| PROVIDER_DISAGREEMENT | reconciliation_required | requiresAttention | no | independent readback |
| INDEXING_DELAYED | completed | completed | — | not a failure |
| RECONCILIATION_REQUIRED | reconciliation_required | requiresAttention | no | independent readback |
| CLAIM_VERIFICATION_FAILED | failed | failedTerminal | no | funds stay protected in the vault |
| CLAIM_EXPIRED | expired | expired | no | refund becomes available |

## Ambiguous submission (critical)

If broadcast succeeds but the relayer response is lost, Prism does **not** resubmit. It enters
`requires_attention` / `SUBMISSION_AMBIGUOUS` and shows *"Prism is checking whether this payment was
submitted. Don't retry yet."* On the next call it reconciles from chain truth — the ERC-3009 nonce is
consumed in the same tx that moves the money, so `authorizationState(payer, nonce)` is authoritative.
Only after **proving absence** (nonce unused) is a retry re-armed. Covered by
`mutation-audit.test.js` (MUT-16) and `lifecycle-rigor.test.js`.

## Provider disagreement

A receipt that is neither a clear success nor a clear revert → `reconciliation_required` /
`PROVIDER_DISAGREEMENT`, reason persisted. Never silently picks a result. Consumer sees only "Prism is
verifying the final payment details"; the technical view may show the reason.

## Canonical evidence per transition

| Transition | Evidence | Source |
|---|---|---|
| → created | envelope prepared | app |
| → authorized | user PIN/Face ID approval | userAuthorization |
| → submitted | relayer returned a tx hash | relayer |
| → confirming | receipt not yet mined | monad |
| → confirmed | receipt.status = success | monad (Alchemy RPC) |
| → reconciled / completed | effects applied from chain state | backend |
| → indexed | Envio has the `PaymentSettled` row | envio |
| → reverted / failed | receipt.status = reverted | monad |
| → requires_attention | ambiguous broadcast | relayer |
| → reconciliation_required | indeterminate / disagreeing receipt | backend |

## Idempotency

Every submission endpoint (send, claim, collect, refund) is idempotent by `(scope, actor,
Idempotency-Key)` with a **request fingerprint**: same key + same fingerprint → the existing operation
is returned; same key + **different** fingerprint → **409 rejected**. Reservation is atomic (one
synchronous `mutate`), so concurrent submits execute the mutation at most once.

## Timestamps

Real event times only. `confirmedAt` is when the receipt confirmed — never `submittedAt + 1s`. Missing
stays `nil`/unknown.

## State restoration

State lives in the store + event log, so a relaunch reconstructs any pending lifecycle. Entering
Payment Details or Activity reconciles the operation (`GET /v1/payments/:id/canonical` reconciles
first), resuming a `confirming` / `requires_attention` op rather than losing it.
