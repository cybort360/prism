# FAILURES & OPEN RISKS

Honest register of gaps, known failures, and drift. Recording something here is required, not
optional. Nothing is hidden to make a demo look better.

## Open gaps (this phase)

| ID | Severity | Gap | Where |
|---|---|---|---|
| F-2 | MED | No executed **cold-user** evidence for thesis #12 (a first-time user completing a payment without coaching). UX claim only. | — |
| F-4 | MED | On-chain end-to-end (payment/claim/refund) is **not re-verified in this phase** — no tx hash produced here. Prior-session tx hashes are not authoritative under the FORGE 1.4 source-of-truth rule. (Deployment itself is now confirmed — see CHAIN-1.) | `PROOF_LEDGER.md` CHAIN-2 |
| F-5 | LOW | Aurora cross-chain is **preview-only**; live `POST /api/quote` has never been called with a real key (NEAR Intents carries Monad mainnet only; PRISM runs testnet). Honestly labelled in-app. | `docs/AURORA_INTENTS.md` |
| F-6 | LOW | `INV-M2` (backend not the canonical balance authority) has no explicit negative test. | — |

## Architectural conflicts (reported, not silently resolved)

| ID | Conflict | Resolution status |
|---|---|---|
| A-1 | FORGE 1.4 canonical model says authority = "device-backed **P256** credential"; the actual on-chain signer is a **secp256k1** account derived from a device P-256 passkey (Mera). | Documented in [`ARCHITECTURE.md`](ARCHITECTURE.md); wording, not behavior. Owner decision pending. |
| A-2 | FORGE 1.4 says money lives in a "Monad **smart account**"; the current build uses a **secp256k1 EOA** (Mera, no bundler). The ERC-4337/P-256 smart-account path is **archived**. | Documented in [`ARCHITECTURE.md`](ARCHITECTURE.md). Adopting a smart account would be a product change, out of scope this phase. |

## Historical (fixed) — kept for memory
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
