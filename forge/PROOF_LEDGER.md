# PROOF LEDGER

The single record of what is actually proven. A row is `VERIFIED` **only** with a command that was
executed and its result. `UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`. Never upgrade a row
because code exists.

## Suite runs (executed 2026-09-08, this session, on `main`)

| Suite | Command | Result | Status |
|---|---|---|---|
| Backend | `cd backend && node --test test/*.test.js` | 159 pass / 0 fail (148 + 4 p256-account + 2 device-key activity/reconcile + 5 continuity-lab) | `VERIFIED` |
| Contracts | `cd contracts && forge test` | 49 pass / 0 fail (43 + 6 PrismP256Account) | `VERIFIED` |
| iOS unit | `xcodebuild … -only-testing:PrismTests test` | 112 pass / 0 fail (109 + 3 device-P256 credential) | `VERIFIED` |

## Winning vertical slice (2026-09-09) — `bash scripts/verify/vertical-slice.sh`

Reproducible verifier: **11 PASS · 1 PARTIAL · 0 FAIL**. Slice = Contact → protected resolution →
PrismIdentity continuity → amount → authorization → secp256k1 signature → `PrismPaymentRouter` →
gas-sponsored Monad execution → confirmed/reconciled settlement → receipt.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| R1 | Actual P-256 signature path (device P-256 → smart account) | `VERIFIED` | **built + deployed + proven live.** `PrismP256Account` (a relayer-sponsored smart account whose spending authority is a device P-256 key, verified on-chain via the `0x0100` precompile). Local `PrismP256Account.t.sol` 6/6 (binding/replay/expiry, red-before-green on amount binding). LIVE on Monad: deploy `0xd41b…d553`, P-256-authorized payment `0xdea243b17623b35ea346e6bad05fe1f515c2fa80190d06f61800bced453b8a88` (status `0x1`) — recipient +1.00 USDC, account MON = 0 (gas sponsored); mutate-amount / mutate-recipient / replay / wrong-sig all revert on-chain. *Remaining adoption:* wiring the iOS/Mera front-end to emit the WebAuthn P-256 signature into this account (consumer payments still use the secp256k1 router today). |
| R2 | Monad P-256 verification works on the intended env | `VERIFIED` | `scripts/verify/p256-roundtrip.mjs`: a FRESH secp256r1 keypair signs a fresh message → RIP-7212 precompile `0x0100` returns `1`; a tampered digest is rejected (negative control). Repeatable. |
| R3 | Auth binds recipient/amount/token/nonce/expiry/resolution ref | `VERIFIED` | `PrismPaymentRouter.t.sol` (settle verifies the EIP-712 envelope: paymentId, payer, recipient, amount, requestId, resolutionHash, validBefore, nonce). |
| R4 | Mutate amount after auth → fail | `VERIFIED` | `testModifiedAmountRejected`. |
| R5 | Mutate recipient after auth → fail | `VERIFIED` | `testModifiedRecipientRejected`. |
| R6 | Replay → fail | `VERIFIED` | `testReplayRejected`; `mutation-audit` MUT-08. |
| R7 | Sender may hold zero MON (sponsored) | `VERIFIED` | live tx `0xd34d…34a16` (status `0x1`). |
| R8 | UI-terminal only from confirmed/reconciled state | `VERIFIED` | `mutation-audit` MUT-15 (reverted → failed, never completed). |
| R9 | Backend writes no authoritative balance | `VERIFIED` | `balance-authority.test.js` (no ledger key; balance tracks chain). |
| R10 | Failed/ambiguous → no blind double submit | `VERIFIED` | `mutation-audit` MUT-16. |

Live settlement of the slice: direct payment tx `0xfc27…c41f19` (status `0x1`).

| CHAIN-7 | Device P-256 → Prism **smart account** → gas-sponsored USDC payment, live on Monad | `VERIFIED` | `PrismP256Account` deployed `0x44c18e07…00cd` (1792 B code); pay `0xdea2…8a88` (P-256 verified on-chain, recipient +1.00 USDC, account MON = 0). Contracts suite 43 → 49. |
| CHAIN-8 | **Adoption** path end to end via the real backend service + iOS credential (device P-256 → account → gas-sponsored, on Monad) | `VERIFIED` | `P256AccountService` (deploy→prepare→submit→status) + iOS `DeviceP256Credential`. Backend `p256-account.test.js` 4/4 (real software P-256 sig verified over the prepared intent) + iOS `DeviceP256CredentialTests` 3/3. LIVE: deployed `0x1fb44696…81c2`, device-P256-authorized pay `0x63e79bb91fbf729497dd9abae64104ecb308d55d96bd94497082c62ac7dd1818` (status `0x1`), recipient +1.00 USDC, account MON = 0. |

## Continuity domain model (2026-09-09)

