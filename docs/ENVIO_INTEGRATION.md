# Envio Integration

Envio HyperIndex indexes Prism's real Monad activity into a queryable GraphQL API that the backend
consumes for reconciled historical activity and indexing/finality state. **The chain is canonical;
Envio never fabricates financial truth.** If Envio lags, the app shows an indexing state rather than
faking completion.

## Where

- Indexer: `indexer/envio/` (`config.yaml`, `schema.graphql`, `src/EventHandlers.ts`).
- Backend consumer: `backend/src/indexers/envioIndexer.js` (+ registry `index.js`, mock `mockEnvioIndexer.js`).

## Events indexed

| Contract.event | Writes |
|---|---|
| `PrismPaymentRouter.PaymentSettled(paymentId, payer, recipient, amount, requestId, resolutionHash)` | `Payment`, two `AccountActivity` rows, and `RequestSettlement` when applicable |
| `PrismClaimVault.ClaimFunded(claimId, sender, amount, expiry, recipientReference)` | `Claim` Funded, `AccountActivity` sender row |
| `PrismClaimVault.ClaimCollected(claimId, recipient, amount)` | `Claim` Claimed, `AccountActivity` recipient row |
| `PrismClaimVault.ClaimRefunded(claimId, sender, amount)` | `Claim` Refunded, `AccountActivity` sender row |
| `USDC.Transfer` touching router/vault | `VaultTransfer` |

No phone number, phone hash, or handle is ever indexed — only opaque paymentId/claimId/references.

## Schema (entities)

`Payment`, `Claim`, `AccountActivity` (one row per account per event → cheap sender/recipient
history), `RequestSettlement` (on-chain proof a payment fulfilled a request), `VaultTransfer`. Full
definitions in `indexer/envio/schema.graphql`.

## App surfaces powered

| Surface | Query |
|---|---|
| Activity / receipts / sender-recipient history | `getAccountActivity(account)` |
| Claim history | `getClaims(account)` |
| Payment finality / **indexing state** | `isPaymentIndexed(paymentId)` (drives `indexed` on GET /v1/payments/:id) |
| Proof dashboard | `getPayment(paymentId)` + `getRequestSettlement(requestId)` |

The backend calls these in `paymentService._checkIndexing` (annotates a confirmed payment as indexed
and records `envio_index_ms`) and `proofService` (proof surface).

## Latency measurement

The backend records `envio_index_ms` = time from on-chain confirmation to when Envio first returns
the `PaymentSettled` for a payment. Exposed via `GET /v1/metrics` (P50/P95). On testnet, HyperIndex
typically indexes within a few seconds of confirmation; measure the live P50/P95 from the metrics
endpoint during the demo.

## Failure behavior

- `ENVIO_GRAPHQL_URL` unset or endpoint unreachable → every query returns `null`/`[]`; the payment
  still shows its **chain-confirmed** state with `indexed: false`. The chain remains canonical.
- A confirmed-but-not-yet-indexed payment reports `state: "completed", indexed: false` — an honest
  "confirmed, indexing…" state, never a fake completion. Proven by
  `backend/test/infra.test.js` ("stays not indexed until Envio catches up").

## Exact judge demo

1. `cd indexer/envio && export PRISM_PAYMENT_ROUTER=… PRISM_CLAIM_VAULT=… && npx envio dev`.
2. Point the backend at it: `ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql`.
3. Make a payment in the app. `GET /v1/payments/:id` flips `indexed: false → true` once Envio indexes
   the `PaymentSettled`; `GET /v1/proof/:paymentId` shows the `envioProof` (indexed Payment row) and,
   for a request payment, the `requestSettlement` binding.
4. `GET /v1/metrics` shows `envio_index_ms` P50/P95 — the measured indexing latency.
