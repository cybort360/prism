# SECURITY PROOF — FORGE hostile audit

Posture: the product was treated as lying until a test or a chain read said otherwise. Every row
below is either backed by an executable check or marked **UNPROVEN** with the reason.

Suites at time of writing: **30 contract tests** (`forge test`), **39 backend tests**
(`node --test test/*.test.js`), **30,000 fuzz runs** (`--fuzz-runs 10000` × 3 properties),
**256 runs / 128k calls** of the vault invariant. All green.

## Mutation matrix

| ID | Mutation | Verdict | Evidence |
|---|---|---|---|
| MUT-01 | Raw phone into calldata / event / storage | **REJECTED** | `contracts/test/PrismPrivacy.t.sol` — settles a real payment and a full claim lifecycle, then scans calldata, every event topic and data blob, and every written storage slot for the phone ASCII, `keccak256(phone)`, `sha256(phone)`, and the digits as a `uint256`. Plus `backend/test/privacy-leak.test.js::LEAK-01`. |
| MUT-02 | `SHA256(phone)` public mapping | **REJECTED** | `LEAK-02` asserts `phoneLookupKey != sha256(phone)` and proves the key is *keyed* (changing only the pepper changes the key). Lookup is `HMAC-SHA256(pepper, E164)`, server-side, never returned to a client (`LEAK-04`). No on-chain phone map exists — the vault keys on random `claimId` / `recipientReference`. |
| MUT-03 | New SIM + OTP takeover of a funded account | **REJECTED** | `identity.test.js` "OTP-style phone possession cannot seize a bound account". `IdentityService.upsertVerifiedPhone` throws 409 when the phone already indexes an identity bound to a different account. OTP moves reachability, never spending authority. |
| MUT-04 | Reuse a revoked / stale resolver response | **REJECTED** | `mutation-audit.test.js` MUT-04 ×2. `PaymentService.assertResolution` re-reads the identity and rejects on `aliasVersion` drift *or* account repoint; `verifyResolution` binds requester, enforces a 2-minute lifetime, and fails closed on a tampered attestation. |
| MUT-05 | Amount changed after Mera signature | **REJECTED** | `testModifiedAmountRejected`; `security-boundaries.test.js`. `amount` is in both the Prism envelope digest and the AUSD ERC-3009 digest — mutation breaks two independent `ecrecover`s. |
| MUT-06 | Recipient changed after Mera signature | **REJECTED** | `testModifiedRecipientRejected`; `mutation-audit.test.js` MUT-06 (forged signature never reaches the relayer: `writeContract` call count is 0). |
| MUT-07 | requestId changed after Mera signature | **REJECTED** | `testModifiedRequestIdRejected`. `requestId` is inside the envelope struct hash. |
| MUT-08 | Replay an AUSD authorization | **REJECTED** | `MockAUSD._authorizationStates[from][nonce]` (faithful to live AUSD, which exposes the same `authorizationState`); `testReplayRejected`; `mutation-audit.test.js` MUT-08 asserts a settled payment is never broadcast twice. |
| MUT-09 | Replay a Prism PaymentEnvelope | **REJECTED** | `testPaymentIdReuseRejected` — `paymentUsed[paymentId]` and `nonceUsed[payer][nonce]`, both set before the external token call. |
| MUT-10 | Claim twice | **REJECTED** | `testDoubleClaimFails` — status flips `Funded → Claimed`; a second call reverts `NotFunded`. |
| MUT-11 | Claim after refund | **REJECTED** | `testClaimAfterRefundFails` — status `Refunded` is not `Funded`. |
| MUT-12 | Refund before expiry | **REJECTED** | `testRefundBeforeExpiryFails` — reverts `NotYetExpired`. |
| MUT-13 | Bulk unauthenticated phone lookup | **RATE LIMITED** | `mutation-audit.test.js` MUT-13. Every resolver route is session-authenticated (no anonymous lookup exists); sweeping trips `429` at ≤60 lookups/hour per identity, and the counter is persisted so a restart does not reset it. **Caveat below.** |
| MUT-14 | Trusted alias now resolves to a different account | **WARN + BLOCKED** | Backend: `assertResolution` 409s on account/version drift. iOS: `IdentityTrustStore.warning(for:)` diverts to `IdentityChangeReviewView` instead of the send sheet (`PeopleView.swift:131,152`, `PersonPickerView.swift:148,189`). **Caveat below.** |
| MUT-15 | Backend says success, Monad reverted | **REJECTED** | `mutation-audit.test.js` MUT-15 ×2: a `reverted` receipt yields `failed` and stays failed on re-read; an unmined tx yields `confirming`, never `completed`. iOS `PaymentCoordinator.swift:77` sets `.sent` **only** on `state == "completed"`. |
| MUT-16 | Relayer response lost after broadcast | **REJECTED (after fix)** | `mutation-audit.test.js` MUT-16 ×3. **This was a real gap — see Finding 2.** |

