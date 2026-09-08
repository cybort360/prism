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

### Step 2 — Continuity end-to-end narrative
A scripted/observed run (backend + app or backend-integration test) that walks: pay → recipient
rotates phone (same account) → pay again succeeds → recipient's alias reassigned to a different
identity → payment is blocked for review. Record it in [`PROOF_LEDGER.md`](PROOF_LEDGER.md).

### Step 3 — Refresh stale proof (F-3, F-4)
Update the README proof table to real counts; re-run or honestly downgrade the on-chain rows. Do not
claim a live tx without a hash.

### Step 4 — Judge path dry-run
Execute [`JUDGE_PATH.md`](JUDGE_PATH.md) top to bottom on a clean checkout; fix anything that doesn't
reproduce.

## Working rules
- Read `PRODUCT`, `INVARIANTS`, `ARCHITECTURE`, this plan, and `PROOF_LEDGER` before meaningful changes.
- Branch off `main`; keep changes additive; run all three suites before committing.
- Every change that touches an enforcement point updates the relevant invariant/claim status.

## Definition of done for the phase
INV-C1/C2/C3 all at `VERIFIED` with executed evidence; the continuity narrative reproducible from
`JUDGE_PATH.md`; README/proof drift resolved; no regressions in the 132/43/89 suites.
