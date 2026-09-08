# Canonical Payment Model

The one rule: **every monetary action in Prism is one `PrismPayment`.** Direct sends, request
payments, QR payments, payment-link payments, claim funding, recipient claims and refunds all project
to the *same* canonical shape. There is no feature-specific payment object and no feature-specific
receipt.

## Shape

A canonical payment (`backend/src/lib/lifecycle.js` `canonicalPayment`, iOS `PrismPayment`) carries:

- **identity** — `paymentId` (== `operationId`), `kind`, `direction`, `entryMethod`
- **money** — `amountAtomic`, `asset` (always USDC, surfaced to users as dollars)
- **parties** — `sender`, `recipient` (display identity only: name/@handle — never a phone or raw
  address in consumer surfaces)
- **lifecycle** — `lifecycleState` (consumer vocabulary) projected from the guarded `op.state`
- **correlation** — `requestId`, `claimId`, `resolutionId`, `resolutionVersion`, `transactionHash`,
  `blockNumber`
- **evidence** — an ordered `events[]` log and a `receipt`

Three projections of one operation, always in sync (correlation is tested in
`proof-correlation.test.js`):

```
operation ──▶ canonicalPayment   (summary + lifecycle)
          ├─▶ receiptFor          (consumer receipt)
          └─▶ ProofService        (evidence)
```

## Kinds

| Kind | Entry | Direction |
|---|---|---|
| `payment` / direct | contact / qr / paymentLink | sent · received |
| request payment | request | sent (payer) |
| claim funding | claim | sent (funder) |
| claim collection | claim | received (recipient) |
| refund | internal | received (original sender) |

## Two layers of truth

- **Coarse `op.state`** — a guarded state machine (`ALLOWED_TRANSITIONS`, optimistic-locked). See
  [PAYMENT_LIFECYCLE.md](PAYMENT_LIFECYCLE.md).
- **`events[]`** — an append-only, real-timestamped history. Never synthesized; missing = unknown.

The consumer `lifecycleState` is *projected* from `op.state` + `failureCode` — never a separate mutable
field that can drift.

## Money truth

The chain is the source of truth. The backend records the state machine + event log and projects
consumer language on top. **Transaction submission is never treated as completion** — a payment is
`completed` only after a confirmed receipt (see [PAYMENT_LIFECYCLE.md](PAYMENT_LIFECYCLE.md)).

## Entry points that produce this model

Direct send, request paid, QR payment, payment link, claim funding, recipient claim, refund — all land
on `PaymentDetailsView` via the canonical projection (`GET /v1/payments/:id/canonical`). See
[RECEIPTS.md](RECEIPTS.md) for the one detail surface, [CLAIMS.md](CLAIMS.md) for the claim lifecycle,
[PAYMENT_PROOF.md](PAYMENT_PROOF.md) for evidence, and [QR_AND_LINKS.md](QR_AND_LINKS.md) for the
resolver-unified doorways.
