# Receipts & Payment Details

The one rule: **one canonical detail surface for every payment — no feature-specific dead-end
receipt.** Whether the user arrives from a post-payment success, Activity, a paid request, a claim
(sender or recipient), a refund, or QR / link history, they reach the same `PaymentDetailsView`
rendering the same `PrismPayment`.

## Two surfaces, one truth

- **`ReceiptView`** — the compact, consumer success confirmation shown right after an action ("Sent",
  "Protected for David", "Money received", "Returned"). Every one carries the canonical `operationId`
  and offers **View details** / **View payment**, handing off to the full detail screen. It is a
  confirmation, not a dead end.
- **`PaymentDetailsView`** — the one canonical detail screen. Sections: SUMMARY · LIFECYCLE · RECEIPT ·
  PROOF entry · TECHNICAL. Built from `PaymentDisplay` over the canonical `PrismPayment`
  (`GET /v1/payments/:id/canonical`), reconciled against live chain state on open.

## Entry points (all converge)

| From | Opens |
|---|---|
| Post-payment success | `ReceiptView` → `PaymentDetailsView` |
| Activity row (money) | `PaymentDetailsView` |
| Request paid | `PaymentDetailsView` |
| Claim sender (waiting/expired) | `ClaimDetailView` → View payment → `PaymentDetailsView` |
| Claim recipient (received) | `ReceiptView` → `PaymentDetailsView` |
| Refund | `ReceiptView` → `PaymentDetailsView` |
| QR / payment-link payment | same as direct send |

## Design direction

Consumer fintech, not a blockchain explorer:

- off-white canvas, jade/mint accents, near-black type, thin separators, clean rows, strong spacing
- small monospace **only** where it earns its place (tx hash, references)
- no dense cards, no token icons, no chain-logo overload, no green-checkmark spam

## Honesty

- Timeline steps reflect real event times; a missing step is unknown, never faked.
- "Sent" / "Delivered" appear only after a confirmed receipt — never on submission.
- Failure and attention states carry a specific message and a recovery action (see
  [PAYMENT_LIFECYCLE.md](PAYMENT_LIFECYCLE.md) — no dead ends).

The technical evidence lives one tap deeper in **Payment Proof** — see
[PAYMENT_PROOF.md](PAYMENT_PROOF.md).

## Shared accounts

A payment out of a Circle is not a different object and does not get a different screen. It is the
same `PrismPayment` carrying a `circle` block, and it opens this same `PaymentDetailsView` with one
extra section — paid from which Circle, requested by whom, approved by whom, under which rule. See
[CIRCLE_RECEIPTS.md](CIRCLE_RECEIPTS.md).
