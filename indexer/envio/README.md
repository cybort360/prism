# Prism Envio indexer

Indexes Prism's real Monad activity into a queryable GraphQL API the backend consumes for reconciled
historical activity. HyperSync/HyperIndex support Monad with full history from block 0.

## Run

```bash
cd indexer/envio
# set the deployed router + vault addresses in config.yaml (currently 0x0…0),
# and export them so the AUSD-transfer filter can match:
export PRISM_PAYMENT_ROUTER=0x... PRISM_CLAIM_VAULT=0x...
npx envio dev          # codegen + local indexer + GraphQL at http://localhost:8080/v1/graphql
```

Point the backend at it: `ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql`.

## Events → entities

| Contract.event | Entities written |
|---|---|
| `PrismPaymentRouter.PaymentSettled` | `Payment`, two `AccountActivity` (payer sent / recipient received), `RequestSettlement` (if requestId ≠ 0) |
| `PrismClaimVault.ClaimFunded` | `Claim` (Funded), `AccountActivity` (sender) |
| `PrismClaimVault.ClaimCollected` | `Claim` → Claimed, `AccountActivity` (recipient) |
| `PrismClaimVault.ClaimRefunded` | `Claim` → Refunded, `AccountActivity` (sender) |
| `AUSD.Transfer` (touching router/vault) | `VaultTransfer` |

The backend queries these via `backend/src/indexers/envioIndexer.js`. See `docs/ENVIO_INTEGRATION.md`.
