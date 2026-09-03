# Prism v1.1

Prism is an iPhone-native consumer payments app for Monad. You pay a person through Contacts, an
`@handle`, a QR code, or a payment link; the app hides wallet addresses, gas, chain selection, and
seed phrases.

Core loop:

`Person -> Amount -> Face ID / PIN -> Sent`

## Architecture

```text
phone / @handle / QR / payment link
        -> Prism Identity + protected alias resolver
        -> Mera passkey-derived account        (secp256k1 EOA from a passkey)
        -> AUSD                                 (Agora Dollar, ERC-3009 gasless)
        -> Prism payment router / claim vault   (relayer-submitted; recipient/amount bound in-signature)
        -> Monad                                (canonical settlement)
```

- `ios/Prism/` — Swift + SwiftUI app (Contacts, Face ID / PIN, lifecycle UI).
- `ios/MeraBridge/` — the narrow `MeraAccountService` protocol and the WKWebView bridge that runs
  the **official** `@category-labs/mera` library. Prism never re-implements Mera's derivation or
  signing, and never rewrites the app in React Native.
- `backend/` — protected alias resolver, OTP adapter, off-chain payment requests, AUSD ERC-3009
  authorization builder + verifier, MON-funded relayer, claim authorizer.
- `contracts/` — `PrismPaymentRouter`, `PrismClaimVault`, `IERC3009`, a faithful `MockAUSD`, and
  Foundry tests.
- `indexer/envio/` — Envio HyperIndex config + handlers that index real Monad activity into the
  GraphQL API the backend reads for reconciled history.
- `web/.well-known/` — the `apple-app-site-association` file that must be hosted at the
  relying-party domain for device passkeys and `/pay/*` payment links.

Mera is the single consumer signing layer. The old Secure-Enclave-P256 / ERC-4337 path is archived
under `archive/` and is not active alongside Mera. See `docs/PRD_ADDENDUM_v1.1.md`.

## Key decisions

1. Phone number is a private reachability alias — not a key, not an on-chain identifier.
2. `@handle` is an optional public alias; QR / links resolve to a Prism identity, never a raw address.
3. The **Mera passkey account** owns funds and is the spending authority.
4. **AUSD** is the payment asset; **ERC-3009 gasless authorizations** are the direct-payment primitive.
5. A user can hold AUSD > 0 and MON = 0 and still pay (relayer / Alchemy Gas Manager pays gas).
6. The backend is never the canonical money ledger — Monad/AUSD state is canonical.
7. No public phone→wallet registry and no `SHA(phone)`→wallet map.
8. Pre-user claims use random claim IDs / references; no phone-derived value is emitted on-chain.
9. Requests are off-chain until paid; the UI shows success only after an on-chain receipt reconciles.
10. Recipient/amount are bound into the signed ERC-3009 nonce, so a relayer can't redirect or resize.

## Network defaults

- Monad testnet: chainId `10143`, RPC `https://testnet-rpc.monad.xyz`.
- Monad mainnet: chainId `143`, RPC `https://rpc.monad.xyz`.
- AUSD (verify against Agora docs; re-checked at runtime): testnet
  `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`, mainnet
  `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`. Domain `Agora Dollar` / `1`, 6 decimals.

## Quick start