Implemented the PRISM Continuity domain model across backend + iOS (`continuity.js` /
`PrismContinuity.swift`) with the five semantic states and mirrored, deterministic tests.

| ID | Claim | Status | Evidence |
|---|---|---|---|
| CONT-5 | The classifier resolves all five states (FIRST_CONTACT / CONTINUITY_MATCH / IDENTITY_DISCONTINUITY / STALE_RESOLUTION / RESOLVER_UNAVAILABLE_OR_AMBIGUOUS) over the 10 scenarios | `VERIFIED` | backend `continuity.test.js` 13/13; iOS `PrismContinuityTests` 13/13 (mirrored) |
| CONT-6 | Same-identity account rotation (advancing version) is continuity, not a different human; account change without a version advance fails closed | `VERIFIED` | `continuity.test.js` + `IdentityContinuityTests.testAuthenticatedAccountRotationSameIdentityDoesNotWarn` / `testAccountChangeWithoutVersionAdvanceIsReviewed` |
| CONT-7 | Red-before-green: the discontinuity verifier actually fails against deliberately incorrect behavior | `VERIFIED` | broke `classifyContinuity` (different identity → CONTINUITY_MATCH) → `continuity.test.js` "IDENTITY_DISCONTINUITY" **failed** (1 fail); restored → **13/13 pass** |
| CONT-8 | Enforcement uses the model (no drift): `assertResolution` delegates to `assertFreshResolution` | `VERIFIED` | full backend suite 146/146 after the refactor (behavior-preserving; `security-boundaries` rotation tests still green) |

> These counts supersede the older `31 / 41 / 2` figures still printed in `README.md` (see
> [`FAILURES.md`](FAILURES.md) F-3 — stale README proof table).

## Continuity claims

| ID | Claim | Status | Evidence |
|---|---|---|---|
| CONT-1 | Legitimate alias change bumps `aliasVersion`, keeps account | `VERIFIED` | `security-boundaries.test.js` |
| CONT-2 | Stale resolution invalidated after rotation | `VERIFIED` | `security-boundaries.test.js`; `assertResolution` 409 |
| CONT-3 | Different-identity alias visibly blocked/reviewed (not redirected) | `VERIFIED` | server 409 (`assertResolution`) + iOS `IdentityContinuityTests` (warns on changed prismId/account; silent on alias-only change) |
| CONT-4 | End-to-end narrative: pay → rotate (same account) → pay again succeeds → number reassigned → blocked, never redirected | `VERIFIED` | backend `continuity-narrative.test.js` (real resolve→prepare→sign→submit→reconcile; two completed payments to Bob + two stale-resolution rejections) |

## PRISM Continuity Lab (2026-09-10) — `backend/src/lab/continuityLab.js`, `GET /v1/lab/continuity`

A safe, deterministic, **fixtures-only** comparison harness that makes the continuity invariant
judge-visible. It runs two paths over identical fixture identities — BASELINE (`alias → account`,
last-write-wins) and PRISM (`alias → PrismIdentity → active account`) — and shows the delta after a
legitimate alias reassignment to a **different** human, then four attacks. The detectors are the real
product's own code (`classifyContinuity`; `paymentEnvelopeTypedData` + `verifyTypedData`) — **not** a
toy that returns the desired answer. It takes no store and creates no payment state. iOS surfaces it in
Developer → Continuity Lab (`ContinuityLabView`).

| ID | Claim | Status | Evidence |
|---|---|---|---|
| LAB-1 | Baseline would silently route the reassigned alias to the new human (W2); PRISM detects P1≠P2 and BLOCKS with IDENTITY_DISCONTINUITY | `VERIFIED` | `continuity-lab.test.js` "PRISM blocks the reassigned-alias send…" (baseline `resolvesTo == W2`, `routesToDifferentHuman`; PRISM `IDENTITY_DISCONTINUITY`, `blocked`) — 5/5 |
| LAB-2 | Four attacks (stale-resolution, amount-mutation, recipient-mutation, replay) each state EXPECTED/OBSERVED/PASS/evidence and are rejected by production verifiers | `VERIFIED` | `continuity-lab.test.js` "all four attacks are rejected…"; stale→`STALE_RESOLUTION` via `classifyContinuity`; amount/recipient/replay→`verifyTypedData=false` (nonce/amount/recipient signature-bound); on-chain replay evidence R6/AUTH-2 |
| LAB-3 | Not a toy: each envelope attack gates PASS on the UNMUTATED envelope verifying first (red-before-green) | `VERIFIED` | neutralized the amount mutation (identity fn) → attack row `ACCEPTED (unexpected)`, 2 tests **failed**; restored → **5/5 pass** |
| LAB-4 | The Lab cannot accidentally generate production payment state | `VERIFIED` | `continuity-lab.test.js` "creates NO production payment state": a fresh `JsonStore` is byte-identical before/after; `operations`/`p256Ops` empty; report `fixtures:true`/`createsProductionState:false` |
| LAB-5 | Deterministic — two runs produce identical reports | `VERIFIED` | `continuity-lab.test.js` "deterministic — two runs produce identical reports" |

