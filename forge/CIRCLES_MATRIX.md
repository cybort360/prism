# FORGE MATRIX — Prism Circles

The final completion pass, graded honestly. **Source code existence does not count as GREEN.** Every
GREEN below names a command that was executed and the result it produced; every YELLOW names the
exact external blocker; a RED would name the exact mechanism that failed.

## How each row is graded

- **GREEN** — the mechanism is proven by executed evidence: backend tests over an in-memory Monad
  that enforces Safe's real `execTransaction` rules, Foundry tests against **real Safe v1.4.1
  bytecode on a Monad testnet fork**, and/or executed Swift tests.
- **YELLOW** — implemented and mechanically proven, but something outside this repository stops the
  claim being completed. The blocker is stated exactly.
- **RED** — a mechanism that failed. There are none.

Liveness on a public chain is graded **once**, in `Testnet Proof`, rather than dragging every row to
YELLOW: no Circle has been deployed and no Circle transaction has been broadcast to Monad.

## Commands run for this pass (2026-09-14)

```
cd backend && node --test test/*.test.js                                    # 362 pass / 0 fail
cd contracts && forge test --no-match-path 'test/circles/*'                 #  74 pass / 0 fail
cd contracts && FOUNDRY_PROFILE=circles forge test --match-path 'test/circles/*' --network monad
                                                                            #  22 pass / 0 fail (Monad fork)
cd tools/circles && npm run verify                                          #  18/18 vector checks
cd tools/circles && node verify-allowance-module.mjs --chain-id 10143       #  gate: NO usable module
SWIFT_HOME=… ./scripts/verify/swift-linux-check.sh                          #  98 parsed, 144 tests pass
cd backend && node --test test/privacy-leak.test.js test/mutation-audit.test.js test/phone-leak-audit.test.js
                                                                            #  17 pass / 0 fail
```

---

## The matrix

