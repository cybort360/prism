# AGENTS.md — read this first

This repository is under the **FORGE 1.4** control plane. The map lives in [`/forge`](forge/).

## Ground rules (non-negotiable)

- **Repository files are the source of truth.** Prior chat summaries, transcripts, and memories are
  *not* authoritative — when they disagree with the code or the `/forge` docs, the code wins.
- **Do not mark a claim `VERIFIED` without executed evidence.** "The code exists" is not evidence.
  Use only these statuses: `UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`. Record what command
  produced the evidence in [`/forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md).
- **Do not weaken a test to make it pass.** Fix the code or record the failure.
- **Do not introduce a mock/fake success path into production code.** Dev adapters must announce
  themselves and must never claim a real OTP, settlement, or delivery occurred.
- **Do not rebuild PRISM from scratch and do not remove working behavior.**

## Before any meaningful change, read

1. [`/forge/PRODUCT.md`](forge/PRODUCT.md) — what PRISM is and the load-bearing mechanism.
2. [`/forge/INVARIANTS.md`](forge/INVARIANTS.md) — the properties that must never break.
3. [`/forge/ARCHITECTURE.md`](forge/ARCHITECTURE.md) — the real components (and the P256/"smart
   account" wording caveat).
4. [`/forge/EXECUTION_PLAN.md`](forge/EXECUTION_PLAN.md) — the current phase and its scope.
5. [`/forge/PROOF_LEDGER.md`](forge/PROOF_LEDGER.md) — what is actually proven vs not.

## The one mechanism to protect

**Prism Continuity.** Human identifiers (phone / @handle / QR / link) are *mutable reachability
routes*, not financial identities or spending authority:

```
HOW I AM FOUND → WHO I AM → WHO MAY AUTHORIZE MY MONEY → WHERE MY MONEY LIVES
```

Reachability may change without silently changing recipient identity. A legitimate alias change that
still resolves to the same `PrismIdentity` preserves continuity; an alias that now resolves to a
*different* identity must be visibly blocked/reviewed, never silently redirected.

## The `/forge` control plane

`EVENT · RUBRIC · COMPETITION · PRODUCT · CORE_HYPOTHESIS · INVARIANTS · ARCHITECTURE · JUDGE_PATH ·
CLAIMS · PROOF_LEDGER · FAILURES · QUALITY · EXECUTION_PLAN · SUBMISSION · RETROSPECTIVE` — plus
[`/forge.json`](forge.json) (machine-readable manifest).
