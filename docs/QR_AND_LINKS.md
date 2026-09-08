# QR & Payment Links

The one rule: **a Prism QR / link is a doorway into a Prism *identity*, never a wallet-address QR.**
Contacts, phone, @handle, QR and payment links all converge on the same recipient resolver:

```
Contacts  ─┐
Phone     ─┤
@handle   ─┼──▶ Prism Identity ──▶ account ──▶ payment
QR        ─┤
Link      ─┘
```

There is no separate identity meaning for a QR or a link — they resolve through the exact resolver
used by contacts (`POST /v1/resolve/{phone,handle,prism}`).

## Personal QR (reusable)

Every Prism user has one reusable personal QR (`ReceiveView`). It is **recipient-only** and never
single-use. It encodes a universal link:

- With a handle: `https://prism.app/<handle>` (human-verifiable — a scanner sees who they're paying).
- Without a handle: `https://prism.app/pay/<prismId>` (opaque, stable identity route).

A raw wallet address is never shown or encoded.

## Supported link forms

One parser (`PrismDeepLink.parse`) accepts them all and is unit-tested (`DeepLinkTests`):

| Form | Resolves via |
|---|---|
| `prism://pay/<prismId>` | prismId |
| `https://prism.app/pay/<prismId>` | prismId |
| `https://prism.app/<handle>` / `.../@handle` | handle |
| `prism://u/<handle>` | handle |

Reserved path words (`pay`, `u`, `claim`, `request`, `r`) are never mistaken for a handle.

## Optional amount & reference

A link may carry `?amount=` and `?ref=` (e.g. `https://prism.app/octane?amount=20&ref=dinner`). These
are **prefill only**:

- `amount` pre-fills the Send amount field (dropped if non-positive or non-numeric).
- `ref` pre-fills the note.

**An unsigned URL parameter never mutates a signed payment.** The signed settlement envelope is built
from the amount the payer sees and approves at authorization time — not from the URL. Changing the URL
amount after approval is impossible because the URL is not part of the signed payload.

## Scan / open flow

`ScanToPayView` (scan) and `PrismApp.onOpenURL` (universal link) both call
`AppModel.openPaymentLink(_:entryMethod:)`:

1. Parse the link.
2. Resolve the identity (prismId or handle) through the shared resolver.
3. Open the **Send review** (`SendMoneyView`) — recipient, then amount → note → approval → lifecycle →
   `PaymentDetailsView`.

**Never an instant send on scan.** The `entryMethod` (`.qr` for a scan, `.paymentLink` for a link) is
recorded on the canonical payment, so Payment Details and Proof show how the recipient was reached.

## Static vs amount-bound

- **Personal QR** — reusable, recipient-only. Shipped.
- **Amount-bound / request link** — supported end-to-end at the link + resolver + Send-prefill layer
  (`?amount`/`?ref`, tested), so an amount-bound QR is just that link encoded. A dedicated in-app
  request-QR *generator* screen is intentionally not added in this pass (scope: close what exists).

## Privacy

- Links/QRs carry only an opaque prismId or a public @handle — never a phone or wallet address.
- The scan review shows `@handle` when the link used one, or "Prism recipient · Prism verified" for an
  opaque prismId link. The recipient's phone is never exposed.