| # | Row | Status | Evidence, or the exact blocker |
|---|---|---|---|
| 1 | **Circle Entry** | 🟡 YELLOW | Backend entry surface proven: `GET /v1/circles` lists only your own Circles, a Circle you are not in is `404` (never `403`), and every Circle route refuses an unauthenticated caller — `circles-route-audit.test.js` 5/5, against a **running server**. The iOS entry points (Circles on Home, the detail screen) are SwiftUI: they parse, but cannot be compiled or driven. **Blocker:** no macOS/Xcode — `make test-ios` has never run. |
| 2 | **Circle Setup** | 🟢 GREEN | `circles-creation.test.js` + `circles-domain.test.js`: one route to ACTIVE and it runs through chain verification; `RECONCILING` is the only state with an edge to `ACTIVE`; a Circle marked ACTIVE without a verification receipt is un-trusted. Address prediction is deterministic and sensitive to every input (`circles-safe-adapter.test.js`). The deployed Safe's digest agrees with the real contract on all 6 committed vectors (`tools/circles` 18/18, Monad fork). |
| 3 | **Member Invite** | 🟢 GREEN | `circles-members.test.js` 21/21 + hostile audit: single-use invitations, expiry enforced at redemption, an invitation cannot be redeemed by anyone else, a removed person cannot be revived by a stale invite, and an invitation carries no phone number or address. Accepting an ADMIN invitation grants **no** authority — that waits for the Safe. |
| 4 | **Contribution** | 🟢 GREEN | Money in is an ordinary Prism payment to the Circle's Safe: personal balance falls and the Circle's rises by exactly the amount, read back from the token contract (`circles-payments.test.js`, `circles-hostile-audit.test.js` "money:"). A contribution re-labelled after signing does not reconcile. |
| 5 | **Threshold Payment** | 🟢 GREEN | `circles-payments.test.js` + `circles-e2e-scenario.test.js`: $500 in, one approval cannot send $120, two can, recipient +$120, Circle $380 — every figure read from the chain. The Safe transaction is fixed in shape (`USDC.transfer`), and no caller can supply a target or calldata. Against real Safe bytecode: `CircleSafeOwnerCompat` 17/17 on a Monad fork. |
| 6 | **Approval** | 🟢 GREEN | Approvals are signatures re-verified against the **live** owner set on every read, never a counter: CIR-001, CIR-002, CIR-008, CIR-009. A backend that rewrites its own row to claim the threshold is met still cannot execute. The device re-derives the digest before Face ID and refuses a mismatch — `CircleApprovalWireTests` 16/16, **executed**. |
| 7 | **Limited Spend** | 🟡 YELLOW | Mechanism proven at both levels: backend `circles-limits.test.js` + CIR-012…CIR-017, and the module's own guarantees against **Safe's canonical v1.0.0 runtime** in `AllowanceModuleCompat.t.sol` (replay, over-limit, wrong token, removed delegate, no owner-management, no arbitrary approval). **Blocker:** Safe's Allowance Module v1.0.0 is **not deployed on Monad (chain 10143)** — `verify-allowance-module.mjs` prints `RESULT: NO usable Allowance Module on chain 10143`, so the gate keeps limits OFF in production. |
| 8 | **Over-Limit Recovery** | 🟡 YELLOW | Proven as a fork, not a dead end: $101 against $100 is refused, the preview returns `route: THRESHOLD, requiresApproval: true` naming the limit, and the same payment completes as an ordinary approved Circle payment **without consuming the member's allowance** (`circles-e2e-scenario.test.js`). **Blocker:** same as row 7 — it cannot run in production while limits are off. |
| 9 | **Member Removal** | 🟢 GREEN | Removing an ordinary member is immediate and total: they lose the Circle (`404`) and cannot contribute. Their pending invitation dies with them. Removal is refused while the member still holds a live on-chain allowance — Prism will not take the label away and leave the access (`circles-members.test.js`, `circles-hostile-audit.test.js`). |
| 10 | **Admin Removal** | 🟢 GREEN | Admin authority cannot be granted or revoked in Prism at all: `setMemberRole` and `removeMember` refuse and name the governance act. Removal is a threshold-approved Safe transaction, applied only after the owner set is **read back** (`circles-governance.test.js` 22/22). A removed admin's approval stops counting with nobody telling Prism (CIR-008), and `PENDING_REMOVAL` never pretends authority has already gone. |
| 11 | **Activity** | 🟢 GREEN | One feed, two classes. Money rows correspond one-to-one with the contributions/payments/spends that exist and reconcile with the chain (`in − out == balanceOf(safe)`); governance rows carry no money fields at all; a change nobody executed is absent (`circles-activity.test.js` 5/5). Red-before-green recorded in `PROOF_LEDGER.md`. |
| 12 | **Receipt** | 🟢 GREEN | A Circle payment is one canonical `PrismPayment` with a `circle` block — same detail screen, same receipt (`circles-evidence.test.js` 10/10). The iOS half is **executed**: `CircleReceiptTests` 11/11 and `PaymentDetailsModelTests` 15/15 under `swift test`, proving "Paid from / Requested by / Approved by / Approval rule", the contribution wording, and that a within-limit spend never claims an approval. |
| 13 | **Proof** | 🟢 GREEN | The SHARED ACCOUNT section with its sources kept straight — owners/threshold from the Safe, balance from USDC, the payment from the Monad receipt and its `Transfer` log, the limit from the module. The Safe Transaction Service is recorded as `coordination`, never execution evidence; Envio is `not_applicable` for a Safe transfer. `circles-evidence.test.js`, iOS `PaymentProofTests` 6/6 executed. |
| 14 | **Persistence** | 🟢 GREEN | A restart loses nothing: a new process over the same store file and the same chain recovers the Circle, its ACTIVE status, its members, its balance (read from the chain, not remembered), its completed payment with evidence, and its receipt with both approvers — then carries on and executes a second payment (`circles-e2e-scenario.test.js`). |
| 15 | **Failure** | 🟢 GREEN | A simulation that fails is never broadcast. A receipt without a matching USDC `Transfer` never becomes COMPLETED. A row hand-marked COMPLETED with its evidence removed reads back as INVALIDATED, with what it claimed still visible. Circle failures use the shared taxonomy (`CIRCLE_APPROVAL_INVALIDATED`, `CIRCLE_NONCE_CONSUMED`, `CIRCLE_EXECUTION_FAILED`), not a parallel one. |
| 16 | **Recovery** | 🟢 GREEN | Three outages proven: **Safe Transaction Service down** — proposing fails honestly, no funds move, and the owners' recovery path is unaffected; **Prism entirely gone** — two owners build, sign and execute a Safe transaction with no CircleService involved, and empty the Circle; **lost relayer response** — reconciles from chain truth and never re-broadcasts (`mutation-audit` MUT-16). A stale-nonce or invalidated payment can be cancelled and re-proposed. |
| 17 | **Circle Closing** | 🟢 GREEN | `ACTIVE → CLOSING → CLOSED` with four requirements checked by live reads, and a read that fails is itself a blocker. A Circle holding money cannot be closed — Prism proposes no distribution. Money can still leave a closing Circle and can never enter one. Closing keeps every record; `closing.evidence` preserves what the Circle was. Reopening re-earns ACTIVE through RECONCILING (`circles-closing.test.js` 8/8, `circles-e2e-scenario.test.js`). |
| 18 | **Onchain Authority** | 🟢 GREEN | Against **real Safe v1.4.1 on a Monad fork** (`CircleSafeOwnerCompat` 17/17): the Monad deployment is canonical v1.4.1; a modified recipient, amount, token target, operation, nonce, Safe or chain id all fail; a replay fails; a single approval on 2-of-2 fails. Prism's digest matches the deployed contract on every committed vector, cross-checked independently by Safe's own Protocol Kit (18/18). |
| 19 | **Privacy** | 🟢 GREEN | No raw phone, phone digits or phone-derived key in the Safe transaction, the execution receipt's logs, the canonical payment, the receipt or the proof — with the detector proven to have actually run over real fields (`circles-evidence.test.js` PROOF 7, red-before-green). Backed by `phone-leak-audit`, `privacy-leak`, `mutation-audit` (17/17) and `PrismPrivacy.t.sol`. |
| 20 | **Zero-MON** | 🟢 GREEN | On a **Monad fork with real Safe bytecode**: `test_CircleSettlesWithEveryMemberHoldingZeroMon`. In the backend: a full flow (contribute → propose → approve ×2 → execute → limited spend) with every member's MON balance 0, plus the structural reason — the backend has exactly one wallet and it is the relayer's; members sign typed data and never a transaction. |
| 21 | **Testnet Proof** | 🟡 YELLOW | **No Circle has been created or paid on live Monad.** Everything above is the harness, real Safe bytecode on a fork, and executed Swift tests. **Blocker:** no funded Monad testnet key in this environment — `RELAYER_PRIVATE_KEY` is empty in `backend/.env`, and Circle deployment plus every Circle payment needs a relayer that can pay MON. The scenario is written and passes as a rehearsal (`circles-e2e-scenario.test.js`); running it live needs only a funded key. The spending-limit half additionally needs the Allowance Module deployed (row 7). |

