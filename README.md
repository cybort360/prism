# Prism v1.1

Prism is an iPhone-native consumer payments app for Monad. You pay a person through Contacts, an
`@handle`, a QR code, or a payment link; the app hides wallet addresses, gas, chain selection, and
seed phrases.

Core loop:

`Person -> Amount -> Face ID / PIN -> Sent`

> **This repo is under the FORGE 1.4 control plane. Start at [`AGENTS.md`](AGENTS.md) and
> [`/forge`](forge/). Repository files are the source of truth; prior chat summaries are not.**

## Prism Continuity (the load-bearing mechanism)

"Send money to people, not wallet addresses" is the surface promise. The load-bearing idea is
**Prism Continuity**: **human identifiers are mutable reachability *routes*, not financial identities
or spending authority.**

```
HOW I AM FOUND          phone / @handle / QR / link
        ↓
WHO I AM                persistent PrismIdentity
        ↓
WHO MAY AUTHORIZE       device passkey → Mera-derived secp256k1 account
MY MONEY
        ↓
WHERE MY MONEY LIVES    a Monad account holding USDC
```

**Critical invariant:** reachability may change without silently changing recipient identity. A
legitimate alias change that still resolves to the *same* PrismIdentity preserves continuity; an alias
that now resolves to a *different* identity is visibly blocked for review, never silently redirected.
See [`forge/PRODUCT.md`](forge/PRODUCT.md), [`forge/INVARIANTS.md`](forge/INVARIANTS.md), and
[`forge/CORE_HYPOTHESIS.md`](forge/CORE_HYPOTHESIS.md). (Note: the FORGE 1.4 brief's "P256 credential /
smart account" wording is clarified against the actual Mera secp256k1 account in
[`forge/ARCHITECTURE.md`](forge/ARCHITECTURE.md).)

## Payment truth

Prism does not treat transaction submission as payment completion. Every monetary action — direct
send, request payment, QR payment, payment link, claim funding, recipient claim, refund — is one
canonical `PrismPayment` represented by:

- **lifecycle** — a guarded state machine + an append-only, real-timestamped event log; "Sent" /
  "Delivered" appear only after a confirmed Monad receipt.
