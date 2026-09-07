# Testnet Deployment & Live Payment Proof

**Status: DEPLOYED and settling real payments on Monad testnet (chainId 10143).**

Prism's payment surface is live on-chain, and a real gasless USDC payment has settled through it. The
canonical addresses live in `deployments/monad-testnet.json` (never in Swift source).

## Deployed contracts (Monad testnet, chainId 10143)

| Contract | Address |
|---|---|
| PrismPaymentRouter | `0x423a9Da22b1509e7593F4A60f62e6929B56f62b7` |
| PrismClaimVault | `0xBe3D0b0404674e032D153182a58b1901D1d6Eae3` |
| Circle USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| Claim authorizer | `0x27b17d6901885a7049a4c774e1EA1eBaf4146641` |
| Deployer / relayer | `0x234D418a69d88eEE7965C11D6994B60dd567a117` |

On-chain reads confirm `router.usdc()` and `vault.usdc()` both point at Circle USDC and
`vault.claimAuthorizer()` is the configured authorizer. The backend's startup integrity checks pass
against the live chain: `integrity.chainId ok (10143)` and `integrity.usdcDomain ok` (the recomputed
USDC EIP-712 domain matches the deployed token).

## Live gasless payment

A real direct payment settled through the deployed router (USDC `receiveWithAuthorization` → forward):

| Field | Value |
|---|---|
| Tx hash | `0x254e8281d1b978c55ef2e8dd78f91566658a964c9692a86534c0764d9659c8f7` |
| Block | 60506783 |
| Receipt status | `1` (success) |
| To (contract) | `0x423a9Da22b1509e7593F4A60f62e6929B56f62b7` (PrismPaymentRouter) |
| paymentId | `0x1460288a6e57ea4cf8b25512e0fb6db6ccc854851e748e0b0532007c209f8c86` |
| `router.paymentUsed(paymentId)` | **true** (consumed through `settle()`) |
| Payer USDC | 20.000000 → **19.000000** (−1.00) |
| Recipient USDC | 0 → **1.000000** (+1.00) |
| Gas paid by | relayer `0x234D…a117` (gasUsed 279,781) |
| **Payer MON balance** | **0** — the payer never held or spent MON (gasless) |

This exercises the full path end to end: onboarding (non-replayable bind challenge, F-07), resolver
attestation, `preparePayment`, the payer's Mera-equivalent signatures over the Prism `PaymentEnvelope`
and the USDC `ReceiveWithAuthorization` addressed to the router (F-01), relayer submission, on-chain
settlement, and receipt reconciliation (`state: completed`). `indexed: false` because Envio was not
running for this run — honest indexing state, never faked.

## Reproduce

1. `deployments/monad-testnet.json` holds the addresses. Point `backend/.env` at them plus a
   MON-funded `RELAYER_PRIVATE_KEY` and the `CLAIM_AUTHORIZER_PRIVATE_KEY`, and export them (the
   backend reads `process.env`, it does not load `.env`): `set -a; source .env; set +a; node src/server.js`.
2. Fund a payer account with testnet USDC.
3. Drive onboarding → resolve → prepare → sign envelope + `receiveWithAuthorization` → submit; the
   relayer settles through `PrismPaymentRouter`.
4. Verify on-chain with `cast receipt <tx>`, `cast call <router> 'paymentUsed(bytes32)(bool)' <id>`,
   and `cast balance <payer> --ether` (expect 0).

## Still open (see TODO.md)

Live claim funding/collection/refund on-chain, live Envio indexing of `PaymentSettled`, live Alchemy
webhook delivery, physical-device flows, and published latency figures.
