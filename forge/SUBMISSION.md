# SUBMISSION

State of the submission for FORGE 1.4. Track: **Consumer Products & Payments**. This file is the
checklist; it must reflect reality, not intent.

## One-liner
PRISM — send money to people, not wallet addresses. The load-bearing mechanism is **Prism
Continuity**: human identifiers are mutable reachability routes, not financial identities.

## Demo spine (what to show, in order)
1. Cold open → onboard (passkey/Mera) → pay a contact by name. No address, no gas, no chain choice.
2. **Continuity**: recipient rotates their phone (same identity) → paying them still works.
3. **Discontinuity**: an alias now points at a different identity → PRISM blocks and asks to review.
4. Payment Proof: open the payment → evidence-backed proof (privacy, no-MON, confirmed-on-Monad).

## Submission artifacts

| Item | Status | Location / note |
|---|---|---|
| Repo + control plane | ready | `/forge`, `/AGENTS.md`, `/forge.json` |
| Suites green | `VERIFIED` (132 / 43 / 89) | [`PROOF_LEDGER.md`](PROOF_LEDGER.md) |
| Continuity proven | `PARTIAL` | INV-C3 iOS half untested (F-1) — Step 1 of the plan |
| Live Monad demo | `UNTESTED` this phase | [`FAILURES.md`](FAILURES.md) F-4 |
| Video / walkthrough | TODO | record the demo spine above |
| Written submission text | TODO | derive from `PRODUCT.md` + `CORE_HYPOTHESIS.md` |

## External facts to confirm before submitting (do not invent)
- Exact event name / edition / dates / deadline for "FORGE 1.4".
- Official judging rubric and weightings (see [`RUBRIC.md`](RUBRIC.md) — currently unconfirmed).
- Submission portal, required links, and any mainnet/testnet requirement.

## Do-not-ship list
- No claim marked `VERIFIED` without executed evidence.
- No demo step that shows success before a reconciled Monad receipt.
- No surface that leaks a phone value (run `phone-leak-audit.test.js` before recording).