- **receipt** — one consumer detail surface (`PaymentDetailsView`); no feature-specific dead-end.
- **evidence** — an inspectable Payment Proof with a real phone-privacy detector and honest
  per-check statuses (never a green badge a check didn't earn).

See `docs/PAYMENT_MODEL.md`, `docs/PAYMENT_LIFECYCLE.md`, `docs/RECEIPTS.md`, `docs/CLAIMS.md`,
`docs/PAYMENT_PROOF.md`, and `docs/QR_AND_LINKS.md`.

## Architecture

```text
phone / @handle / QR / payment link
        -> Prism Identity + protected alias resolver
        -> Mera passkey-derived account        (secp256k1 EOA from a passkey)
        -> USDC                                 (ERC-3009 gasless)
        -> Prism payment router / claim vault   (relayer-submitted; recipient/amount bound in-signature)
        -> Monad                                (canonical settlement)
```

- `ios/Prism/` — Swift + SwiftUI app (Contacts, Face ID / PIN, lifecycle UI).
- `ios/MeraBridge/` — the narrow `MeraAccountService` protocol and the WKWebView bridge that runs
  the **official** `@category-labs/mera` library. Prism never re-implements Mera's derivation or
  signing, and never rewrites the app in React Native.
- `backend/` — protected alias resolver, OTP adapter, off-chain requests, stablecoin ERC-3009
  authorization builder + verifier, MON-funded relayer, claim authorizer.
- `contracts/` — `PrismPaymentRouter`, `PrismClaimVault`, `IERC3009`, a faithful `MockUSDC`, and
  Foundry tests.
- `backend/src/aurora/` — Aurora Intents adapter: receive from any chain into USDC on Monad, and
  send/spend out to any token on any chain. Swappable client + runtime asset directory.
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
4. **USDC** is the payment asset; **ERC-3009 gasless authorizations** are the direct-payment primitive.
5. A user can hold USDC and MON = 0 and still pay (relayer / Alchemy Gas Manager pays gas).
6. The backend is never the canonical money ledger; Monad token state is canonical.
7. No public phone→wallet registry and no `SHA(phone)`→wallet map.
8. Pre-user claims use random claim IDs / references; no phone-derived value is emitted on-chain.
9. Requests are off-chain until paid; the UI shows success only after an on-chain receipt reconciles.
10. Recipient/amount are bound into the signed ERC-3009 nonce, so a relayer can't redirect or resize.
11. Cross-chain routing (Aurora Intents) extends that binding rather than weakening it: for a send to
    another chain the destination chain, asset, recipient and guaranteed minimum are hashed into the
    same signed envelope, so one approval authorizes the whole route. No contract change was needed —
    the router already forwards to `env.recipient`. See `docs/AURORA_INTENTS.md`.

## Network defaults

- Monad testnet: chainId `10143`, RPC `https://testnet-rpc.monad.xyz`.
- Monad mainnet: chainId `143`, RPC `https://rpc.monad.xyz`.
- USDC (verify against Circle docs; re-checked at runtime): testnet
  `0x534b2f3A21130d7a60830c2Df862319e593943A3`, mainnet
  `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`. Domain `USDC` / `2`, 6 decimals.

## Quick start

### Contracts

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup   # first time only: installs forge
cd contracts
forge install foundry-rs/forge-std --no-git                # first time only
cp .env.example .env
forge test
```

43 tests across unit, fuzz, privacy, and invariant suites. The vault invariant run (256 runs / 128k calls)
takes ~1–2 minutes — that is expected, not a hang.

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

Run tests: `node --test test/*.test.js` (133 tests).

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

## Proof status

> **Current source of truth: [`forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md).** The dated table below
> is the original 2026-09-03 hostile audit and is now **stale in places**. Current, re-executed status:
> suites **backend 133 / contracts 43 / iOS 95**; the router/vault/USDC are **confirmed deployed** on
> Monad testnet (live `eth_getCode`, 2026-09-08), and a **real end-to-end direct payment settled on
> Monad** — tx `0xfc277f341cb6db59389fcc21269decefc7708fccd979a7e5ae508b3754c41f19` (1.00 USDC
> delivered via the router). Live **claim/refund** and a **zero-MON** payment are still unproven this
> phase. See the ledger and [`forge/FAILURES.md`](forge/FAILURES.md). Nothing is marked verified on the
> strength of code existing.

A hostile audit (`proof/`) was run against this codebase on 2026-09-03. Every row is either backed
by an executed check or marked blocked with the reason — nothing here is a "works" claim.

| Claim | Status | Evidence |
|---|---|---|
| Contract suite green | **PROVEN** — 31 tests, 0 failed | `forge test --offline` |
| Deep fuzzing | **PROVEN** — 3 properties × 10,000 runs | `forge test --fuzz-runs 10000` |
| Vault invariants | **PROVEN** — 256 runs / 128k calls, 3 invariants | `PrismVaultInvariant` |
| Backend suite green | **PROVEN** — 41 tests, 0 failed | `node --test test/*.test.js` |
| `@category-labs/mera` is real and used officially | **PROVEN** (npm registry + source) | `proof/MERA_PROOF.md` |
| No phone in calldata / events / storage | **PROVEN** | `contracts/test/PrismPrivacy.t.sol` |
| No raw phone persisted or logged | **PROVEN after fix** | `proof/PRIVACY_PROOF.md` |
| Mutations MUT-01…MUT-16 rejected | **PROVEN** (2 caveats) | `proof/SECURITY_PROOF.md` |
| Payer with MON = 0 can pay | **PROVEN locally**, not on testnet | `proof/ZERO_MON_PROOF.md` |
| Contracts deployed to Monad testnet | **BLOCKED** — no funded deployment key | `proof/TESTNET_DEPLOYMENT.md` |
| End-to-end payment on Monad | **BLOCKED** — no tx exists | `proof/PAYMENT_PROOF.md` |
| Claim / refund on Monad | **BLOCKED** | `proof/CLAIM_PROOF.md`, `proof/REFUND_PROOF.md` |
| Cross-border demonstration | **BLOCKED** — no live USDC transaction exists | `proof/CROSS_BORDER_PROOF.md` |
| Envio indexing real events | **BLOCKED** — config verified by topic0, never run | `proof/ENVIO_PROOF.md` |
| Alchemy live path | **BLOCKED** — no API key, no request made | `proof/ALCHEMY_PROOF.md` |
| iOS app compiles | **PROVEN by CI** — it did not, until fixed in this branch | `proof/SECURITY_PROOF.md` (Finding 7) |
| iOS unit tests | **PASS in CI** — 2 tests | `proof/EVIDENCE_MANIFEST.json` |
| Mera bundle builds against the published lib | **PROVEN by CI** | `proof/MERA_PROOF.md` |
| Mera bridge derives an account the backend accepts (simulator) | **PROVEN by CI** | `proof/MERA_PROOF.md` |
| iOS onboarding UI test (launch → Mera account → phone → OTP → past onboarding) | **PASSES in CI** | `proof/MERA_PROOF.md` |
| iOS passkey, Face ID, Contacts, QR, universal links | **BLOCKED** — no device; never executed | `proof/MERA_PROOF.md` |
| Latency figures | **NONE** — instrumented, never measured | `proof/PAYMENT_PROOF.md` |

Open findings: one HIGH (`bind_account` proof is replayable — `proof/poc/bind-replay.mjs`) and four
MEDIUM. Two HIGH were found and fixed during the audit (blind re-broadcast on a lost relayer
response; and the iOS app not compiling at all), plus a CI configuration defect that made every
Keychain write fail. CI is green on all four checks. See `proof/SECURITY_PROOF.md` and
`proof/EVIDENCE_MANIFEST.json`.

## Documentation

- Design: `docs/ARCHITECTURE.md`, `docs/IOS_ARCHITECTURE.md`, `docs/PRD_ADDENDUM_v1.1.md`,
  `docs/RESEARCH_NOTES.md`
- Security: `docs/SECURITY.md`, `docs/THREAT_MODEL.md`, `docs/FORGE_PROOF_PLAN.md`
- Integrations: `docs/SPONSOR_MATRIX.md` (Mera / Envio / Alchemy mapping),
  `docs/MERA_INTEGRATION.md`, `docs/ENVIO_INTEGRATION.md`, `docs/ALCHEMY_INTEGRATION.md`,
  `docs/PASSKEY_SETUP.md`
- Operations: `docs/OBSERVABILITY.md`

## External credentials still required for a live demo

Everything below is an external service/secret. The core architecture and lifecycles are implemented
and tested; see `proof/` for what is proven locally versus what still requires deployment and live runs.

| Credential / service | Used for | Where |
|---|---|---|
| Alchemy Monad API key | Production RPC (reads, receipts, relaying) | `MONAD_RPC_URL` |
| Alchemy Gas Manager policy | Production gas sponsorship (relayer alternative) | infra / `docs/SPONSOR_MATRIX.md` |
| Relayer private key (MON-funded) | Submits gasless USDC transfers | `RELAYER_PRIVATE_KEY` |
| Claim authorizer key (secp256k1, KMS/HSM) | Authorizes pre-user claim collection | `CLAIM_AUTHORIZER_PRIVATE_KEY` (backend) / `CLAIM_AUTHORIZER_ADDRESS` (contracts) |
| Deployed router + vault addresses | On-chain payment surface | `PRISM_PAYMENT_ROUTER`, `PRISM_CLAIM_VAULT` |
| Twilio Verify (SID/token/service) | Real SMS OTP | `TWILIO_*` |
| Alchemy webhook signing key | Verifies `POST /v1/webhooks/alchemy` HMAC | `ALCHEMY_WEBHOOK_SIGNING_KEY` |
| Envio HyperIndex deployment | Activity/reconciliation indexing | `ENVIO_GRAPHQL_URL`, `indexer/envio/` |
| Mera web bundle + RP domain | Device passkeys (official Mera lib) | `ios/MeraBridge/web/BUILD.md` |
| Backend secrets (32-byte / 64-hex) | Sessions, resolver pepper, encryption | `SESSION_SECRET`, `RESOLVER_PEPPER`, `DATA_ENCRYPTION_KEY`, `SERVICE_KEY_ENCRYPTION_KEY` |
| F5.6 font | Display typeface | `ios/Prism/Resources/FONT_SETUP.md` |
| Apple Team ID + RP domain | Passkeys and `/pay/*` universal links | `web/.well-known/apple-app-site-association` |
