# INVARIANTS

Properties that must never break. Each has an **enforcement point** in code and an **evidence**
status (`UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`). "Code exists" is never `VERIFIED`.

## Continuity (the load-bearing invariant)

### INV-C1 — A legitimate alias change preserves continuity
Changing a reachability alias (e.g. rotating a phone) that still resolves to the **same PrismIdentity
and account** must not break the ability to pay that person.
- **Enforcement:** `identityService.bindVerifiedPhone` increments `aliasVersion` but keeps
  `accountAddress`; iOS `IdentityTrustStore.warning` returns `nil` when only `aliasVersion` changed
  (it compares `prismId` and `accountAddress`, not the alias).
- **Evidence:** `VERIFIED` — backend `security-boundaries.test.js` → *"phone rotation increments alias
  version without changing account."*

### INV-C2 — A stale resolution is unusable after rotation/revocation
A resolution attestation minted for `aliasVersion = N` must be rejected once the identity has moved.
- **Enforcement:** `paymentService.assertResolution` re-verifies the signed attestation and rejects
  (HTTP 409, *"stale or changed recipient identity"*) unless `identity.accountAddress` and
  `identity.aliasVersion` both still match; `resolverService.verifyResolution` also enforces the
  requester binding and a short expiry.
- **Evidence:** `VERIFIED` — backend `security-boundaries.test.js` → *"phone rotation invalidates the
  previous resolution version."*

### INV-C3 — An alias resolving to a *different* identity is visibly blocked, never silently redirected
If an alias now resolves to a different `PrismIdentity`/account than the payer last paid, PRISM must
stop and require review.
- **Enforcement (client):** `IdentityTrustStore.warning(for:newResolution:)` fires when
  `old.prismId != att.prismIdentity` **or** `old.accountAddress != att.recipientAccount`, routing to
  `IdentityChangeReviewView` (triggered in `PersonPickerView`, `PeopleView`).
- **Enforcement (server):** `assertResolution` blocks a changed account at settlement (409).
- **Evidence:** `PARTIAL` — server path covered by INV-C2's test; **the iOS `IdentityTrustStore`
  warning logic has no unit test.** See [`FAILURES.md`](FAILURES.md) F-1.

## Authority & money

### INV-A1 — Reachability is not spending authority
Possessing a phone number / OTP / alias can never move money. Authority is the Mera passkey account.
- **Enforcement:** every settlement verifies an EIP-712/191 signature that recovers to the payer's
  Mera account; OTP only proves reachability for alias binding, never spending.
- **Evidence:** `VERIFIED` (design + tests) — `PrismClaimVault.t.sol` dual-signature tests; backend
  claim-ops "wrong alias → not eligible"; `PaymentProof.otpForSpending == "no"`.

### INV-A2 — Recipient/amount/route bound in the signed authorization (no mutation)
- **Enforcement:** ERC-3009 nonce co-binds recipient+amount; `routeHash` folds the cross-chain
  destination into the same signed envelope slot.
- **Evidence:** `VERIFIED` — `PrismPaymentRouter.t.sol` (`testModifiedAmount/Recipient/RequestId`,
  `testReplayRejected`), `PrismRouterExternalRecipient.t.sol`, backend `mutation-audit.test.js`.

### INV-A3 — Single-use authorization (no replay)
- **Enforcement:** ERC-3009 single-use nonce; `usdcAuthorizationUsed` reconciliation for lost
  broadcasts (never blind re-broadcast).
- **Evidence:** `VERIFIED` — `testReplayRejected`; `mutation-audit.test.js` MUT-08/16.

## Privacy

### INV-P1 — No phone (raw or derived) on any public/on-chain/evidence surface
- **Enforcement:** random `claimId`/`recipientReference`; `resolutionHash` derived only from opaque
  resolver data; phone stored encrypted + a private `phoneLookupKey` (HMAC) index, never emitted.
- **Evidence:** `VERIFIED` — `contracts/test/PrismPrivacy.t.sol`,
  `backend/test/phone-leak-audit.test.js` (scans proof/canonical/activity/logs/events for
  `+2348031234567` and its hash), `aurora-privacy.test.js`.

## Money truth

### INV-M1 — Submission is never completion
UI-terminal ("Sent"/"Delivered") only after a **reconciled Monad receipt**.
- **Enforcement:** `paymentService.reconcile` transitions to `completed` only on a success receipt;
  `PaymentCoordinator` polls backend `"completed"`. Cross-chain: the Monad leg completing is **not**
  delivery (separate route state machine).
- **Evidence:** `VERIFIED` — `mutation-audit.test.js` MUT-15 (reverted → failed, never completed),
  MUT-16 (ambiguous submission reconciled, never re-broadcast).

### INV-M2 — Backend is not the canonical balance authority
- **Enforcement:** balances are on-chain reads (`usdcBalanceOf`); the backend holds a guarded state
  machine + event log, never a ledger of balances.
- **Evidence:** `PARTIAL` — architectural (no balance-ledger in the store); no dedicated test asserts
  the negative.

### INV-G1 — A payer with MON = 0 can pay
- **Enforcement:** relayer submits the gasless ERC-3009 transfer and pays MON.
- **Evidence:** `PARTIAL` — `proof/ZERO_MON_PROOF.md` (local); not re-verified end-to-end on testnet
  this phase.

---

**Rule:** if a change touches any enforcement point above, its invariant's evidence status resets to
at most `PARTIAL` until re-run, and the change must be reflected in [`PROOF_LEDGER.md`](PROOF_LEDGER.md).