## Security / privacy / money-truth

| ID | Claim | Status | Evidence |
|---|---|---|---|
| PRIV-1 | No phone (raw/derived) in calldata/events/storage/proof/logs | `VERIFIED` | `PrismPrivacy.t.sol`, `phone-leak-audit.test.js`, `aurora-privacy.test.js` |
| AUTH-1 | Mutation after signing rejected (recipient/amount/route bound) | `VERIFIED` | `PrismPaymentRouter.t.sol`, `PrismRouterExternalRecipient.t.sol`, `mutation-audit.test.js` |
| AUTH-2 | Replay rejected (single-use nonce) | `VERIFIED` | `testReplayRejected`, `mutation-audit.test.js` MUT-08/16 |
| MONEY-1 | Submission ≠ completion; UI-terminal only after reconciled receipt | `VERIFIED` | `mutation-audit.test.js` MUT-15/16 |
| MONEY-2 | Backend not the canonical balance authority | `PARTIAL` | architectural; no explicit negative test |
| GAS-1 | Payer with MON = 0 can pay | `VERIFIED` | live: a fresh payer holding 2.00 USDC and **0 MON** paid 1.00 USDC; relayer paid gas; payer MON stayed 0. tx `0xd34de0a6ab02d6d470ef60a199a31dbeb2fb5cfb90d33fbd25fc8501a8034a16` (status `0x1`, block 60878354) |

## On-chain / live (NOT re-verified this phase — do not upgrade without a tx hash)

| ID | Claim | Status | Note |
|---|---|---|---|
| CHAIN-1 | Contracts deployed to Monad testnet | `VERIFIED` | live `eth_getCode` on `https://testnet-rpc.monad.xyz` (2026-09-08): router `0x423a…62b7` = 2990 B, vault `0xBe3D…Eae3` = 5905 B, USDC `0x534b…43A3` = 1798 B — all non-empty |
| CHAIN-2 | End-to-end **payment** on Monad (router `settle()` delivers USDC) | `VERIFIED` | live tx `0xfc277f341cb6db59389fcc21269decefc7708fccd979a7e5ae508b3754c41f19` — status `0x1`, block 60877492, `to` = router; payer −1.00 USDC, recipient +1.00 USDC. Re-verify: `eth_getTransactionReceipt` or `testnet.monadexplorer.com/tx/0xfc27…`. |
| CHAIN-5 | Live claim **fund → refund** cycle on Monad (escrow, then return to original sender) | `VERIFIED` | fund tx `0xd0d4b8dcf056cac78000dde6d2731d5c55c67c557cf4356dd87a44897c601f0f` (to = vault, +1.00 USDC into `PrismClaimVault`), refund-after-expiry tx `0x6828135e33e3facb5d2ccab2fdac56d8e10a2c31c2a882c6a679a3143dc1f51d` (to = vault); sender net USDC = 0 → funds returned to the original sender. Both status `0x1`. |
| CHAIN-6 | Live claim **collection** on Monad — dual signature (authorizer eligibility **and** recipient ClaimIntent) | `VERIFIED` | fund `0x8fd760c6fc4e60c3cf13b178f095a75e7f4f642ad3dd292acbadebaf897cdaf6`, collect `0x195a94f183ded17aa41f9c72f8dbbe3a8f15ac2a179a5b7c9747ccfe2c560d2c` (to = vault, block 60881242); recipient +1.00 USDC. The recipient received funds only because BOTH signatures were present — an alias/OTP alone cannot collect (INV-A1). |
| CHAIN-3 | Envio indexing real events | `UNTESTED` | needs a hosted indexer + a real event |
| CHAIN-4 | Zero-MON payment demonstrated on testnet | `UNTESTED` | requires a live gasless tx |

## UX

| ID | Claim | Status | Note |
|---|---|---|---|
| UX-1 | Cold user completes a normal payment without coaching (thesis #12) | `PARTIAL` | executed: `PrismUITests.testPhoneOnboardingReachesHome` — a cold launch drives the **real** Mera WKWebView bridge + live backend through choose-phone → OTP → **reaches Home** (passed 24.8s this session). Gap: it does not drive a full *payment*, and "without coaching" is a usability judgment no automated test certifies — that still needs an observed human run. Not `VERIFIED`. |

## How to add a row
State the exact command, run it, paste the pass/fail counts (or tx hash), then set the status. If a
prior claim's enforcement code changed, set it to `REGRESSED` until re-run.
