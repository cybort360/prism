# FAILURES & OPEN RISKS

Honest register of gaps, known failures, and drift. Recording something here is required, not
optional. Nothing is hidden to make a demo look better.

## Open gaps (this phase)

| ID | Severity | Gap | Where |
|---|---|---|---|
| F-1 | HIGH | The iOS continuity guard (`IdentityTrustStore.warning` → `IdentityChangeReviewView`) — the *visible discontinuity block* (INV-C3) — has **no unit test**. The server 409 is tested; the client decision that a judge actually sees is not. | `ios/Prism/Features/Common/PersonPickerView.swift` |
| F-2 | MED | No executed **cold-user** evidence for thesis #12 (a first-time user completing a payment without coaching). UX claim only. | — |
| F-3 | MED | `README.md` "Proof status" table is **stale**: it prints `31 / 41 / 2` tests and marks deployment / e2e / Envio as BLOCKED. Actual suites are `43 / 132 / 89`, and a testnet deployment manifest exists. Documentation drift, not a code defect. | `README.md` |
| F-4 | MED | On-chain end-to-end (payment/claim/refund) is **not re-verified in this phase**. Prior-session tx hashes are not authoritative under the FORGE 1.4 source-of-truth rule. | `PROOF_LEDGER.md` CHAIN-2 |
| F-5 | LOW | Aurora cross-chain is **preview-only**; live `POST /api/quote` has never been called with a real key (NEAR Intents carries Monad mainnet only; PRISM runs testnet). Honestly labelled in-app. | `docs/AURORA_INTENTS.md` |
| F-6 | LOW | `INV-M2` (backend not the canonical balance authority) has no explicit negative test. | — |

## Architectural conflicts (reported, not silently resolved)

| ID | Conflict | Resolution status |
|---|---|---|
| A-1 | FORGE 1.4 canonical model says authority = "device-backed **P256** credential"; the actual on-chain signer is a **secp256k1** account derived from a device P-256 passkey (Mera). | Documented in [`ARCHITECTURE.md`](ARCHITECTURE.md); wording, not behavior. Owner decision pending. |
| A-2 | FORGE 1.4 says money lives in a "Monad **smart account**"; the current build uses a **secp256k1 EOA** (Mera, no bundler). The ERC-4337/P-256 smart-account path is **archived**. | Documented in [`ARCHITECTURE.md`](ARCHITECTURE.md). Adopting a smart account would be a product change, out of scope this phase. |

## Historical (fixed) — kept for memory
- HIGH `bind_account` proof replayable (audit finding) — see `proof/SECURITY_PROOF.md`; verify current
  status against `identityService.issueBindingChallenge` (single-use challenge) before claiming fixed.
- HIGH iOS app did not compile (audit) — since fixed; re-broken twice by merges that added Swift files
  without `xcodegen generate` (Aurora #2/#3). **Process note:** regenerate the Xcode project after any
  merge that adds/removes Swift files.

## Rule
When you close a gap, move it to a dated line under "Historical" with the evidence, and update the
relevant invariant/claim status. Do **not** delete it.