### Contracts

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup   # first time only: installs forge
cd contracts
forge install foundry-rs/forge-std --no-git                # first time only
cp .env.example .env
forge test
```

27 tests across unit, fuzz, and invariant suites. The vault invariant run (256 runs / 128k calls)
takes ~2 minutes — that is expected, not a hang.

### Backend

```bash
cd backend
npm install
cp .env.example .env
node src/server.js
```

Twilio Verify, the relayer, the claim authorizer, and the Envio endpoint are activated by
environment variables. Without them the server runs explicit dev adapters and never claims a real
OTP or on-chain settlement occurred.

Run tests: `node --test test/*.test.js`.

### iOS

```bash
cd ios/MeraBridge/web
npm install
npm run build            # → ios/Prism/Resources/MeraWeb/mera-bridge.js (git-ignored, required)

cd ../..                 # ios/
brew install xcodegen
./bootstrap.sh --open    # xcodegen generate + open Prism.xcodeproj
```

The Mera bundle is a build artifact and is not committed, so a fresh clone must run the `npm run
build` step above or the bridge has nothing to load. For real device passkeys also configure the
relying-party domain and host `web/.well-known/apple-app-site-association` at it, replacing the
`TEAMID` placeholder with your Apple Team ID — see `ios/MeraBridge/web/BUILD.md` and
`docs/PASSKEY_SETUP.md`. On the simulator the app uses a clearly-labeled dev bridge. Set
`PRISM_API_BASE_URL` (default `http://127.0.0.1:8787`). Add the F5.6 font per
`ios/Prism/Resources/FONT_SETUP.md` (intentionally not bundled).

### Indexer (Envio)

```bash
cd indexer/envio
export PRISM_PAYMENT_ROUTER=0x... PRISM_CLAIM_VAULT=0x...   # also set them in config.yaml
npx envio dev            # codegen + local indexer + GraphQL at http://localhost:8080/v1/graphql
```

Then point the backend at it with `ENVIO_GRAPHQL_URL`. See `indexer/envio/README.md` and
`docs/ENVIO_INTEGRATION.md`.

### Everything

```bash
make test        # backend + contracts + iOS
```

`make test-ios` needs macOS with Xcode and xcodegen; on Linux run `make test-backend` and
`make test-contracts`.

## Documentation

- Design: `docs/ARCHITECTURE.md`, `docs/IOS_ARCHITECTURE.md`, `docs/PRD_ADDENDUM_v1.1.md`,
  `docs/RESEARCH_NOTES.md`
- Security: `docs/SECURITY.md`, `docs/THREAT_MODEL.md`, `docs/FORGE_PROOF_PLAN.md`
- Integrations: `docs/SPONSOR_MATRIX.md` (Agora / Mera / Envio / Alchemy mapping),
  `docs/MERA_INTEGRATION.md`, `docs/ENVIO_INTEGRATION.md`, `docs/ALCHEMY_INTEGRATION.md`,
  `docs/PASSKEY_SETUP.md`
- Operations: `docs/OBSERVABILITY.md`

## External credentials still required for a live demo

Everything below is an external service/secret — there are no remaining architectural TODOs.

| Credential / service | Used for | Where |
|---|---|---|
| Alchemy Monad API key | Production RPC (reads, receipts, relaying) | `MONAD_RPC_URL` |
| Alchemy Gas Manager policy | Production gas sponsorship (relayer alternative) | infra / `docs/SPONSOR_MATRIX.md` |
| Relayer private key (MON-funded) | Submits gasless AUSD transfers | `RELAYER_PRIVATE_KEY` |
| Claim authorizer key (secp256k1, KMS/HSM) | Authorizes pre-user claim collection | `CLAIM_AUTHORIZER_PRIVATE_KEY` (backend) / `CLAIM_AUTHORIZER_ADDRESS` (contracts) |
| Deployed router + vault addresses | On-chain payment surface | `PRISM_PAYMENT_ROUTER`, `PRISM_CLAIM_VAULT` |
| Twilio Verify (SID/token/service) | Real SMS OTP | `TWILIO_*` |
| Alchemy webhook signing key | Verifies `POST /v1/webhooks/alchemy` HMAC | `ALCHEMY_WEBHOOK_SIGNING_KEY` |
| Envio HyperIndex deployment | Activity/reconciliation indexing | `ENVIO_GRAPHQL_URL`, `indexer/envio/` |
| Mera web bundle + RP domain | Device passkeys (official Mera lib) | `ios/MeraBridge/web/BUILD.md` |
| Backend secrets (32-byte / 64-hex) | Sessions, resolver pepper, encryption | `SESSION_SECRET`, `RESOLVER_PEPPER`, `DATA_ENCRYPTION_KEY`, `SERVICE_KEY_ENCRYPTION_KEY` |
| F5.6 font | Display typeface | `ios/Prism/Resources/FONT_SETUP.md` |
| Apple Team ID + RP domain | Passkeys and `/pay/*` universal links | `web/.well-known/apple-app-site-association` |
