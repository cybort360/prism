# QUALITY BAR

The standard every change is held to. If a change can't meet these, it isn't done.

## Evidence discipline
- No claim reaches `VERIFIED` without an executed command and its recorded result in
  [`PROOF_LEDGER.md`](PROOF_LEDGER.md). "Code exists" ≠ proven.
- Prior chat/transcript summaries are not evidence. Re-run.

## Honesty in code
- **No mock/fake success in production paths.** Dev adapters (dev OTP, dev bridge) must announce
  themselves and must never assert a real OTP / settlement / delivery happened.
- **Submission is never completion.** No UI state may read "Sent/Delivered/Received" before a
  reconciled Monad receipt (INV-M1).
- **No test weakened to go green.** Fix the code or record the failure in [`FAILURES.md`](FAILURES.md).

## Consumer surface
- Never surface a raw wallet address, gas, chain choice, or seed phrase for a person-payment.
- Consumer copy is fintech-plain; the technical/proof surfaces are precise but restrained (no
  blockchain-explorer aesthetic). See `../docs/RECEIPTS.md`, `../docs/PAYMENT_PROOF.md`.
- Status is never conveyed by colour alone (accessibility); proof rows carry text labels.

## Privacy
- No phone value — raw or deterministically derived — on any public/on-chain/evidence surface
  (INV-P1). New surfaces must be added to `phone-leak-audit.test.js`.

## Green before merge
- Backend + contracts + iOS suites pass locally before a merge.
- After any merge that adds/removes Swift files, run `xcodegen generate` before building (see
  FAILURES historical note).
- After touching an invariant's enforcement point, reset its status to ≤ `PARTIAL` until re-run.

## Scope discipline
- Do not rebuild PRISM from scratch; do not remove working behavior.
- Feature work is out of scope in the `continuity-vertical-slice` phase (see
  [`EXECUTION_PLAN.md`](EXECUTION_PLAN.md)).
