# CROSS-BORDER PROOF

**Status: BLOCKED — not demonstrated.** No payment has moved between two aliases in different
country-code regions, because no payment has moved at all (`PAYMENT_PROOF.md`).

## The honest claim, stated precisely

When the loop is live, the defensible claim is:

> USDC-denominated value moves from one human-addressed Prism user to another across national
> borders on Monad, without bank account identifiers and without wallet-address UX.

**There is no FX.** USDC is the unit on both ends. A `+234` sender and a `+44` recipient exchange
the same dollar-denominated token; nothing converts NGN or GBP, and no rate is quoted, sourced, or
applied anywhere in this codebase. Any claim of "cross-border FX" would be false. What is genuinely
cross-border is the *addressing* — a Nigerian phone number pays a UK phone number with no IBAN, no
SWIFT code, no correspondent bank, and no 0x address shown to either person.

## What already supports the framing

- `normalizeE164` accepts any E.164 number (`+[1-9]\d{7,14}`); there is no country allowlist and no
  region-specific branch anywhere in the resolver or identity layer.
- The alias never reaches the chain, so jurisdiction is not encoded on-chain either — the settlement
  is address-to-address USDC regardless of the countries involved
  (`contracts/test/PrismPrivacy.t.sol`).
- `backend/test/privacy-leak.test.js` already exercises a `+234` and a `+44` number through the same
  code path with no divergence.

## What the demonstration still requires

A `+234` sender and a `+44`/`+1` recipient, both with verified numbers (real Twilio Verify, not the
dev OTP adapter), a deployed router, a funded relayer, and test USDC. Then record for each leg:

| Measurement | Source |
|---|---|
| authorization → submission | `signing_wait_ms` + `relay_submit_ms` |
| submission → confirmation | `chain_confirmation_ms` |
| total payment time | `end_to_end_payment_ms` |
| indexing lag | `envio_index_ms` |

All five are already instrumented in `backend/src/lib/metrics.js` and exposed at `GET /v1/metrics`.
None has ever been populated from a real transaction, so no latency figure may be quoted yet.
