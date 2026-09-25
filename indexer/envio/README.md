# Prism Envio indexer

Indexes Prism's real Monad activity into a queryable GraphQL API the backend consumes for reconciled
historical activity. HyperSync/HyperIndex support Monad with full history from block 0.

## Run

`config.yaml` is already pointed at the **demo environment** (mock-pinned router + MockUSDC). The
USDC-transfer filter also needs the router/vault addresses in the process env — copy `.env.example`:

```bash
cd indexer/envio
cp .env.example .env          # PRISM_PAYMENT_ROUTER / PRISM_CLAIM_VAULT (demo addresses)
pnpm install
pnpm dev                      # codegen + local indexer (Docker: Postgres+Hasura) + GraphQL
```

`envio dev` renders an interactive TUI, so **run it in a real terminal** (it hangs headless). GraphQL
lands at `http://localhost:8080/v1/graphql`.

**If port 8080 is already taken** (other Docker projects), move Hasura off it:

```bash
export HASURA_EXTERNAL_PORT=8091 ENVIO_PG_PORT=5455   # or any free ports
pnpm dev                                              # GraphQL now at http://localhost:8091/v1/graphql
```

Point the backend at whichever port you used, then restart it:
`ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql` (or `:8091`). `/v1/metrics` will then report
`envio.available: true`.

## Events → entities

| Contract.event | Entities written |
|---|---|
| `PrismPaymentRouter.PaymentSettled` | `Payment`, two `AccountActivity` (payer sent / recipient received), `RequestSettlement` (if requestId ≠ 0) |
| `PrismClaimVault.ClaimFunded` | `Claim` (Funded), `AccountActivity` (sender) |
| `PrismClaimVault.ClaimCollected` | `Claim` → Claimed, `AccountActivity` (recipient) |
| `PrismClaimVault.ClaimRefunded` | `Claim` → Refunded, `AccountActivity` (sender) |
| `USDC.Transfer` (touching router/vault) | `VaultTransfer` |

The backend queries these via `backend/src/indexers/envioIndexer.js`. See `docs/ENVIO_INTEGRATION.md`.
