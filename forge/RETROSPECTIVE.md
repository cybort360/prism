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
