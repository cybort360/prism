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

## Live pre-user claim (gifting): funding + collection

A sender funded a claim addressed to an unregistered phone; the recipient then onboarded with that
phone (dev OTP) and collected it — dual-signature (backend authorizer eligibility + recipient
`ClaimIntent`), all gasless.

| Step | Tx | Effect |
|---|---|---|
| Fund | `0x322a32da970a4eadb5022fa7655540d674b8d919ffcfe6caab153c5c687e060e` (block 60509080) | USDC payer→vault 2.00; `ClaimFunded` emitted; vault balance 0 → 2.00 |
| Collect | `0xe6e8c97e9b6751cbac5c96eb7fc1f71073cb31551fde878e79dc7e91bc46762e` (block 60509093) | USDC vault→recipient 2.00; `ClaimCollected` emitted; recipient 0 → 2.00 |

Both receipts status `1`; relayer `0x234D…a117` paid gas; the claim recipient's MON balance is `0`
(gasless). Eligibility was matched by the recipient's verified phone, and the vault verified both the
authorizer's eligibility signature and the recipient's own `ClaimIntent`.

**Refund (after expiry):** claim `0x7bbec9376c5e230846585aa5fdff01ecaf512cef28c0822fb0b45c9f1ed54856`
was funded (`0xa5833a9ddc476ef48c1e606e3e4ce3c300bfb899da6e44038626a52327746057`), and after its 1-hour
expiry the sender refunded it: refund tx
`0xe5d3a758bdf87a7db21deaa3fa13ab5ed12162794e16f933b3c1be224711abf0` (block 60559611, status `1`),
`ClaimRefunded` emitted, USDC vault→sender 1.50, claim status now `3` (Refunded), relayer paid gas.
The full claim lifecycle (fund → collect, fund → refund) is proven live.

## Still open (see TODO.md)

Live Envio indexing of `PaymentSettled`, live Alchemy webhook delivery, physical-device flows, and
published latency figures.
