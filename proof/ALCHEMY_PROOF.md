# ALCHEMY PROOF

**Status: PARTIAL. No Alchemy API key is configured; no Alchemy endpoint has been called.**
`MONAD_RPC_URL` falls back to the public node `https://testnet-rpc.monad.xyz`.

## Verified

**The webhook HMAC is real and fails closed.** `backend/test/infra.test.js`
*"Alchemy webhook signature verification (good / bad / malformed)"*:

| Input | Result |
|---|---|
| Correct HMAC-SHA256 over the raw body | accepted |
| `deadbeef` | rejected |
| header absent | rejected |
| `extractTxHashes({garbage:true})` | `[]` |

**A webhook can never move state on its own.** `POST /v1/webhooks/alchemy` verifies the signature,
dedupes on `body.id`, and then only ever calls `reconcileByTxHash` → `getTransactionReceipt`. A
forged or replayed webhook triggers a chain readback and nothing else. Verified by reading
`server.js` and by the dedupe path in the route.

**The provider seam is exercised on the payment path.** `infra.test.js` asserts
`simulateContract`, `writeContract`, and `getTransactionReceipt` are all called through
`chainProvider()` — the same interface `alchemyProvider` implements — and that reconciliation reads
a receipt rather than trusting the submission.

**Every write is simulated before broadcast.** `relay.js:simulateAndWrite` calls
`simulateContract` first, so an on-chain revert surfaces before a transaction exists. The relayer is
confined to `settle` / `fundClaim` / `claim` / `refund` on allowlisted contracts with an allowlisted
token.

**Startup integrity checks exist.** `verifyChainId()` and `verifyAusdDomain()` run at boot and, in
production, `process.exit(1)` on drift. The USDC domain is configured from Circle's deployment list
and checked against the live token, so the check would pass rather
than false-alarm.

## Not verified

| Item | Status |
|---|---|
| Any request to an Alchemy Monad endpoint | **never made** — no API key |
| A real receipt read back from Alchemy | **none** |
| A live webhook delivery | **none** — `ALCHEMY_WEBHOOK_SIGNING_KEY` empty |
| Gas Manager sponsorship policy | **not configured**; the MON-funded relayer is the only implemented gas path |

All Alchemy evidence above is from the mock provider and from code review. The Alchemy integration
is *structurally* correct and *operationally* unexercised.
