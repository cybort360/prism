# PROOF LEDGER

The single record of what is actually proven. A row is `VERIFIED` **only** with a command that was
executed and its result. `UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`. Never upgrade a row
because code exists.

## Suite runs (executed 2026-09-08, this session, on `main`)

| Suite | Command | Result | Status |
|---|---|---|---|
| Backend | `cd backend && node --test test/*.test.js` | 159 pass / 0 fail (148 + 4 p256-account + 2 device-key activity/reconcile + 5 continuity-lab) | `VERIFIED` |
| Contracts | `cd contracts && forge test` | 49 pass / 0 fail (43 + 6 PrismP256Account) | `VERIFIED` |
| iOS unit | `xcodebuild … -only-testing:PrismTests test` | 121 pass / 0 fail (112 + 6 continuity-UX + 3 error-sanitization) | `VERIFIED` |

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

## Continuity UX refinement (2026-09-10)

Refined the iOS experience around the continuity invariant: a serious two-step safety surface
(`IdentityChangeReviewView`), transparent legitimate-continuity handling, safe failure/pending/empty
states, and no chain-jargon leakage in the consumer flow. A **separate evaluator agent** reviewed the
design (hierarchy, credibility, clarity, warning comprehension, states, a11y, AI-slop); its high/most
findings were fixed and re-tested. iOS unit suite **121/121**.

