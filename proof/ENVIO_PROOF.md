# ENVIO PROOF

**Status: PARTIAL. The indexer is configured and its handlers exist, but no Envio deployment has
run and nothing has been indexed.** `ENVIO_GRAPHQL_URL` is empty.

## Verified statically

**Event signatures match the compiled contracts exactly.** This is the failure mode that silently
indexes nothing, so it was checked by hash rather than by eye:

| Event | topic0 | In compiled ABI |
|---|---|---|
| `PaymentSettled(bytes32,address,address,uint256,bytes32,bytes32)` | `0xf916f88fd8baedabb3b5c456adb67845f6d09066a795a1c45ab1514b8e69e5ce` | yes (`PrismPaymentRouter`) |
| `ClaimFunded(bytes32,address,uint256,uint256,bytes32)` | `0x32a5498fc7bbd5ecf5b79230918410d94e8cf9ecadcf67623dcaef7850d33762` | yes (`PrismClaimVault`) |
| `ClaimCollected(bytes32,address,uint256)` | `0xa68c0592a52a5828ac22d322c52e76b82fbaefad1366f75b2c86ea8d0eab3408` | yes |
| `ClaimRefunded(bytes32,address,uint256)` | `0x3ca63ba5011c703242c9100cc39d2231bc63c211b6b77985fce6ce8b66fbb46a` | yes |
| `Transfer(address,address,uint256)` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` | AUSD (standard ERC-20) |

Indexed argument positions in `config.yaml` match the `indexed` keywords in the Solidity sources.

**Network config is correct**: `id: 10143`, `start_block: 0`, AUSD pinned to
`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` — the address independently verified live in
`AGORA_AUSD_PROOF.md`.

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