**Score: 17 GREEN · 4 YELLOW · 0 RED.**

## The four YELLOWs, in one place

| Blocker | Blocks | What it needs |
|---|---|---|
| No macOS/Xcode | Row 1 (and the SwiftUI half of every UI claim) | A Mac. `make test-ios-linux` already parses all 98 sources and runs 144 XCTest cases; the views and coordinators need the real toolchain. |
| Allowance Module v1.0.0 not deployed on Monad | Rows 7, 8 | Safe deploying it, or Prism deploying the canonical runtime (`DeployAllowanceModuleV1.s.sol`, verified in simulation) — which needs a funded key and is an operator decision. |
| No funded Monad testnet key | Row 21 | A key with MON. The relayer pays gas for every Circle transaction, so nothing can be broadcast without one. |
| (consequence) Safe Transaction Service exercised local-only | Row 21's coordination half | A hosted service; the code path is proven in its absent configuration, and the outage behaviour is tested. |

## What would turn each YELLOW GREEN

1. **Row 21** — fund a key, run `circles-e2e-scenario` against live Monad, record the Safe address and
   the transaction hashes for: deployment, three contributions, the $120 payment, and the close.
2. **Rows 7 and 8** — deploy the canonical Allowance Module runtime to Monad, flip
   `CIRCLE_LIMITS_ENABLED` (the gate re-checks the code hash on every call), then run the limit half
   of the same scenario live.
3. **Row 1** — `make test-ios` on a Mac; the iOS suites already pass everywhere they can be run.

## Not claimed

- No Circle exists on a public chain. No Circle transaction hash exists to cite.
- Spending limits are OFF in production and the gate enforces it.
- The iOS app has never been compiled for a device or a simulator.
- The in-memory Monad in `circles-harness.js` enforces Safe's real rules, but it is not Safe. Where a
  claim needed the real thing, it was proven against real bytecode on a fork — and where it was not,
  this document says so.
