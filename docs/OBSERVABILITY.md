# Observability

Prism instruments the payment path with latency histograms and success/failure counters, and exposes
a developer/judge Proof surface. `backend/src/lib/metrics.js` + `GET /v1/metrics`.

## Metrics

| Metric (ms) | Measured span |
|---|---|
| `payment_prepare_ms` | backend work to prepare the envelope + USDC typed data |
| `signing_wait_ms` | prepare → submit (user local approval + Mera signing) |
| `relay_submit_ms` | Alchemy simulate + submit (`relaySettle`) |
| `chain_confirmation_ms` | submit → on-chain receipt confirmed |
| `envio_index_ms` | confirmation → Envio has indexed `PaymentSettled` |
| `end_to_end_payment_ms` | prepare → confirmed |

Each metric exposes **P50** and **P95** and a sample count. The `payment` operation counter exposes
**success**, **failure**, and **failure rate**. `GET /v1/metrics` returns
`{ chain: { provider, rpcHost }, envio: { available }, latencies, operations }`.

## Redaction

The logger and metrics **never** record: phone number, OTP, PIN, passkey material, private keys, or
full authorization signatures. Only opaque identifiers (paymentId, claimId, prismId, addresses, tx
hashes) and durations are logged. Structured logs are JSON via `lib/logger.js`.

## Proof surface (developers/judges only)

`GET /v1/proof/:paymentId` (enabled outside production, or via `PROOF_ENABLED=true`; never shown to
normal consumers). It combines live Alchemy reads + the Envio index + recorded timings:

- Monad network (chainId, RPC host, provider name) and the USDC address
- the payer's **Mera account** and recipient
- **sender MON balance** and **sender USDC balance** (proving pay-with-MON = 0)
- paymentId, tx hash, block number, state
- **submitted / confirmed / indexed** times
- **Envio proof** (indexed `Payment` row) and, if relevant, the **request binding** (`RequestSettlement`)
- **recipient USDC before / after** (after = live read; before = after − amount once confirmed)

The iOS app surfaces this on a **dev-only Proof screen** (Profile → Developer → Payment proof), gated
to DEBUG builds. It is not part of the normal consumer UX.

## Judge demo

1. Make a payment; open the Proof screen (or `GET /v1/proof/:paymentId`).
2. See sender MON = 0, sender/recipient USDC before→after, tx hash, and submitted→confirmed→indexed
   timeline.
3. `GET /v1/metrics` shows P50/P95 for every stage and the payment failure rate.
