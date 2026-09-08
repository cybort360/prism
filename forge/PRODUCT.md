# PRODUCT — PRISM

PRISM is an **iPhone-native consumer payments product on Monad**. You pay a person the way a normal
fintech app works — from Contacts, an `@handle`, a QR code, or a payment link — and the app hides
wallet addresses, gas, chain selection, and seed phrases.

## Consumer sentence

> **"Send money to people, not wallet addresses."**

This is the surface promise. It is **not** the load-bearing novelty anymore.

## The load-bearing mechanism: Prism Continuity

> **Human identifiers are mutable reachability *routes*, not financial identities or spending
> authority.**

```
HOW I AM FOUND          phone / @handle / QR / link
        ↓
WHO I AM                persistent PrismIdentity
        ↓
WHO MAY AUTHORIZE       device passkey → Mera-derived secp256k1 account
MY MONEY                (the device-backed credential is the root of authority)
        ↓
WHERE MY MONEY LIVES    a Monad account (that same account holds USDC)
```

Every layer is decoupled from the one above it. A phone number, a handle, a QR, or a link is only a
way to be *found*. None of them is a key, a spending authority, or an on-chain identifier.

## Critical invariant (the product's whole point)

**Reachability may change without silently changing recipient identity.**

- A **legitimate alias change** — e.g. the recipient rotates their phone — that still resolves to the
  **same PrismIdentity and account** must **preserve continuity**: the payer can keep paying them.
- An alias that now resolves to a **different PrismIdentity/account** must **never silently redirect**
  a payment. PRISM visibly **blocks and asks the payer to review** the identity discontinuity.

See [`INVARIANTS.md`](INVARIANTS.md) for where each half is enforced and tested.

## What PRISM is

- A consumer wallet-less payments app: person → amount → Face ID / PIN → sent.
- USDC on Monad, gasless for the user (a relayer pays MON; the user can hold MON = 0).
- Send-before-signup (claims), request payments, QR/links, and cross-chain receive/send (Aurora
  Intents, preview mode) — all projecting to one canonical payment model.

## What PRISM is NOT

- Not a "phone → wallet address" registry. There is no public `phone→wallet` or `SHA(phone)→wallet`
  map; no phone-derived value is emitted on-chain.
- Not custodial: the backend is never the canonical balance authority — Monad token state is.
- Not an app that treats "transaction submitted" as "payment delivered."
- Not (in this build) an ERC-4337 smart-account / raw-P256 signer — that path is archived. See
  [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Related docs (product surfaces)

`../docs/PAYMENT_MODEL.md`, `PAYMENT_LIFECYCLE.md`, `RECEIPTS.md`, `CLAIMS.md`, `PAYMENT_PROOF.md`,
`QR_AND_LINKS.md`, `AURORA_INTENTS.md`.
