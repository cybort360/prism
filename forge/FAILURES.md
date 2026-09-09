# FAILURES & OPEN RISKS

Honest register of gaps, known failures, and drift. Recording something here is required, not
optional. Nothing is hidden to make a demo look better.

## Open gaps (this phase)

| ID | Severity | Gap | Where |
|---|---|---|---|
| F-2 | MED | No executed **cold-user** evidence for thesis #12 (a first-time user completing a payment without coaching). UX claim only. | — |
| F-5 | LOW · **EXTERNAL BLOCKER** | Aurora cross-chain is **preview-only** and **cannot be proven live this phase**: the send side depends on Aurora's **Intents Connect** API (pre-release / email-gated), and NEAR Intents carries **Monad mainnet only** while PRISM runs testnet — so no route can settle against this deployment regardless of code. Requires an Aurora app key **and** a mainnet deployment. Honestly labelled in-app (preview, no fake delivery); the receive side uses the available Deposits API. Not a defect — a dependency. | `docs/AURORA_INTENTS.md` |
| R1-ADOPT | LOW | The adoption path is **built + tested + proven live end to end** (CHAIN-8): iOS `DeviceP256Credential` (Secure Enclave + labeled software fallback) → backend `P256AccountService` (deploy/prepare/submit/status) → `PrismP256Account` on Monad. **Finding:** it uses a **Secure Enclave / CryptoKit P-256** key, NOT Mera/WebAuthn — Mera signs secp256k1, and a raw WebAuthn assertion signs `authenticatorData‖sha256(clientDataJSON)`, not `sha256(intent)`. The in-app **UI entry point** now exists (`P256PayView`, Profile → Developer). Remaining: promote it out of the DEBUG/Developer section into the primary flow, and run on real **Secure Enclave hardware** (Simulator/CI use the software fallback). No new on-chain primitive needed. | `ios/Prism/Features/P256/P256PayView.swift`, `DeviceP256Credential.swift` |

## Architectural conflicts (reported, not silently resolved)

| ID | Conflict | Resolution status |
|---|---|---|
| A-1 | FORGE 1.4 canonical model says authority = "device-backed **P256** credential"; the actual on-chain signer is a **secp256k1** account derived from a device P-256 passkey (Mera). | Documented in [`ARCHITECTURE.md`](ARCHITECTURE.md); wording, not behavior. Owner decision pending. |
| A-2 | FORGE 1.4 says money lives in a "Monad **smart account**"; the current build uses a **secp256k1 EOA** (Mera, no bundler). The ERC-4337/P-256 smart-account path is **archived**. | Documented in [`ARCHITECTURE.md`](ARCHITECTURE.md). Adopting a smart account would be a product change, out of scope this phase. |

## Historical (fixed) — kept for memory
- **R1 / A-2 RESOLVED (capability) 2026-09-09** — Option C delivered: built `PrismP256Account` (a
  relayer-sponsored smart account authorized by a device P-256 key, verified on-chain via `0x0100`),
  tested (6/6, red-before-green), deployed to Monad, and proven with a real P-256-authorized
  gas-sponsored USDC payment (`0xdea2…8a88`, account MON=0; mutate/replay/wrong-sig revert). R1 →
  VERIFIED. Residual is consumer adoption (R1-ADOPT above).
- **F-6 CLOSED 2026-09-09** — INV-M2 (backend not the canonical balance authority) now has a dedicated
  negative test: `backend/test/balance-authority.test.js` (no balance/ledger key; reported balance
  tracks the chain and is unaffected by store writes). C-LEDGER → `VERIFIED`.
- **F-4b CLOSED 2026-09-08** — the two residual live proofs are done on Monad testnet: (1) a **zero-MON
  payment** — a fresh payer holding USDC and 0 MON paid, relayer sponsored gas, payer MON stayed 0
  (tx `0xd34de0a6ab02d6d470ef60a199a31dbeb2fb5cfb90d33fbd25fc8501a8034a16`) → GAS-1 `VERIFIED`; and
  (2) a **claim fund → refund** cycle (fund `0xd0d4b8dcf056cac78000dde6d2731d5c55c67c557cf4356dd87a44897c601f0f`,
  refund `0x6828135e33e3facb5d2ccab2fdac56d8e10a2c31c2a882c6a679a3143dc1f51d`, funds returned to the
  original sender) → CHAIN-5 `VERIFIED`. Independently re-verified via `eth_getTransactionReceipt`.
- **F-4 CLOSED 2026-09-08** — a real end-to-end **direct payment** settled on Monad testnet through
  the audited `PrismPaymentRouter.settle()`: tx `0xfc277f341cb6db59389fcc21269decefc7708fccd979a7e5ae508b3754c41f19`
  (status `0x1`, block 60877492), delivering 1.00 USDC payer→recipient via the router. Independently
  re-verified by `eth_getTransactionReceipt`. CHAIN-2 → `VERIFIED`. Residual (claim/refund live +
  zero-MON) tracked as F-4b.
- **F-3 CLOSED 2026-09-08** — README proof-table drift resolved: quick-start counts refreshed
  (contracts 43, backend 133), and a source-of-truth note points at `forge/PROOF_LEDGER.md` with the
  current suite counts and the live-deployment confirmation. The dated 2026-09-03 audit table is kept
  as a historical snapshot, explicitly labelled stale.
- **F-1 CLOSED 2026-09-08** — the iOS continuity guard (`IdentityTrustStore.warning`, INV-C3) is now
  unit-tested. `ios/PrismTests/IdentityContinuityTests.swift` (6 tests): silent on an alias-version-only
  change to the same identity/account; fires on a changed `prismId` or account; case-insensitive
  account match; first-time/reset edges. iOS suite 89 → 95, all green. CONT-3 / C-CONT-BLOCK → `VERIFIED`.

- HIGH `bind_account` proof replayable (audit finding) — see `proof/SECURITY_PROOF.md`; verify current
  status against `identityService.issueBindingChallenge` (single-use challenge) before claiming fixed.
- HIGH iOS app did not compile (audit) — since fixed; re-broken twice by merges that added Swift files
  without `xcodegen generate` (Aurora #2/#3). **Process note:** regenerate the Xcode project after any
  merge that adds/removes Swift files.

## Rule
When you close a gap, move it to a dated line under "Historical" with the evidence, and update the
relevant invariant/claim status. Do **not** delete it.
