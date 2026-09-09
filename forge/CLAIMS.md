# CLAIMS

Every externally-meaningful claim PRISM makes, with a status from
`UNTESTED · PARTIAL · FAILED · VERIFIED · REGRESSED`. This is the human-readable index; the executed
evidence lives in [`PROOF_LEDGER.md`](PROOF_LEDGER.md). **Do not mark `VERIFIED` without a run.**

## Product claims

| ID | Claim | Status |
|---|---|---|
| C-PAY | You can pay a person (Contacts/@handle/QR/link) without seeing a wallet address | `PARTIAL` (flows built + unit-tested; no cold-user run) |
| C-GAS | You can pay while holding MON = 0 | `PARTIAL` (local proof; not re-run on testnet) |
| C-CLAIM | You can send to someone not yet on PRISM; they claim it; unclaimed funds return | `VERIFIED` — unit/contract **and** live on Monad: fund→collect (CHAIN-6) and fund→refund (CHAIN-5) |
| C-XCHAIN | Receive from / send to another chain (Aurora), in preview mode, honestly labelled | `PARTIAL` (tested against mock; live `/api/quote` never called) |

## Continuity claims (load-bearing)

| ID | Claim | Status |
|---|---|---|
| C-CONT-KEEP | A legitimate alias change to the same identity keeps payments working | `VERIFIED` (INV-C1) |
| C-CONT-STALE | A stale resolution can't be used after rotation | `VERIFIED` (INV-C2) |
| C-CONT-BLOCK | A different-identity alias is blocked/reviewed, never silently redirected | `VERIFIED` (server 409 + iOS `IdentityContinuityTests`) |

## Safety claims

| ID | Claim | Status |
|---|---|---|
| C-PRIV | No phone (raw or derived) on any public/on-chain/evidence surface | `VERIFIED` |
| C-AUTHZ | Reachability/OTP can't move money; only the passkey account can | `VERIFIED` (design + tests) |
| C-BIND | Mutation after authorization is rejected | `VERIFIED` |
| C-REPLAY | Replay is rejected | `VERIFIED` |
| C-TRUTH | Submission is never shown as completion | `VERIFIED` |
| C-LEDGER | Backend is not the canonical balance authority | `VERIFIED` (balance-authority.test.js) |
| C-SLICE | The vertical slice (resolution → continuity → auth → secp256k1 sig → router → gas-sponsored Monad → confirmed → receipt) works end to end | `VERIFIED` — `scripts/verify/vertical-slice.sh` 11 PASS / 0 FAIL + live txs |
| C-P256-ENV | Monad verifies P-256 on-chain (RIP-7212 precompile) — validates the archived smart-account path's viability | `VERIFIED` (fresh sign→verify round-trip + negative control) |
| C-P256-ACCOUNT | A device-P256 → smart account → gas-sponsored payment path exists and works live on Monad | `VERIFIED` — `PrismP256Account` deployed; P-256-authorized payment `0xdea2…8a88` |
| C-P256-CONSUMER | The **consumer app's** payments route through the P-256 smart account | `PARTIAL` — the full path (iOS device-P256 credential → backend service → account → Monad) is built, tested and proven live (CHAIN-8); the only remaining piece is a UI entry point in the app + running on real Secure Enclave hardware (Simulator uses a labeled software key). No new on-chain primitive needed. |

## Infra / live claims

| ID | Claim | Status |
|---|---|---|
| C-DEPLOY | Router + vault deployed on Monad testnet | `PARTIAL` (manifest present; not re-executed) |
| C-E2E | Real end-to-end payment/claim/refund on Monad | `UNTESTED` this phase |
| C-INDEX | Envio indexes real Monad events | `UNTESTED` |

## Explicitly NOT claimed
- No "phone → wallet address" registry, no `SHA(phone) → wallet` map.
- No custody; no backend balance ledger.
- No ERC-4337/P-256 smart account in the current build (archived) — see [`ARCHITECTURE.md`](ARCHITECTURE.md).
