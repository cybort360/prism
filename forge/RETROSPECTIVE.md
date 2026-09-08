# RETROSPECTIVE

A running log of what was learned, what broke, and what we'd do differently. Append-only; date every
entry. Kept honest — the point is to not repeat mistakes.

## 2026-09-08 — FORGE 1.4 control plane established
- Adopted the `/forge` control plane and the source-of-truth rule (repo > chat summaries).
- Re-anchored the product on **Prism Continuity** (reachability ≠ identity ≠ authority ≠ money
  location) rather than the "pay a person not an address" surface line.
- Verified the continuity mechanism is real in code: `assertResolution` (server 409 on
  account/aliasVersion mismatch) + `IdentityTrustStore.warning` (client review on identity/account
  change, not on alias-only change). Found the gap: **the iOS half is untested** (F-1).
- **Reported two architectural wording conflicts** (P-256 credential vs Mera secp256k1; "smart
  account" vs EOA) instead of silently resolving them — see [`ARCHITECTURE.md`](ARCHITECTURE.md).
- Found README proof-table drift (F-3): counts and deployment status are stale.

## 2026-09-08 — F-1 closed (continuity guard unit-tested)
- Added `IdentityContinuityTests` (6 tests) for the iOS `IdentityTrustStore.warning` guard — the
  visible discontinuity block that a judge actually sees. Proves the exact invariant: silent on an
  alias-version-only change to the same identity/account; warns on a changed `prismId`/account.
- Test-only, no behavior change. iOS 89 → 95; backend 132 / contracts 43 unchanged.
- INV-C3 / CONT-3 / C-CONT-BLOCK upgraded `PARTIAL → VERIFIED` with executed evidence.

## 2026-09-08 — Step 2 done (continuity narrative end-to-end)
- Added `backend/test/continuity-narrative.test.js`: one scenario through the real resolver + identity
  + payment services — pay Bob → Bob rotates number (same account) → pay again succeeds → stale
  resolution refused → number reassigned to Carol → payment on the trusted Bob resolution refused.
  Two real completed payments + two `assertResolution` 409s. Backend 132 → 133.
- CONT-4 recorded `VERIFIED`. INV-C1/C2/C3 now have both unit and end-to-end evidence.

## 2026-09-08 — Steps 3 & 4 done (proof refreshed; judge path dry-run)
- Refreshed README proof drift (F-3 closed): counts → contracts 43 / backend 133; source-of-truth note
  points at the ledger.
- Confirmed deployment with real evidence: live `eth_getCode` on Monad testnet shows router/vault/USDC
  all deployed (2990 / 5905 / 1798 bytes) → CHAIN-1 `VERIFIED`. Live end-to-end (CHAIN-2) still
  `UNTESTED` this phase — no tx hash produced, so not claimed (F-4 stays open).
- Dry-ran the judge path; every command reproduced. Only drift: JUDGE_PATH backend count 132 → 133.
- Continuity vertical slice: **Definition of Done met.**

## 2026-09-09 — Continuity domain model implemented (backend + iOS)
- Named the vocabulary explicitly (PrismIdentity, ReachabilityAlias, AliasBinding, AliasVersion,
  ResolutionAttestation, KnownRecipientBinding, DeviceCredential, PrismAccount) and built one shared,
  pure classifier over five states — `backend/src/lib/continuity.js` and
  `ios/Prism/Models/PrismContinuity.swift` — mirrored, with deterministic tests on both sides.
- Enforcement now delegates to the model (`assertResolution` → `assertFreshResolution`), so the
  classifier and the settlement guard can't drift. Behavior-preserving: full backend suite stayed green.
- **Refined INV-C3 per the FORGE 1.4 account-rotation requirement:** discontinuity = a *PrismIdentity*
  change (a different human); a same-identity account rotation under an advancing aliasVersion is
  continuity, not review; an account change without a version advance fails closed (ambiguous). Updated
  `IdentityContinuityTests` accordingly (a legitimate semantic refinement, documented — not a weakening).
  Also fixed those fixtures to carry non-expired attestations now that the classifier checks freshness.
- **Red-before-green** on the discontinuity case: deliberately made a different identity classify as
  CONTINUITY_MATCH → the discontinuity test FAILED; restored → 13/13 pass.
- Before → after: backend 133 → 146, iOS 95 → 109. No `VERIFIED` claimed without an executed run.

## 2026-09-08 — Remaining live proofs swept
- **Claim collection live** (CHAIN-6): funded a claim, then collected it with BOTH the authorizer
  eligibility signature AND the recipient's ClaimIntent — recipient +1.00 USDC. Proves an alias/OTP
  alone cannot collect (INV-A1). fund `0x8fd7…daf6`, collect `0x195a…0d2c`.
- **Cold-user onboarding** (UX-1 → PARTIAL): ran `testPhoneOnboardingReachesHome` against the real
  Mera bridge + live backend — cold launch reaches Home (24.8s). Honestly kept PARTIAL: it doesn't
  drive a full payment and "without coaching" needs an observed human. Not overclaimed.
- **Aurora cross-chain** (F-5): the one item with a hard EXTERNAL blocker — pre-release Intents Connect
  API + Monad-mainnet-only vs our testnet. Cannot be proven live without an Aurora key + a mainnet
  deployment. Left in honest preview mode; not faked.

## 2026-09-08 — F-4b closed (zero-MON + claim/refund live on Monad)
- **Zero-MON payment**: a fresh payer holding USDC and 0 MON paid 1.00 USDC; the relayer sponsored gas;
  the payer's MON stayed 0. tx `0xd34d…34a16`. GAS-1 → `VERIFIED`.
- **Claim fund → refund**: funded 1.00 USDC into `PrismClaimVault`, then refunded after expiry back to
  the original sender (net 0). fund `0xd0d4…01f0f`, refund `0x6828…1f51d`. CHAIN-5 → `VERIFIED`.
- All independently re-verified via `eth_getTransactionReceipt` (to == router / vault). Temp broadcast
  script kept out of the repo again.

## 2026-09-08 — F-4 closed (real payment on Monad)
- Ran a real end-to-end direct payment on Monad testnet through the audited `settle()` path using our
  funded key (20 USDC / 4.6 MON): tx `0xfc27…41f19`, status `0x1`, block 60877492, 1.00 USDC delivered
  payer→recipient. Independently re-verified via `eth_getTransactionReceipt`. CHAIN-2 → `VERIFIED`.
- The one-off broadcast script was kept out of the repo (temporary, not committed) — a live-broadcast
  script shouldn't be runnable by accident.
- Residual: claim/refund live + a zero-MON payment (separate payer+relayer) remain unproven (F-4b).

## Process lessons (carry forward)
- **Regenerate the Xcode project after any merge that adds/removes Swift files.** The Aurora #2 and #3
  merges each broke the iOS build because `xcodegen` wasn't re-run and latent (never-compiled) Swift
  errors surfaced only on a real build. Add it to the merge checklist.
- **Piping a build to `tail` masks its exit code.** A `BUILD FAILED` looked like success once because
  `xcodebuild … | tail` returned tail's exit status. Capture full logs; check the real exit code.
- **A minimum shown to a user must be floored, not rounded.** The cross-chain "you receive at least X"
  value was rounded up in a test's expectation; rounding a guaranteed minimum up over-promises.

## Open questions
- Owner decision on the P-256/"smart account" wording vs the archived ERC-4337 path (A-1/A-2).
- Whether a live Monad demo is required for the track, and if so, funding a deployment/relayer key.
