# FORGE MATRIX — PRISM SAVE

Final status of Prism Save, row by row. Verified 2026-09-16 on branch `prism-save`.

**Rule:** source code existence is NOT green. GREEN requires runtime evidence — a passing test that
exercises the actual code path, or observed app behavior. Rows that make an **execution** claim (real
money moving on-chain) require on-chain evidence; without it they are YELLOW with the exact blocker, never
GREEN.

**Legend**
- 🟢 **GREEN** — works, with runtime evidence cited.
- 🟡 **YELLOW** — blocked; the exact blocker is stated. Not a failure.
- 🔴 **RED** — an actual failure.

**The load-bearing blocker (applies to every execution row):** the earnAUSD substrate is not connected
on this deployment. earnAUSD/AUSD live on Monad **mainnet (143)**; Prism's contracts run on **testnet
(10143)**. The earnAUSD deposit/Teller ABI is **not independently verified**, no swap route (USDC→AUSD)
is allowlisted, and there is **no live batch account** to submit a sponsored deposit. `substrateVerified
= false` gates all real execution. See `../docs/SAVE_DEPENDENCY_AUDIT.md`. Because of this, the **18-step
real test flow (deposit → verify shares owned by user → withdraw → verify USDC) was NOT executed** — it
requires an environment where the assets and a verified vault exist. That is reported honestly below, not
papered over with a fabricated success.

Runtime evidence base: **84/84 Save-specific backend tests pass** (`save*.test.js`, incl. hostile
SAVE-001..018), **448/448 total backend tests pass**, and the Save flows render in-app
(`--uitest-save*`).

| # | Row | Status | Evidence / Exact blocker |
|---|-----|--------|--------------------------|
| 1 | Save Entry | 🟢 GREEN | Flow renders and starts; `GET /v1/save/state` tested (`save.test.js`), `--uitest-save` screenshot. No money moves. |
| 2 | Quote | 🟢 GREEN | Money-safe preview quote generated and self-verified against the allowlist verifier (`save.test.js`). Live economics (APY, minimums) are intentionally absent → flagged not-live. |
| 3 | USDC Conversion (USDC→AUSD) | 🟡 YELLOW | No swap route allowlisted (`swapRouter=''`) and substrate is 143; conversion never executed. The plan verifier rejects any unapproved swap target (SAVE-004). |
| 4 | AUSD | 🟡 YELLOW | AUSD is a mainnet-143 asset; not held or moved on this testnet deployment. Address verified in config; not exercisable here. |
| 5 | Vault Deposit (AUSD→earnAUSD) | 🟡 YELLOW | earnAUSD deposit/Teller ABI unverified, mainnet-only, no live batch account. `PreviewSaveExecutor.execute()` refuses (tested). |
| 6 | earnAUSD Ownership (shares → user) | 🟡 YELLOW (invariant proven) | Not executed on-chain. The ownership rule IS enforced and tested: reconcile FAILS if shares land anywhere but the owner (SAVE-012, `save-proof` share_ownership). |
| 7 | Zero-MON | 🟡 YELLOW | Gasless sponsorship uses the same proven payments relayer, but a Save deposit is never submitted here, so MON=0 during Save is unproven on-chain. |
| 8 | Position Read | 🟢 GREEN | Reader is chain-canonical and fails safe (UNAVAILABLE when unreadable); tested (`save-domain`, SAVE-018). No live earnAUSD position exists to read yet. |
| 9 | Yield Accounting | 🟢 GREEN | Average-cost basis, unrealized/realized/earned, integer base units; tested (`save-accounting.test.js`). |
| 10 | APY Freshness | 🟢 GREEN | `resolveApy` labels source/window, rejects stale, shows zero/negative truthfully; tested (SAVE-013, SAVE-014). |
| 11 | Save Receipt | 🟢 GREEN | Consumer receipt renders (`--uitest-save-receipt` screenshot) and links to proof; tested. |
| 12 | Save Proof | 🟢 GREEN | Evidence-backed `PrismSaveProof`: never VERIFIED without evidence; tx mismatch → all failed; tested (`save-proof.test.js`). Proof of a *real* deposit tx is row 24. |
| 13 | Instant Withdrawal | 🟡 YELLOW | Not executed (substrate gated). Instant is truthfully reported unavailable when it can't be proven (SAVE-015); routes to Standard. |
| 14 | Queued Withdrawal | 🟡 YELLOW | Not executed. Lifecycle + claimability tested: a slow queue is pending, not failure; unknown ⇒ still queued (SAVE-016). |
| 15 | AUSD→USDC Return | 🟡 YELLOW | No swap route; not executed. AUSD-held recovery (funds never stranded) tested (SAVE-017). |
| 16 | Activity | 🟢 GREEN | Save deposit/withdraw rows projected and routed to the Save receipt; tested (`activityService` save branch) + `ActivityView`. |
| 17 | App Restart | 🟢 GREEN | Position reconstructs from chain, not memory; store is a projection only (`reconstructPosition`, SAVE-018). |
| 18 | Backend Failure | 🟢 GREEN | Ownership is independent of Prism: position proven from shares in the user's account; reads fail safe (SAVE-018). |
| 19 | Quote Failure | 🟢 GREEN | `validateExecutionQuote` blocks expired/over-slippage/over-impact/missing-floor quotes (SAVE-005, SAVE-006); input validation tested. |
| 20 | Vault Failure | 🟢 GREEN | Paused vault blocks and recovers when unpaused (SAVE-007); a reverted tx reconciles to FAILED, never SAVED. |
| 21 | Eligibility | 🟢 GREEN (mechanism) | Four honest states; no hardcoded countries; real-money gated on ELIGIBLE + verified substrate; SERVICE_UNAVAILABLE by default here; tested (`save-strategy.test.js`). A *live* provider determination is not wired → real ELIGIBLE unproven, and Save stays off (correct). |
| 22 | Privacy | 🟢 GREEN | Save adds no phone-derived or off-chain PII; positions are keyed by account address; proof exposes only chain-canonical facts the user owns. Inherits the no-`phone→wallet` invariant. |
| 23 | Recovery | 🟢 GREEN | Never-stranded guarantees: RECOVERY_AUSD_HELD (SAVE-017), REQUIRES_RECONCILIATION on ambiguity, no retry while SUBMITTED (SAVE-009, SAVE-011). |
| 24 | Live/Testnet Proof (real on-chain Save) | 🟡 YELLOW | **No real Save executed.** Blocker: earnAUSD substrate unverified + mainnet-only (143) vs Prism testnet (10143) + no live batch account. The 18-step real flow requires a verified-substrate environment; it was not run, and no fabricated tx hash stands in for it. |

## Summary

- 🟢 GREEN: 14 rows — every non-execution concern (entry, quote, accounting, APY truth, position read,
  receipt, proof engine, activity, restart, backend failure, quote failure, vault failure handling,
  eligibility mechanism, privacy, recovery) is proven by runtime evidence.
- 🟡 YELLOW: 10 rows — every one is an **execution** claim blocked by the single substrate gate. Each has
  its safety invariant proven by a hostile test even though the money leg cannot run here.
- 🔴 RED: 0 rows — nothing fails; the gated paths refuse honestly rather than faking success.

## What turns the YELLOW rows GREEN

One thing: a **verified earnAUSD substrate** — an independently verified deposit/Teller ABI, an
allowlisted USDC→AUSD route, and a live batch account on a chain where the assets exist. With that,
`substrateVerified` flips true, a real `SaveRouteProvider`/executor drops into the existing seams, and
the 18-step real flow can be run to produce on-chain evidence. Nothing in the architecture changes; the
gate simply opens.
