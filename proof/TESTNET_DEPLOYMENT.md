# TESTNET DEPLOYMENT

**Status: BLOCKED — not deployed. No contract of this codebase exists on Monad testnet.**

`deployments/monad-testnet.json` is a placeholder. There are no Prism contract addresses, no
deployment transactions, and no verified sources. Nothing in `proof/` should be read as implying
otherwise.

## What the chain access proves

Monad testnet itself is reachable and healthy from this environment:

| Check | Result |
|---|---|
| `eth_chainId` | `0x279f` = `10143` |
| `eth_blockNumber` | `0x38b79b0` = `59477252` at 2026-09-03T23:51:03Z |
| Agora AUSD at `0xa9012a…22dC` | live, correct domain and ERC-3009 surface — see `AGORA_AUSD_PROOF.md` |

So the blocker is not connectivity or the target contracts. It is credentials and funds.

## Why it is blocked

| Requirement | State | Evidence |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` funded with MON | **absent** | `contracts/.env` — variable present, value empty |
| `CLAIM_AUTHORIZER_ADDRESS` | **absent** | `contracts/.env` — empty |
| `RELAYER_PRIVATE_KEY` funded with MON | **absent** | `backend/.env` — empty |
| Test AUSD for the sender account | **unobtainable here** | `mint(address,uint256)` exists on the live token but is role-gated: `eth_call` from an arbitrary address reverts `AddressIsNotMinterRole`. Test AUSD must come from Agora. |
| Testnet MON | **unobtainable here** | `faucet.monad.xyz` returns HTTP 429 behind a Vercel bot checkpoint; there is no unauthenticated claim endpoint. |
| Alchemy Monad API key | **absent** | `MONAD_RPC_URL` falls back to the public node |
| Envio HyperIndex deployment | **absent** | `ENVIO_GRAPHQL_URL` empty |
| Twilio Verify | **absent** | `TWILIO_*` empty — OTP runs the dev adapter |

A key can be generated in a second; funding it cannot be automated past a captcha, and AUSD cannot
be minted without Agora's minter role. Both need a human with a browser.

## Unblock sequence

```bash
# 1. Generate and fund the deployer + relayer (human step at the faucet UI)
cast wallet new                          # ×2: deployer, relayer
#    fund both at https://faucet.monad.xyz
# 2. Generate the isolated claim authorizer (KMS/HSM in production)
cast wallet new                          # → CLAIM_AUTHORIZER_PRIVATE_KEY / _ADDRESS
# 3. Obtain test AUSD for the sender account from Agora
# 4. Deploy
cd contracts && source .env
forge script script/Deploy.s.sol --rpc-url "$MONAD_TESTNET_RPC_URL" --broadcast
#    writes deployments/monad-testnet.json
# 5. Verify
forge verify-contract <router> src/PrismPaymentRouter.sol:PrismPaymentRouter --chain 10143
forge verify-contract <vault>  src/PrismClaimVault.sol:PrismClaimVault   --chain 10143
# 6. Point the backend and the indexer at the deployed addresses
#    backend/.env: PRISM_PAYMENT_ROUTER, PRISM_CLAIM_VAULT, RELAYER_PRIVATE_KEY,
#                  CLAIM_AUTHORIZER_PRIVATE_KEY, MONAD_RPC_URL, ENVIO_GRAPHQL_URL
#    indexer/envio/config.yaml: the two 0x000…000 placeholders
```

The deploy script is ready and reads every address from the environment — no address is hardcoded
into Swift, and the manifest is generated rather than hand-written.

## Judge-build note

The brief requires no localhost dependency in a judge build. That is **not currently satisfied**:
`PRISM_API_BASE_URL` defaults to `http://127.0.0.1:8787` and `ENVIO_GRAPHQL_URL` is unset. The
backend, resolver, relayer, and Envio indexer must be deployed to reachable hosts and those two
values repointed before a judge build is honest.
