# Prism — Metropolis Sponsor Matrix

Primary track: **Consumer Products & Payments**. Prism is an iPhone-native consumer payments app:
pay a person by Contacts / @handle / QR / link, approve with Face ID or PIN, done — no gas, MON,
wallet, seed phrase, network, or address in the normal flow.

| Sponsor | Requirement | Prism mechanism | Source files | Demo proof | Status |
|---|---|---|---|---|---|
| **Monad Foundation** | Best Mera-Powered UX on Monad | Mera passkey-derived account is the **only** consumer signing layer. Onboarding is a Face ID prompt (no seed phrase); recovery is signing in again; scoped, expiring signing sessions avoid a passkey sheet per tap; high-risk actions re-authenticate. | `ios/MeraBridge/*` (`MeraAccountService`, `WKWebViewMeraBridge`, `MeraAccountManager`, `web/src/bridge.js`), `ios/Prism/Services/PrismAPI.swift`, `ios/Prism/Services/PaymentCoordinator.swift` | iOS build + tests green; onboarding/pay/claim flows drive the bridge; `docs/SECURITY.md` session policy | Implemented; device passkey run needs the built web bundle + RP domain |
| **Envio** | Best Use of Envio | HyperIndex indexes the product's real activity: USDC `Transfer`, router `PaymentSettled`, and vault claim events. The app's activity feed and reconciliation read the Envio GraphQL endpoint. | `PrismPaymentRouter.sol` / `PrismClaimVault.sol` events, `backend/src/config.js` (`ENVIO_GRAPHQL_URL`), `indexer/envio/` config | Router/vault emit indexed events by design; `ENVIO_GRAPHQL_URL` wired | Events + config implemented; indexer deployment is an external step |
| **Alchemy** | Best Projects using Alchemy | Alchemy Monad RPC is Prism's production node (reads, receipts, domain re-check, relaying). Alchemy **Gas Manager** is the production gas-sponsorship path behind the relayer abstraction; Webhooks can drive reconciliation. | `backend/src/chain/eth.js` (viem clients over `MONAD_RPC_URL`), `backend/src/chain/relay.js`, `backend/.env.example` (Alchemy endpoints) | Backend uses the configured Alchemy RPC for all chain I/O | Implemented; needs Alchemy key + Gas Manager policy |

## Explicitly out of scope

No Dynamic, Privy, Cleanverse, Kuru, AI, Nansen, or other unrelated sponsor integrations were added.

## What each claim rests on

- **Mera** maps to real passkey-derived account creation/signing via the official library, not a
  home-grown "Mera-compatible" scheme.
- **Envio** maps to indexing the product actually uses for its activity/reconciliation view.
- **Alchemy** maps to the production RPC + gas-sponsorship infrastructure Prism runs on.

## External steps still required for a live demo

See the "external credentials" section of `README.md`. In short: Alchemy key, a MON-funded relayer
key (or Gas Manager policy), the isolated claim-authorizer key, Twilio Verify, the Envio deployment,
the built Mera web bundle, and an Associated-Domain relying party for device passkeys.
