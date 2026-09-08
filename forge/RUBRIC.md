# RUBRIC

> **The official judging rubric and weightings for FORGE 1.4 are external and NOT yet confirmed in
> this repo.** Do not treat the table below as authoritative. When the real rubric is available,
> replace this with it verbatim and map each criterion to evidence in
> [`PROOF_LEDGER.md`](PROOF_LEDGER.md).

## Working self-assessment (until the real rubric lands)

A plausible Consumer Products & Payments rubric, used only to keep us honest about where we're strong
and weak. Weightings are placeholders.

| Dimension | What a judge likely asks | PRISM's honest position |
|---|---|---|
| Consumer UX | Can a normal person pay without crypto knowledge? | Strong flows; **no cold-user evidence** (thesis #12, UX-1 `UNTESTED`). |
| Novelty / insight | Is there a real idea, not just a wrapper? | **Prism Continuity** — reachability ≠ identity ≠ authority ≠ money. Load-bearing and code-backed. |
| Technical depth | Is it actually built and safe? | Deep: bound authorizations, single-use nonces, guarded lifecycle, privacy detector. Suites 132/43/89 `VERIFIED`. |
| Safety / correctness | Does it fail safe? | Mutation/replay rejected; submission ≠ completion; discontinuity blocked (server `VERIFIED`, iOS `PARTIAL`). |
| On-chain reality | Does it work on Monad for real? | Deployed manifest exists; **live e2e not re-verified this phase** (`UNTESTED`). Honest gap. |
| Privacy | Any sensitive leakage? | No phone (raw/derived) on any public surface — `VERIFIED`. |
| Proof / rigor | Can claims be checked? | `/forge` + `JUDGE_PATH.md` + `PROOF_LEDGER.md`; nothing `VERIFIED` without a run. |

## Rule
When the official rubric arrives: (1) paste it here, (2) create a row per criterion, (3) link each to
executed evidence, (4) do **not** self-score a criterion `VERIFIED` without it.
