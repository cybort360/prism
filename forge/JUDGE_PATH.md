# JUDGE PATH

The shortest path for a skeptical judge to check PRISM's central claim (Prism Continuity) and its
guardrails — with commands, not assertions.

## 0. Orientation (2 min)
Read [`PRODUCT.md`](PRODUCT.md) and [`INVARIANTS.md`](INVARIANTS.md). The one claim to test:
*reachability may change without silently changing recipient identity.*

## 1. Run the suites (evidence, not screenshots)
```bash
make test          # or individually:
cd backend && node --test test/*.test.js        # expect 362 pass
cd contracts && forge test --no-match-path 'test/circles/*'   # expect 74 pass (invariants ~230s)
cd ios && xcodegen generate && \
  xcodebuild -scheme Prism -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:PrismTests test                  # needs macOS
```
Without a Mac, get as far as Swift honestly goes — parse every iOS source, then typecheck and RUN the
suites that do not need SwiftUI/UIKit/Combine:
```bash
SWIFT_HOME=/path/to/swift-6.x-ubuntu24.04 make test-ios-linux   # 98 parsed · 144 tests pass
```
Circles against the real Safe deployment, and the hostile audit:
```bash
cd contracts && FOUNDRY_PROFILE=circles forge test --match-path 'test/circles/*' --network monad
                                                 # 22 pass, on a Monad testnet fork
cd backend && node --test test/circles-hostile-audit.test.js   # CIR-001…CIR-017, 25 pass
cd backend && node --test test/circles-route-audit.test.js     # the HTTP surface, 5 pass
```
Update [`PROOF_LEDGER.md`](PROOF_LEDGER.md) if any count differs. The Circles grading —
what is proven, what is blocked and by exactly what — is [`CIRCLES_MATRIX.md`](CIRCLES_MATRIX.md).

## 2. Continuity — the load-bearing check
```bash
cd backend
node --test test/security-boundaries.test.js
```
Look for:
- *"phone rotation increments alias version without changing account"* → **INV-C1** (legitimate alias
  change preserves continuity: same account).
- *"phone rotation invalidates the previous resolution version"* → **INV-C2** (stale resolution
  unusable after rotation).

Read `paymentService.assertResolution` (409 on account/aliasVersion mismatch) and iOS
`IdentityTrustStore.warning` (fires on `prismId`/`account` change, **not** on alias-only change) →
**INV-C3** (visible review on discontinuity). Note: the iOS half is **untested** (see FAILURES F-1).

## 3. Privacy — no phone on-chain
```bash
cd backend && node --test test/phone-leak-audit.test.js
cd contracts && forge test --match-contract PrismPrivacy
```
Scans every public/on-chain/evidence surface for the fixture phone `+2348031234567` and its
deterministic hash.

## 4. No mutation / no replay / submission ≠ completion
```bash
cd contracts && forge test --match-contract PrismPaymentRouter
cd backend && node --test test/mutation-audit.test.js
```
`testModified*`, `testReplayRejected`, MUT-15 (reverted ≠ completed), MUT-16 (ambiguous submission
reconciled, never re-broadcast).

## 5. In-app Payment Proof
Open any payment in the app → **Payment Proof**. It shows the evidence-backed status, the privacy
detector result, gas sponsorship, and independent readback — honest per-check, never a color-only
badge. See `../docs/PAYMENT_PROOF.md`.

## What is NOT proven (be fair)
See [`PROOF_LEDGER.md`](PROOF_LEDGER.md) "On-chain / live" and "UX": live end-to-end Monad txs and
cold-user comprehension are not evidenced in this phase.