## Findings

### Finding 1 — `bind_account` proof is a static, replayable message (HIGH, OPEN)

`IdentityService._assertAccountControl` verifies a `personal_sign` over:

```json
{"account":"0x19e7…ff2a","action":"bind_account"}
```

No nonce, no timestamp, no expiry, no chainId, no verifyingContract. Signatures are not secrets, so
anyone who obtains this one signature can replay it against `POST /v1/auth/device` forever and be
issued a session for the victim's Prism identity.

Reproduced (`proof/poc/bind-replay.mjs`):

```
victim prismId      : 525a9d4f-b159-4f40-a03f-69f9010df572
attacker got prismId: 525a9d4f-b159-4f40-a03f-69f9010df572 (same identity: true)
attacker session ok : true
readable as victim  : {"phoneMasked":"+234803 ••• ••67","account":"0x19E7…ff2a","handle":null}
mutable w/o acct sig: phoneDiscoverable -> false
```

**Impact.** Not fund theft — spending still needs a fresh Mera signature over the envelope and the
AUSD authorization, and `/v1/payments/submit` verifies both. But the session grants read access to
`/v1/me` (masked phone, account, handle), `/v1/me/balance`, `/v1/activity` (full payment history),
`/v1/claims`, and alias resolution *as the victim*; and `POST /v1/me/privacy` and `/v1/me/profile`
require only a session, not an account signature, so an attacker can flip the victim's
discoverability. For a product whose first stated principle is phone privacy, that is a material
break.

**Fix.** Issue a server-side challenge: `GET /v1/auth/challenge` → single-use nonce with a short
TTL; sign `{action, account, nonce, chainId, exp}`; verify and burn the nonce. Then give
`setPrivacy`/`setProfile` the same account-signature treatment `setHandle` and `bindPhone` already
get. Left unfixed here because the payload is co-defined in
`ios/MeraBridge/MeraAccountManager.swift:bindingProofHex`, and the iOS half cannot be compiled or
tested in this environment (see `EVIDENCE_MANIFEST.json` → `blocked.ios_toolchain`).

### Finding 2 — a lost relayer response caused a blind re-broadcast (HIGH, FIXED)

`PaymentService.submitPayment` awaited `relaySettle` and only persisted a `txHash` *after* it
returned. If the response was lost after the transaction reached the network, the exception
propagated with the record still in `prepared`, so the client's retry re-entered the relayer and
broadcast the same authorization a second time. `withIdempotency` did not cover this: it caches only
on success, and a thrown producer caches nothing.

On-chain guards meant this was never a double-spend — `paymentUsed[paymentId]` and AUSD's
`authorizationState` both reject the second settle — but it burned relayer gas on a doomed
transaction and contradicted the stated requirement to reconcile rather than resubmit. The same
pattern in `fundClaim` was worse: it called `markFundingFailed` on *any* error, labelling a claim
failed while its funding may have been landing.

**Fix applied.** The record moves to a `broadcasting` state *before* the relay call. On error, the
failure is classified: a provable pre-broadcast failure (our own argument validation, or a viem
simulation revert) re-arms the record as `prepared`; anything else — timeouts, socket errors,
unknown — is treated as ambiguous and stays `broadcasting`. A retry against a `broadcasting` record
reads `AUSD.authorizationState(payer, nonce)`, the value AUSD sets in the same transaction that
moves the money: used ⇒ resolve to `confirming` and poll, never resend; unused ⇒ nothing settled, so
re-arm and allow a genuine retry.

The tests fail against the pre-fix code (verified by reverting `paymentService.js` and re-running:
MUT-16 tests 6 and 7 go red) and pass after it.

### Finding 7 — the iOS app did not compile (HIGH, FIXED)

Static review of the Swift sources found no defect in the MUT-15 logic, but the audit could not
build the app — no macOS in this environment. Pushing the branch put it in front of CI's `macos-15`
job, which failed: five Swift 6 strict-concurrency errors under `SWIFT_VERSION: "6.0"`.

- `PrismHaptics`'s static methods were nonisolated while every UIKit feedback generator they call is
  `@MainActor`-isolated — *"Call to main actor-isolated instance method 'notificationOccurred' in a
  synchronous nonisolated context"*, five times over.
- `BiometricService.authenticate` returned `LAContext`, which is non-Sendable and cannot cross an
  async boundary — *"Non-sendable result type 'LAContext' cannot be sent from nonisolated context"*,
  at both call sites.

