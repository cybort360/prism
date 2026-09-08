# PROOF LEDGER

The single record of what is actually proven. A row is `VERIFIED` **only** with a command that was
executed and its result. `UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`. Never upgrade a row
because code exists.

## Suite runs (executed 2026-09-08, this session, on `main`)

| Suite | Command | Result | Status |
|---|---|---|---|
| Backend | `cd backend && node --test test/*.test.js` | 133 pass / 0 fail | `VERIFIED` |
| Contracts | `cd contracts && forge test` | 43 pass / 0 fail (incl. 3 invariants × 256 runs) | `VERIFIED` |
| iOS unit | `xcodebuild … -only-testing:PrismTests test` | 95 pass / 0 fail (89 + 6 continuity) | `VERIFIED` |

> These counts supersede the older `31 / 41 / 2` figures still printed in `README.md` (see
> [`FAILURES.md`](FAILURES.md) F-3 — stale README proof table).

## Continuity claims

| ID | Claim | Status | Evidence |
|---|---|---|---|
| CONT-1 | Legitimate alias change bumps `aliasVersion`, keeps account | `VERIFIED` | `security-boundaries.test.js` |
| CONT-2 | Stale resolution invalidated after rotation | `VERIFIED` | `security-boundaries.test.js`; `assertResolution` 409 |
| CONT-3 | Different-identity alias visibly blocked/reviewed (not redirected) | `VERIFIED` | server 409 (`assertResolution`) + iOS `IdentityContinuityTests` (warns on changed prismId/account; silent on alias-only change) |
| CONT-4 | End-to-end narrative: pay → rotate (same account) → pay again succeeds → number reassigned → blocked, never redirected | `VERIFIED` | backend `continuity-narrative.test.js` (real resolve→prepare→sign→submit→reconcile; two completed payments to Bob + two stale-resolution rejections) |

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
