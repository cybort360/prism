# Alchemy Integration

Alchemy is Prism's **primary production Monad RPC provider**. Every chain read and write goes through
it, and Alchemy webhooks provide fast live confirmation. Alchemy handles real-time RPC / submission /
live confirmation; Envio handles indexed queryable history. They are complementary, not two competing
canonical states — the chain is canonical, Alchemy reads/writes it live, Envio indexes it.

## Where

- Provider: `backend/src/providers/alchemyProvider.js` (implements the `ChainProvider` shape).
- Registry + mock: `backend/src/providers/index.js`, `mockChainProvider.js` (tests inject a mock).
- Webhook: `backend/src/providers/alchemyWebhook.js` + route `POST /v1/webhooks/alchemy`.
- Config: `MONAD_RPC_URL` (Alchemy Monad endpoint), `ALCHEMY_WEBHOOK_SIGNING_KEY`.

## What Alchemy powers

| Use | Provider method | Call site |
|---|---|---|
| `eth_call` / token reads | `readContract` | AUSD `balanceOf`, `DOMAIN_SEPARATOR` (`chain/eth.js`) |
| balance reads | `getBalance` (MON), `readContract` (AUSD) | proof surface, Home balance |
| transaction simulation | `simulateContract` | `chain/relay.js#simulateAndWrite` (before every submit) |
| gas estimation | `estimateContractGas` | relayer path |
| transaction submission | `writeContract` | router/vault relaying |
| receipt queries | `getTransactionReceipt` | `paymentService.reconcile` (live confirmation) |
| chainId verification | `getChainId` | startup integrity check |

`MONAD_RPC_URL` should be `https://monad-{mainnet,testnet}.g.alchemy.com/v2/<key>`. Everything routes
through `chainProvider()`, so `setChainProvider(mock)` substitutes a mock in tests — proven by
`backend/test/infra.test.js`, which asserts `simulateContract`, `writeContract`, and
`getTransactionReceipt` are all exercised on the payment path.

## Webhooks (fast live confirmation)

Configure an Alchemy **Address Activity** (or Mined Transaction) webhook for the relayer/router/vault
and point it at `POST /v1/webhooks/alchemy`. The handler:

- **verifies the HMAC-SHA256 signature** (`X-Alchemy-Signature`) over the raw body with
  `ALCHEMY_WEBHOOK_SIGNING_KEY` (constant-time compare) — invalid signature → 401;
- **rejects malformed bodies** → 400;
- **prevents replay / is idempotent** — dedupes by webhook event `id`;
- **never trusts the webhook alone**: it only triggers `reconcileByTxHash`, which reads the receipt
  back from the chain (via Alchemy RPC) before changing any state. A forged or stale webhook cannot
  fabricate completion.

If Monad-compatible Alchemy webhooks are unavailable in your account, the app still confirms via
receipt polling (`GET /v1/payments/:id`); the webhook only makes confirmation faster.

## Gas Manager

The relayer pays MON so users hold MON = 0. In production this is the self-funded `RELAYER_PRIVATE_KEY`
or Alchemy **Gas Manager** sponsorship behind the same submission path.

## Tests

`node --test test/infra.test.js` — Alchemy signature verification (good/bad/malformed), tx-hash
extraction, and the full payment path proving the Alchemy provider is used.