This matters beyond the build: the Face ID gate (`PaymentCoordinator.localApproval`) and the MUT-15
`.sent` binding (`PaymentCoordinator.swift:77`) that this audit reviewed were in files that did not
compile. A green static review of code that cannot build is worth very little, which is the point
worth taking from it.

Fixed: `@MainActor` on `PrismHaptics`, and `authenticate` returns `Void` (neither caller used the
context — the gate is the throw). Verified by CI, not locally.

### Finding 8 — onboarding failed in CI on a Keychain write (FIXED, verified green)

With the app compiling and CI running a dev backend, the onboarding UI test gets further but still
fails. The backend confirms the account was created:

```
{"event":"http","method":"POST","path":"/v1/auth/device","status":200,"ms":2701}
```

and then no further request arrives. The test times out waiting for the reachability screen. With
the diagnostics added, the alert names itself:

```
alert="Prism" text=[Prism | The operation couldn't be completed. (Prism.KeychainError error 0.)]
```

`KeychainError.write` — `SecItemAdd` failed. **Root cause: a CI configuration artifact, not a
product defect.** The job invoked `xcodebuild` with `CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY=""`,
which builds the app with no entitlements at all. Without entitlements the app has no
application-identifier, and every Keychain write fails with `errSecMissingEntitlement`. Onboarding
stores the payment PIN and the simulator's dev signer seed in the Keychain, so it cannot get past
account creation.

The distinction matters and should not be blurred: on a real device, or any signed build, signing is
on and the Keychain works. This was CI testing a configuration nobody ships. Fixed by dropping the
signing overrides and letting the simulator's default ad-hoc identity apply the entitlements —
`CODE_SIGNING_REQUIRED=NO` is retained, since no real identity is needed.

What this does expose about the product: `KeychainStore` collapses every `SecItemAdd` failure into
`KeychainError.write`, so the user-facing alert was `"KeychainError error 0"` and the OSStatus —
which names the cause exactly — was discarded. Surfacing the status would have made this a one-run
diagnosis instead of three. `KeychainError` now carries the `OSStatus` and renders it through
`SecCopyErrorMessageString`.

**Verified.** CI run 33855151198 is fully green, and
`OnboardingFlowUITests.testPhoneOnboardingReachesHome` **passed in 34.9s**.

## Caveats — real limits on the verdicts above

- **MUT-13 is per-identity, not global.** The 60/hour ceiling is keyed on `requesterPrismId`; there
  is no global or per-IP cap on `/v1/resolve/*`. An attacker able to mint N identities gets 60N
  lookups/hour. Identity creation costs an OTP and a Mera account-control signature, which raises
  the price, but the limit is not a hard ceiling on enumeration.
- **MUT-14's trust store is `UserDefaults`, not the Keychain**
  (`PeopleView.swift` → `trusted.recipient.identities`). Trust-on-first-use pinning in
  `UserDefaults` is readable and writable from an unencrypted device backup, so an attacker with
  backup access can delete the pin and suppress the identity-change warning. It belongs in the
  Keychain.
- **The claim authorizer is a single point of failure.** `PrismClaimVault.claim` releases funds on
  one `claimAuthorizer` signature plus the recipient's own intent. The recipient's intent proves
  *who is asking*, not *who is entitled* — entitlement is entirely the authorizer's word. Compromise
  of that key drains every funded claim. `aliasVersion` is inside the signed struct but is never
  compared to any on-chain value, so it is an off-chain freshness assertion, not an on-chain
  guarantee. The KMS/HSM requirement in `docs/SECURITY.md` is load-bearing, not advisory.
- **Everything iOS is static review plus CI.** No macOS, Xcode, simulator, or device exists in this
  environment; the only iOS signal is GitHub Actions' `macos-15` job. That job now proves the app
  builds, that both unit tests pass, that the app launches and renders onboarding on a simulator,
  and that the Mera bridge derives an account and produces a signature the backend accepts. It does
  **not** prove MUT-14's UI gate or MUT-15's `.sent` binding, which are further into the flow than
  the UI test currently reaches, and it proves nothing about passkeys or Face ID, which need real
  hardware.

## Non-vacuity

Two of the scanners are self-guarded, because a privacy test that cannot fail is worse than none:

- `PrismPrivacyTest::testScannerDetectsPhoneDerivedValue` feeds the scanner a blob containing
  `sha256(phone)` and one containing the raw ASCII, and asserts it reverts on both.
- `LEAK-01` was re-run with the fixed leak reintroduced and failed with
  `raw E.164 numbers found at rest in the datastore: +2348031234567, +447700900123`.
