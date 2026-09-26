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

## Local run without an Envio API token (RPC mode) — verified recipe

`pnpm dev` uses HyperSync, whose free tier is rate-limited (`remaining=0/0`) — fine with a token
(app.envio.dev/api-tokens → `ENVIO_API_TOKEN`), but blocked without one. This recipe runs the indexer
against a **plain RPC** instead, so no token is needed. It was verified end-to-end against the demo
environment (real Payments/RequestSettlements queryable, `envio.available: true`).

**1. Point the network at an RPC** — temporarily add to the `id: 10143` network in `config.yaml`
(revert for a HyperSync/cloud deploy):

```yaml
    rpc_config:
      url: https://testnet-rpc.monad.xyz
      initial_block_interval: 100   # REQUIRED — Monad public RPC caps eth_getLogs at a 100-block range
      interval_ceiling: 100
    start_block: 65690000           # a recent block near the activity, so the RPC scan is seconds not hours
```

**2. Bring up Postgres + Hasura directly** (bypass `envio dev`, which hangs headless):

```bash
export HASURA_EXTERNAL_PORT=8091 ENVIO_PG_PORT=5455   # 8080 is often taken
docker compose -f generated/docker-compose.yaml -p prism-envio up -d
```

**3. Fix the local toolchain** (Envio's generated project expects Node 18–22 + TS 5; this machine
defaulted to Node 26 + TS 7):

```bash
ln -sfn ../generated node_modules/generated                          # link the `generated` package (else TS2307)
cd generated && pnpm add -D typescript@5.6.3 && cd ..                 # pin TS 5 (ts-node 10.9.1 can't do TS 7)
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"            # Node 20 (Node 26 breaks envio runtime)
export TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS","moduleResolution":"node","esModuleInterop":true}'
#   ^ THE key fix: forces ts-node to emit require() so Node loads the CJS `generated` correctly,
#     instead of an ESM import that fails with "does not provide an export named PrismClaimVault".
```

**4. Codegen + run** (with the addresses the USDC→VaultTransfer filter needs):

```bash
set -a; . ./.env; set +a
export ENVIO_PG_HOST=localhost ENVIO_PG_PORT=5455 ENVIO_PG_USER=postgres ENVIO_PG_PASSWORD=testing \
       ENVIO_PG_DATABASE=envio-dev HASURA_GRAPHQL_ADMIN_SECRET=testing HASURA_EXTERNAL_PORT=8091 TUI_OFF=true
pnpm codegen
pnpm start
```

**5. Track the tables in Hasura.** Envio's bulk-track can 502 during startup; if the entities aren't
in GraphQL (`field 'Payment' not found`), track them manually and grant the `public` role select
(the backend queries unauthenticated):

```bash
node -e 'const e=["Payment","Claim","UsdcTransfer","AccountActivity","RequestSettlement","VaultTransfer"];const a=[];for(const name of e){a.push({type:"pg_track_table",args:{source:"default",table:{schema:"public",name}}});a.push({type:"pg_create_select_permission",args:{source:"default",table:{schema:"public",name},role:"public",permission:{columns:"*",filter:{},allow_aggregations:true}}});}fetch("http://localhost:8091/v1/metadata",{method:"POST",headers:{"content-type":"application/json","x-hasura-admin-secret":"testing"},body:JSON.stringify({type:"bulk",args:a})}).then(r=>r.text()).then(t=>console.log(t.slice(0,80)));'
```

Then `ENVIO_GRAPHQL_URL=http://localhost:8091/v1/graphql` in `backend/.env`, restart the backend, and
`/v1/metrics` reports `envio.available: true`.

## Events → entities

| Contract.event | Entities written |
|---|---|
| `PrismPaymentRouter.PaymentSettled` | `Payment`, two `AccountActivity` (payer sent / recipient received), `RequestSettlement` (if requestId ≠ 0) |
| `PrismClaimVault.ClaimFunded` | `Claim` (Funded), `AccountActivity` (sender) |
| `PrismClaimVault.ClaimCollected` | `Claim` → Claimed, `AccountActivity` (recipient) |
| `PrismClaimVault.ClaimRefunded` | `Claim` → Refunded, `AccountActivity` (sender) |
| `USDC.Transfer` (touching router/vault) | `VaultTransfer` |

The backend queries these via `backend/src/indexers/envioIndexer.js`. See `docs/ENVIO_INTEGRATION.md`.
