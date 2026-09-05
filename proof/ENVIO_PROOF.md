# ENVIO PROOF

**Status: PARTIAL. The indexer is configured and its handlers exist, but no Envio deployment has
run and nothing has been indexed.** `ENVIO_GRAPHQL_URL` is empty.

## Verified statically

**Event signatures match the compiled contracts exactly.** This is the failure mode that silently
indexes nothing, so it was checked by hash rather than by eye:

| Event | topic0 | In compiled ABI |
|---|---|---|
| `PaymentSettled(bytes32,address,address,address,uint256,bytes32,bytes32)` | `0x81376b183f750cb90f88b90eb5a43709fe4320c357d56a3591d5742fc3577788` | yes (`PrismPaymentRouter`) |
| `ClaimFunded(bytes32,address,address,uint256,uint256,bytes32)` | `0x79ad4866387321b9e18c7a310e8a09bd2f24fb305007cad774670a6a9919b1cb` | yes (`PrismClaimVault`) |
| `ClaimCollected(bytes32,address,address,uint256)` | `0x49bf623525297e546347a6781eb7ca10fb87963825aab67c0d3298f00c62a495` | yes |
| `ClaimRefunded(bytes32,address,address,uint256)` | `0xd93caf7c894b685e08da5d8b1ca607e35ccebdccc9d19ce31e7840611eaa9d56` | yes |
| `Transfer(address,address,uint256)` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` | USDC |

Indexed argument positions in `config.yaml` match the `indexed` keywords in the Solidity sources.

**Network config is correct**: `id: 10143`, `start_block: 0`, with the USDC testnet address
pinned in `config.yaml`.

**Envio is a consumer, never a source of financial truth.** `PaymentService.reconcile` decides
`completed` / `failed` **only** from an on-chain receipt; `_checkIndexing` then annotates whether
Envio has caught up, and returns the record unchanged if the indexer is unavailable. Asserted by
`backend/test/infra.test.js`: *"completed payment stays 'not indexed' until Envio catches up (no
fake completion)"*, and *"payment path uses the Alchemy provider AND the Envio consumer"* which
asserts `mockEnvio.calls.isPaymentIndexed >= 1`.

## Not verified

| Item | Status |
|---|---|
| `npx envio codegen` / `envio dev` runs | **never executed** |
| `src/EventHandlers.ts` compiles | **never executed** |
| `schema.graphql` matches the handlers | **not validated** |
| Any event indexed from Monad | **none — no contracts deployed** |
| `PaymentSettled` observable in GraphQL | **no** |
| Router / vault addresses in `config.yaml` | still `0x0000000000000000000000000000000000000000` placeholders |

## To prove it

```bash
cd indexer/envio
# replace both 0x000…000 placeholders with the deployed addresses first
export PRISM_PAYMENT_ROUTER=0x… PRISM_CLAIM_VAULT=0x…
npx envio dev        # codegen + indexer + GraphQL on :8080
# then query the settled payment by paymentId and compare against the receipt
```