| ID | Claim | Status | Evidence |
|---|---|---|---|
| UX-2 | Identity discontinuity → dedicated two-step safety surface; the FIRST screen offers only Review change / Cancel (no one-tap "send anyway") | `VERIFIED` (logic) | `ContinuityUXTests` (candidate factory carries state+previous, nil on first-contact/continuity) + build; the send-anyway button was removed from the warning screen (`IdentityChangeReviewView` step 1 has only Review change / Cancel). On-device visual not auto-tested. |
| UX-3 | The review screen shows human-readable continuity info; raw account/version only behind an opt-in "Technical details" disclosure | `VERIFIED` (logic) | `IdentityChangeReviewView` comparison uses a **collision-resistant** identity code (SHA-256 of the full prismId, not a truncatable suffix — evaluator finding #1 fixed) + a classifier-derived verdict; account address gated behind the disclosure. |
| UX-4 | Legitimate continuity (same identity, route change) is silent AND recorded as a transparent event; "trusted since" is preserved | `VERIFIED` | `ContinuityUXTests.testLegitimateRotationRecordsAContinuityEvent`, `testIdentityChangeIsNotRecordedAsContinuity`, `testTrustedSincePreservedAcrossRotation` |
| UX-5 | The consumer flow never surfaces MON/gas/relayer/RPC/0x/UserOp/EntryPoint; genuinely actionable errors pass through | `VERIFIED` | `PaymentErrorSanitizationTests` (9 leak cases incl. leading "MON…"/bare "gas" — evaluator finding #2 fixed; "money"/USDC-balance pass through) |
| UX-6 | Ambiguous settlement → truthful `.pendingReview` (not a red failure); routes to Activity; never a "nothing was sent" claim on a possibly-in-flight tx | `VERIFIED` (logic) | `PaymentCoordinator` poll timeout → `.pendingReview`; `OperationStateOverlay` renders it amber with "View in Activity"; sanitizer says "Check Activity before sending it again" (finding #2). Live timeout path not re-exercised. |
| UX-7 | Contacts-permission denial is never a dead end (inline @handle fallback + Settings link; no empty-state flash during load) | `VERIFIED` (logic) | `PersonPickerView` `contactsBlocked` fallback + loading gate (finding #8); @handle resolution path unchanged and covered by existing resolve tests. |
| UX-8 | Wrong PIN / Face-ID failure recovers | `VERIFIED` (logic) | `OperationStateOverlay` `.failed` now shows "Try again" → `coordinator.reset()` → retry; all four send surfaces wired. On-device biometric cancel not auto-tested. |

**Known gaps (not claimed VERIFIED):** (a) **Dynamic Type** — the app's `PrismTheme` uses fixed point
sizes throughout; the type system does not scale with accessibility text settings (evaluator finding
#3). App-wide; deferred to avoid destabilizing every layout. (b) **On-device sheet chaining** —
`trust and continue` dismisses one root sheet and presents a sibling (the pre-existing app pattern);
the classic SwiftUI dropped-presentation risk was flagged (finding #5) and not verified on a device.
(c) Amber-on-white small-label contrast was darkened to pass AA for the review labels (finding #6);
a full contrast/VoiceOver audit of the app was not done.

## Circle contributions and threshold-governed payments (2026-09-13)

Money now moves into and out of a Circle. Contributions reuse the existing Prism payment path
(PaymentEnvelope + ERC-3009 to the audited router + relayer); payments out are Safe transactions that
Prism can only propose. See `docs/CIRCLE_PAYMENTS.md`.

Commands run:

```
cd backend   && node --test test/*.test.js          # 269 pass / 0 fail
cd contracts && forge test --no-match-path 'test/circles/*'   # 51 pass / 0 fail (137s, incl. fuzz + invariants)
```

The Circle payment suite runs against a fake chain that implements Safe's real `execTransaction`
rules — it recomputes the digest from the arguments it is handed, recovers each signature, requires
strictly ascending owner order and current ownership, and enforces its own nonce — over a **single
USDC ledger shared with the payment router**. The digest, the CREATE2 address and the event topics
are derived independently in the harness from the type strings and the factory formula, so the suite
checks Prism's encoding rather than agreeing with it.

| ID | Claim | Status | Evidence |
|---|---|---|---|
| CP-1 | A contribution moves USDC from a personal Prism account to the Circle Safe, and the Circle's balance rises — read back from the token, never incremented | `VERIFIED` (harness) | `circles-payments.test.js`: *USDC moves from a personal Prism account into the Circle, and the balance rises* — balance 0 → $100, contributor $500 → $400 |
| CP-2 | Contributions reuse the existing payment infrastructure; no contribution vault | `VERIFIED` | *reuses the existing Prism payment path rather than a contribution vault* — op kind `circle-contribution`, ERC-3009 authorization addressed to the configured router |
| CP-3 | A contribution re-labelled after signing does not reconcile | `VERIFIED` | *a contribution re-labelled after signing does not reconcile* — `contributionHash` mismatch → FAILED |
| CP-4 | The payment recipient comes from the Protected Alias Resolver; the Safe transaction is `USDC.transfer` to the configured token, value 0, CALL, neutral gas refund | `VERIFIED` | *the recipient comes from the Protected Alias Resolver, and the Safe transaction is fixed in shape* |
| CP-5 | No caller can supply a target or calldata | `VERIFIED` (structural) | *no caller can supply a target or calldata* — `_intentToCall` rejects any intent but the four Circle intents |
| CP-6 | 1 of 2 cannot execute; 2 of 2 executes | `VERIFIED` | *1 of 2 cannot execute, 2 of 2 executes* — zero executions at 1 of 2; at 2 of 2 recipient +$40, Circle $500 → $460 |
| CP-7 | The threshold is read from the Safe, never inferred from Prism's rows | `VERIFIED` | *the required count comes from the Safe, never from a Prism row* — `requiredApprovals: 1` / `collectedApprovals: 99` / stored `threshold: 1` all ignored |
| CP-8 | A signature from a non-owner never counts, even written straight into the database | `VERIFIED` | *a signature from someone who is not an admin never counts* |
| CP-9 | An approval from an admin removed on-chain stops counting; APPROVED reverts to APPROVAL_PENDING | `VERIFIED` | *an approval from an admin removed on-chain stops counting…* |
| CP-10 | A duplicate approval is refused | `VERIFIED` | *approving twice is refused…* |
| CP-11 | Mutating any of recipient / amount / USDC target / Safe nonce / Safe / chain after approval invalidates it | `VERIFIED` | six tests, one per field: *changing {…} after approval invalidates it*; plus *the six bound fields are exactly the fields a Safe signature covers* |
| CP-12 | A Safe nonce already consumed cannot be replayed; a completed payment re-executes as a reconcile | `VERIFIED` | *a payment built against a nonce the Safe has already used cannot be replayed* (one execution, paid once) · *re-executing a completed payment reconciles instead of broadcasting again* |
| CP-12b | Two simultaneous sends produce exactly one broadcast | `VERIFIED` | *two simultaneous sends produce exactly one broadcast* — one `execTransaction`, paid once; the loser is told it is already being sent |
| CP-13 | A relayer that rewrites the transaction cannot redirect the funds | `VERIFIED` (harness) | *a relayer that rewrites the transaction cannot redirect the funds* — hostile relayer with two genuine approvals submits a $480 transfer to itself; the Safe answers `GS026` and the Circle is untouched |
| CP-14 | A failed simulation is never broadcast | `VERIFIED` | *a simulation that fails is never broadcast* — fully approved but underfunded; zero executions |
| CP-15 | COMPLETED is unreachable without chain evidence (receipt + Safe `ExecutionSuccess` + matching USDC `Transfer`) | `VERIFIED` | *a receipt with no USDC Transfer never becomes COMPLETED* · *a payment hand-marked COMPLETED in the database reads back as INVALIDATED* |
| CP-16 | Circle balance before/after reconciles: contributions in − payments out == `balanceOf(safe)` | `VERIFIED` | *contribute, propose, approve 2 of 2, execute, and the ledger reconciles* — $800 in, $480 out, $320 left, host holds $480 |
| CP-17 | A recipient whose identity changed after proposal blocks the payment (Prism Continuity, re-checked at approve AND at execute) | `VERIFIED` | *a recipient whose account changed without an authenticated rotation blocks the payment* |
| CP-18 | Circle send-before-signup: **DEFERRED**, with the reason asserted, not merely written | `VERIFIED` (audit) | `contracts/test/PrismClaimVaultCircleCompat.t.sol`, 4 tests: funding is `ecrecover`-only so a Safe cannot fund; approving the vault is inert (no pull path); refund would correctly return to a contract sender; no EIP-1271 funding variant exists. `docs/CIRCLE_PAYMENTS.md` §7 |

**Not claimed:** (a) **No live Circle Safe on Monad** — the payment suite runs against the in-memory
Safe above; the digest agreement with a real Safe v1.4.1 is the separately-recorded fork proof. The
same funded-key constraint as the rest of P2. (b) **iOS was not compiled for this change** — the
Circle screens, wire models, typed-data builder and `CircleApprovalWireTests` were written on Linux,
where no Swift toolchain is available. `make test-ios` needs macOS and has not been run; every iOS
claim here is `UNTESTED` until it has. (c) The Safe Transaction Service path is exercised only in its
absent (local-only) configuration.

## Circle member spending limits — the Allowance Module gate (2026-09-13)

Per-member spending limits are **built and tested but OFF**, because no Allowance Module >= v1.0.0
exists on Monad. `docs/CIRCLE_MODULE_SECURITY.md`, `docs/CIRCLE_SPENDING_LIMITS.md`.

Commands run:

```
cd tools/circles && node verify-allowance-module.mjs --chain-id 10143          # exit 1 (correct)
cd tools/circles && node verify-allowance-module.mjs --chain-id 10 --rpc https://mainnet.optimism.io \
      --module 0x691f59471Bfd2B7d639DCF74671a2d648ED1E331                       # exit 0 (correct)
cd contracts && forge test --match-path 'test/AllowanceModuleCompat.t.sol'      # 23 pass / 0 fail
cd contracts && forge test --no-match-path 'test/circles/*'                     # 74 pass / 0 fail
cd backend   && node --test test/*.test.js                                      # 291 pass / 0 fail
```

The contract suite runs against **Safe's actual deployed bytecode**: `canonical-runtime.hex` is the
runtime read off `0x691f59471Bfd2B7d639DCF74671a2d648ED1E331` (byte-identical on Optimism and
Gnosis) and `vm.etch`ed under test. Not a recompilation, not a mock.

| ID | Claim | Status | Evidence |
|---|---|---|---|
| AM-1 | An official Allowance Module release >= v1.0.0 exists: `allowances/v1.0.0`, non-draft, non-prerelease, published 2026-02-25, commit `c95f0390…` | `VERIFIED` | GitHub release index, queried live |
| AM-2 | v1.0.0 fixes a `uint16` allowance-nonce overflow that allowed past delegate transfers to be replayed | `VERIFIED` | upstream `CHANGELOG.md` (PR #520) + `testNonceExhaustionIsRefusedRatherThanWrapping` — the ceiling is enforced by the code under test |
| AM-3 | v1.0.0 is **not deployed on either Monad network**; v0.1.1 (vulnerable) **is** | `VERIFIED` | `eth_getCode` on 10143 and 143: `0x691f5947…` empty, `0xAA467248…` 14,909 bytes |
| AM-4 | The official deployments package (3.0.10, latest) has no v1.0.0 record, and its UNPINNED resolution returns the vulnerable v0.1.1 | `VERIFIED` | `getAllowanceModuleDeployment({})` → v0.1.1; `({version:'1.0.0'})` → undefined |
| AM-5 | v1.0.0 is deployed on Optimism and Gnosis, byte-identical, `VERSION() == "1.0.0"` — the canonical reference | `VERIFIED` | `eth_getCode` + `eth_call` on both; codeHash `0xfafc86ce…6657`, 15,504 bytes |
| AM-6 | The build-time gate PASSES where v1.0.0 really is | `VERIFIED` | gate CLI, Optimism: 7/7 checks pass |
| AM-7 | The build-time gate FAILS on Monad, and FAILS when pointed at v0.1.1 | `VERIFIED` | gate CLI: `FAIL address` / `FAIL bytecode` |
| AM-8 | Static config refuses limits against v0.1.x, in EVERY environment | `VERIFIED` | `circles-limits.test.js`: *an old Allowance Module version fails the build/integration gate* |
| AM-9 | The runtime gate identifies a module by CODE, not address; an impostor at the canonical address is refused | `VERIFIED` | *the runtime gate identifies the module by CODE, not by address* |
| AM-10 | **Execution model: COMPATIBLE** for Prism's shipping authority (Mera EOA) via relayed EIP-712, member holding MON = 0 | `VERIFIED` | `testRelayedEoaDelegateSignatureWorks` |
| AM-11 | **INCOMPATIBLE for a smart-account delegate, twice over:** v1.0.0 reverts on EIP-1271 contract signatures, and `PrismP256Account` exposes no generic execute | `VERIFIED` | `testEip1271ContractSignaturesAreRejectedOutright`, `testAPrismP256AccountCannotReachTheModule` |
| AM-12 | The msg.sender path DOES work for a contract that can make arbitrary calls — so the incompatibility is Prism's account shape, not the module's | `VERIFIED` | `testContractDelegateDirectCallWorks` |
| AM-13 | A delegate cannot make an arbitrary Safe call, change owners, enable a module, or grant an approval | `VERIFIED` | four tests + `testTheOnlyCallADelegateCanCauseIsAPlainTransfer` (to = USDC, value 0, Call, exactly 68 bytes) |
| AM-14 | Over limit / wrong token / removed delegate / signature reuse all fail | `VERIFIED` | `testSpendingOverTheLimitFails`, `testWrongTokenFails`, `testARemovedDelegateCannotSpend`, `testTheSameTransferSignatureCannotBeReused` |
| AM-15 | Changing a limit requires the Circle's admin threshold, and is Active only after a module readback | `VERIFIED` | *setting a limit needs the admin threshold, and is Active only after a chain readback* |
| AM-16 | Backend UI state alone cannot alter a limit; a member cannot raise their own | `VERIFIED` | *the backend cannot change a limit by itself*, *a member cannot raise their own limit* |
| AM-17 | Limit / spent / available all come from `getTokenAllowance`, never from Prism activity; the window resets on-chain | `VERIFIED` | *limit, spent and available all come from the module…*, *the window rolls over on-chain, with nothing from Prism* |
| AM-18 | Authorization re-reads the chain: a spend signed before the Circle cut the limit is refused, and a stale nonce cannot be replayed | `VERIFIED` | *a spend authorized before the Circle cut the limit is refused*, *a stale authorization cannot be replayed after the nonce moves* |
| AM-19 | Revoking is threshold-approved, zeroes the figures, and a stale session cannot preserve access | `VERIFIED` | *spending access ends on-chain, and a stale session cannot preserve it*, *a revoke is itself a threshold decision* |
| AM-20 | Over-limit is a fork: it names the limit and converts to an ordinary threshold proposal, which does not consume the member's allowance | `VERIFIED` | *the answer is a fork, not a dead end*, *choosing "request approval" produces an ordinary threshold payment* |
| AM-21 | Prism's transfer-hash implementation agrees with the deployed module | `VERIFIED` | `proof/circles/allowance-transfer-vectors.json`, written by the real module; *the backend computes the same transfer hash the deployed module does* |

**Not claimed:** (a) **Option A was not broadcast.** `DeployAllowanceModuleV1.s.sol` deploys Safe's
exact canonical runtime and is verified in simulation, but no module has been deployed to Monad —
that needs a funded key and is an operator decision. Limits therefore remain OFF. (b) **Our
recompilation of the tagged source does not reproduce upstream's bytecode** — identical 19-function
ABI, 48 bytes of dispatcher codegen difference, cause identified as Hardhat-vs-Foundry and recorded
rather than papered over in `vendor/safe-allowances-v1.0.0/PROVENANCE.md`. Nothing load-bearing
depends on it. (c) **No live allowance transfer on Monad**, for the same reason as (a). (d) **iOS
was not compiled** — no Swift toolchain on this machine; `make test-ios` needs macOS.

## How to add a row
State the exact command, run it, paste the pass/fail counts (or tx hash), then set the status. If a
prior claim's enforcement code changed, set it to `REGRESSED` until re-run.
