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
| GAS-1 | Payer with MON = 0 can pay | `PARTIAL` | `proof/ZERO_MON_PROOF.md` (local); not re-run on testnet this phase |

## On-chain / live (NOT re-verified this phase — do not upgrade without a tx hash)

| ID | Claim | Status | Note |
|---|---|---|---|
| CHAIN-1 | Contracts deployed to Monad testnet | `VERIFIED` | live `eth_getCode` on `https://testnet-rpc.monad.xyz` (2026-09-08): router `0x423a…62b7` = 2990 B, vault `0xBe3D…Eae3` = 5905 B, USDC `0x534b…43A3` = 1798 B — all non-empty |
| CHAIN-2 | End-to-end payment / claim / refund on Monad | `UNTESTED` (this phase) | prior-session tx hashes are **not authoritative** here; re-run and record the hash before marking `VERIFIED` |
| CHAIN-3 | Envio indexing real events | `UNTESTED` | needs a hosted indexer + a real event |
| CHAIN-4 | Zero-MON payment demonstrated on testnet | `UNTESTED` | requires a live gasless tx |

## UX

| ID | Claim | Status | Note |
|---|---|---|---|
| UX-1 | Cold user completes a normal payment without coaching (thesis #12) | `UNTESTED` | no usability evidence; needs an observed cold run / recording |

## How to add a row
State the exact command, run it, paste the pass/fail counts (or tx hash), then set the status. If a
prior claim's enforcement code changed, set it to `REGRESSED` until re-run.
