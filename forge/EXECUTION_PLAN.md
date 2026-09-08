# EXECUTION PLAN

## Current phase: `continuity-vertical-slice`

**Goal:** make Prism Continuity the demonstrable, load-bearing claim — reachability changes without
silently changing recipient identity — and prove it end to end, without adding new product features.

**Explicitly out of scope this phase:** new product features, an ERC-4337/P-256 smart-account
migration, live cross-chain settlement, mainnet.

### Step 0 — Control plane (this change)
Create `/forge/*`, `/AGENTS.md`, `/forge.json`; align README terminology; report conflicts.
**Status: done in this change** (docs only — no feature code touched).

### Step 1 — Close the continuity evidence gap (F-1) — ✅ DONE (2026-09-08)
`ios/PrismTests/IdentityContinuityTests.swift` (6 tests) now proves `IdentityTrustStore.warning`:
- same `prismId` + same account, higher `aliasVersion` → **no warning** (continuity preserved);
- changed `prismId` **or** changed account → **warning** (review required);
- plus case-insensitive account match and first-time/reset edges.
Test-only, no behavior change. iOS suite 89 → 95. CONT-3 / C-CONT-BLOCK → `VERIFIED`.

### Step 2 — Continuity end-to-end narrative — ✅ DONE (2026-09-08)
`backend/test/continuity-narrative.test.js` walks the whole story through the real services:
Alice pays Bob by phone (resolve→prepare→sign→submit→reconcile→completed) → Bob rotates his number
(same identity/account, alias bumps) → Alice pays again and it succeeds (INV-C1) → the pre-rotation
resolution is stale and refused (INV-C2) → Bob's old number is reassigned to Carol (different
identity/account) → a payment on Alice's trusted Bob resolution is refused, never silently redirected
(INV-C3). The iOS visible review of the same discontinuity is covered by `IdentityContinuityTests`.
Recorded as CONT-4 in [`PROOF_LEDGER.md`](PROOF_LEDGER.md). Backend suite 132 → 133.

### Step 3 — Refresh stale proof (F-3, F-4) — ✅ DONE (2026-09-08)
README quick-start counts refreshed (contracts 43, backend 133); a source-of-truth note points at the
ledger with current counts. Contracts **confirmed deployed** on Monad testnet via live `eth_getCode`
(router 2990 B / vault 5905 B / USDC 1798 B) → CHAIN-1 `VERIFIED`. Live **end-to-end** on Monad is
still `UNTESTED` this phase (no tx hash produced — F-4 stays open, honestly). F-3 closed.

### Step 4 — Judge path dry-run — ✅ DONE (2026-09-08)
Executed the [`JUDGE_PATH.md`](JUDGE_PATH.md) commands: §2 continuity (4/4 — narrative + rotation),
§3 privacy (backend 1/1 + contract `PrismPrivacy` 3/3), §4 mutation/replay (backend `mutation-audit`
10/10 + contract `PrismPaymentRouter` 11/11 incl. `testModified*` / `testReplayRejected`). All
reproduce. Only drift found and fixed: the backend count in JUDGE_PATH (132 → 133). §5 (in-app Payment
Proof) is a manual UI check, unchanged.

## Working rules
- Read `PRODUCT`, `INVARIANTS`, `ARCHITECTURE`, this plan, and `PROOF_LEDGER` before meaningful changes.
- Branch off `main`; keep changes additive; run all three suites before committing.
- Every change that touches an enforcement point updates the relevant invariant/claim status.

## Definition of done for the phase
INV-C1/C2/C3 all at `VERIFIED` with executed evidence; the continuity narrative reproducible from
`JUDGE_PATH.md`; README/proof drift resolved; no regressions in the suites.

**Status: MET (2026-09-08).** Steps 1–4 done. INV-C1/C2/C3 `VERIFIED` (iOS unit + backend e2e);
CONT-4 recorded; README/proof drift resolved (F-3 closed); suites green at **backend 133 / contracts
43 / iOS 95**. Remaining open item is F-4 (live end-to-end on Monad, needs a funded run + tx hash) —
tracked, not claimed.
