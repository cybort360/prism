# Universal Payments Specification — the 5 Primitives + Atomic Cross-Chain Routing

Status: specification. Each section is marked **IMPLEMENTED** (code + tests in this build)
or **SPECIFIED** (intended behavior, not yet built). Nothing here claims an unbuilt component
exists. Ground rules: no Mini UI in this track; backend is never the balance authority (INV-M2);
reachability is never spending authority (INV-A1); submission is never completion (INV-M1).

Related sources of truth: `docs/PAYMENT_LIFECYCLE.md`, `docs/CLAIMS.md`, `docs/CIRCLE_LIFECYCLE.md`,
`docs/CIRCLE_SPENDING_LIMITS.md`, `docs/AURORA_INTENTS.md`, `docs/QR_AND_LINKS.md`,
`forge/INVARIANTS.md`, `forge/ARCHITECTURE.md`.

## Terms

- **PrismIdentity**: persistent `{ prismId, accountAddress, aliasVersion }`. Reachability routes
  (phone / @handle / QR / link) resolve to it; rotation bumps `aliasVersion` without changing identity.
- **Authority**: the device passkey-gated, Mera-derived secp256k1 account. P-256 smart-account path
  (`PrismP256Account`, RIP-7212 `0x0100`) is proven on Monad testnet; consumer payments route through
  the secp256k1 `PrismPaymentRouter` today.
- **Money truth**: Monad USDC state. Backend holds guarded state machines + append-only event log
  (`backend/src/lib/lifecycle.js`); Envio projects history; Alchemy provides live reads/receipts.

## 1. SEND (outbound push) — IMPLEMENTED

Initiator: payer. Settlement: gasless ERC-3009 via `PrismPaymentRouter.settle()` (relayer submits,
payer holds zero MON). Recipient, amount, route bound in the signed envelope (INV-A2); single-use
nonces, replay rejected on-chain (INV-A3).

Sub-flows:

- **Direct Prism-to-Prism**: resolve alias → signed, short-lived, requester-bound attestation
  (`resolverService`) → `paymentService` prepares EIP-712 envelope with `assertFreshResolution`
  (stale `aliasVersion` → 409, INV-C2; different identity → blocked for review, INV-C3) →
  payer signs → relayer broadcasts → receipt-confirmed → reconciled → completed.
- **QR / link send**: same pipeline; QR/link encodes an identity route (`prismId` / handle), never a
  raw address (`docs/QR_AND_LINKS.md`). URL `amount`/`ref` are prefill only and never enter the
  signed payload.
- **Claim send (recipient not on Prism)**: `PrismClaimVault` escrow — `fundClaim` (ERC-3009 pull),
  dual-signature `claim` (isolated authorizer eligibility + recipient `ClaimIntent`), permissionless
  `refund` to the original sender after expiry. Terminal states `claimed xor refunded`; boundary
  `now <= expiry` claims, `now > expiry` refunds. `fundingNonce` binds
  `(claimId, recipientReference, amount, sender, expiry)` so a relayer cannot repoint the funding
  (expiry-binding fix, `PrismClaimVault.t.sol::testFundingNonceBindsExpiry`).
- **Cross-chain send**: USDC on Monad → any token on any chain (see §6, Aurora).

State machine (IMPLEMENTED, `PAYMENT_LIFECYCLE.md` / `ALLOWED_TRANSITIONS`):

```
prepared → broadcasting → submitted → confirming → completed (terminal)
  ↘ failed / expired (terminal / refundable) ; requires_attention / reconciliation_required on
  ambiguous broadcast / provider disagreement — never blind re-submit (reconcile from chain first)
```

## 2. SPEND (Circle drawdown) — IMPLEMENTED (limits gated OFF)

Substrate: Gnosis Safe v1.4.1 + Safe Allowance Module v1.0.0. Safe contract is sole truth; backend
is a projection. Roles: ADMIN / SPENDER / CONTRIBUTOR / VIEWER.

- **Within pre-approved limit**: member signs the module's own EIP-712 transfer hash
  (per-delegate nonce, single-use); relayer submits. No admin re-approval. Authorization is against
  a fresh chain read at submit time (signature→Continuity→allowance re-read→simulation).
- **Gate status**: `CIRCLE_LIMITS_ENABLED=false` in this build — Allowance v1.0.0 is not deployed on
  either Monad network and the deployed v0.1.1 is vulnerable. Limit paths are built and tested
  (`circles-limits.test.js`, `AllowanceModuleCompat.t.sol`) and switch on when a verified v1.0.0
  exists. Anything limit-dependent below degrades to THRESHOLD while the gate is closed.
- **Over-limit → Graceful Overflow** (see §7): routed to an ordinary threshold `PAYMENT` proposal,
  never refused outright.

State machine (IMPLEMENTED, `CIRCLE_LIFECYCLE.md`):

```
limited spend:  CREATED → RESOLVING → LIMIT_CHECKED → AUTHORIZED → SUBMITTED → CONFIRMED → COMPLETED
threshold payment: CREATED → RESOLVING → RESOLVED → PROPOSED → APPROVAL_PENDING ⇄ APPROVED
  → SUBMITTED → CONFIRMING → CONFIRMED → RECONCILED → COMPLETED
```

## 3. RECEIVE / REQUEST (inbound pull) — IMPLEMENTED

Initiator: recipient. Two shapes:

- **Prism-native request** (`requestService`): `DRAFT → OPEN` (requester signs canonical request
  with Mera account) → payer pays the OPEN request (`assertPayable` checks payer, recipient, amount) →
  settles through the §1 pipeline. Requests expire (default 24h, max 30d).
- **Universal payment links**: public links payable without the payer holding a Prism account. The
  recipient declares the destination (see §6 for cross-chain arrival):
  - `PRIMARY`: recipient's Monad EOA (default).
  - `SAVINGS`: SPECIFIED — auto-deposit into savings on settlement. The Save backend exists (§4),
    but there is no `PrismSavingsVault` contract and no settlement→deposit wiring, so this
    destination is not executed; the dispatcher returns the position id plus an explicit
    "not yet deployed" note rather than pretending it settled.
  - `CIRCLE`: contribution credited to the Circle Safe (threshold/contribution path, IMPLEMENTED
    via Circle payments).
- **Cross-chain arrival** (IMPLEMENTED, `AURORA_INTENTS.md`): any token on any chain → Aurora
  persistent deposit address (derived from the recipient's own Mera account) → USDC on Monad at the
  recipient's account. Prism signs nothing inbound; arrival lands as a plain USDC `Transfer`
  attributed via the `UsdcTransfer` Envio entity. `GET /v1/aurora/arrivals` reports `indexed: false`
  (unknown) rather than "nothing arrived" when the index is unavailable.

## 4. SAVE / EARN (asset transformation) — PREVIEW (backend IMPLEMENTED, execution gated)

Nature: transformation, NOT a peer-to-peer payment. USDC → yield-bearing earnAUSD
(Agora / Upshift reserves). User abstraction: "$USDC earning X% APY"; mint/rebate/share mechanics
hidden. Non-custodial: shares held directly by the user's account; backend never holds custody.

- **Flexible**: no lockup, continuous accrual, instant redemption.
- **Fixed-term** (e.g. 90-day): higher fixed yield (Pendle PT-AUSD backing); contract-enforced
  lockup; early withdrawal reverts on-chain.

Status: the backend Save surface EXISTS — `saveService`, `domain/savePosition.js`, average-cost
accounting, a governed single-strategy registry (`lib/saveStrategy.js`, only the approved earnAUSD
strategy enabled — never a computed "best APY"), eligibility gating (`saveEligibilityService`:
ELIGIBLE / INELIGIBLE / UNKNOWN / SERVICE_UNAVAILABLE, no hardcoded countries), money-safe quotes,
and chain-reconstructed positions. It ships as an **ANNOUNCED PREVIEW**: no real deposit is produced
and no APY is invented. **No on-chain savings vault contract exists and the earnAUSD substrate is
not connected** — earnAUSD / AUSD live on Monad mainnet (143) while Prism runs on testnet (10143),
and the deposit / Teller ABI is not independently verified (see `docs/SAVE_DEPENDENCY_AUDIT.md`).
Real execution is **double-gated**: `save.substrateVerified === false` AND eligibility defaults to
`SERVICE_UNAVAILABLE` (no compliance provider wired). See `forge/SAVE_MATRIX.md` for the row-by-row
status. The state machine below is the contract execution must satisfy once the substrate connects:

```
SPECIFIED: DEPOSIT_PREPARED → DEPOSIT_SUBMITTED → EARNING → (REDEEM_REQUESTED → REDEEMED | matured)
fixed-term: EARNING → LOCKED (until maturity; early redeem reverts) → REDEEMED
```

Money-truth and privacy invariants apply unchanged: position value is reconstructed from on-chain
share pricing, never from a backend ledger; no phone-derived value in any savings surface.

## 5. CIRCLES (shared accounts) — IMPLEMENTED

Substrate: Gnosis Safe v1.4.1 (vendored, pinned). Truth: Safe + Allowance Module on Monad; backend
projects. Member authority machine, creation machine, and closing machine per
`CIRCLE_LIFECYCLE.md` §1/§4/§5.

- Contributions: no contribution vault, no second settlement mechanism — deposits are plain USDC
  transfers to the Safe, attributed by the indexer.
- Closing: `ACTIVE → CLOSING → CLOSED`; Prism never decides where a shared balance goes — the Circle
  must empty itself via threshold payments first; close requirements (`OPEN_PROPOSALS`,
  `SPENDING_ACCESS`, `REMAINING_FUNDS`, `CHAIN_RECONCILED`) are computed from live reads and a
  failed read blocks closing.

## 6. ATOMIC CROSS-CHAIN EXECUTION (Aurora Intents)

### 6a. IMPLEMENTED today (`docs/AURORA_INTENTS.md`)

- **Inbound** (any chain/token → USDC on Monad at the recipient's EOA): Aurora persistent deposit
  address; no Prism contract involved; no envelope; no signature.
- **Outbound** (USDC on Monad → any token/chain/address): `paymentService.prepareExternalSend`
  (no Prism identity on the far side) → Aurora quote → `depositAddress` on Monad →
  `PrismPaymentRouter.settle(recipient = depositAddress)` over the existing gasless path →
  Aurora converts and delivers. `routeHash` binds
  `{ routeId, depositAddress, destinationChain, destinationAssetId, destinationRecipient,
  minAmountOut, quoteDeadline }` in the envelope's opaque slot — a post-sign rewrite of destination,
  token, recipient, or minimum fails `ecrecover` and `settle()` reverts
  (`PrismRouterExternalRecipient.t.sol`). Quote deadline re-checked at submit; stale quotes refused,
  never silently re-quoted. Payment leg and route leg are separate records with separate machines
  (`ALLOWED_TRANSITIONS` vs `AURORA_TRANSITIONS`); a confirmed Monad tx is not delivery.
- **Mode honesty**: `AURORA_MODE=preview` (default) serves real dry quotes with unsettled labelling;
  live needs `AURORA_APP_KEY`; boot refuses production-live without a key. NEAR Intents carries Monad
  mainnet (143), not testnet (10143) — quoted routes cannot settle against the testnet deployment,
  and preview says so verbatim.

### 6b. SPECIFIED: atomic routing into terminal destinations

The task-brief novelty — payer on Ethereum/Base/Solana pays native asset → Aurora converts to USDC
on Monad → **atomically** lands in the beneficiary destination — is specified, with this build's
gap stated:

```
payer (any chain/asset) → Aurora deposit → USDC on Monad →
  ├─ PRIMARY → beneficiary EOA                      (IMPLEMENTED for inbound)
  ├─ SAVINGS → PrismSavingsVault.deposit(amount, beneficiary)   (SPECIFIED — no vault contract yet)
  └─ CIRCLE  → Circle Safe                          (SPECIFIED for atomic path; manual contribution path IMPLEMENTED)
atomicity: terminal deposit failure unwinds cross-chain; no stranded intermediate funds.
```

Blocker: this needs Aurora **Intents Connect** (destination-chain contract calls), whose API is
pre-release and email-gated — deliberately not integrated (no adapter, no stub). Until access,
delivery terminates at the beneficiary EOA and onward movement (savings deposit, Circle credit)
is a second, separately-authorized Prism step — never presented as atomic.

Security binding (SPECIFIED, extends §6a `routeHash`):

```
routeHash = H(sourceChain, sourceAsset, amount, destinationContract, beneficiaryId, expiry)
```

Bound in the signed authorization alongside recipient/amount/nonce (INV-A2); expiry enforced at
execution; failure of the terminal deposit reverts the whole intent.

## 7. GRACEFUL OVERFLOW + CONTEXTUAL THREAD

**Overflow routing — IMPLEMENTED** (`CIRCLE_SPENDING_LIMITS.md` §5): a spend above the member's
limit is a fork, not a dead end. `POST /v1/circles/:id/payments/preview` decides from live chain
state and returns the limit + `requiredApprovals`; choosing "Request approval" creates an ordinary
threshold `PAYMENT` proposal (the Circle's money, not the member's allowance). No-access, module-
unavailable, unreadable-chain, and limits-disabled all degrade to `THRESHOLD` with a reason —
never to a silent refusal.

**Contextual message thread — IMPLEMENTED** (`circleMessageService`): an overflow or threshold
proposal MAY carry a human-context thread (who needs what, why, by when). Constraints
(non-negotiable, all enforced):

- Context only. A message NEVER confers spending authority (INV-A1); approval is counted only from
  verified owner signatures over the exact Safe digest against the live owner set and threshold. The
  service holds no reference to any approval or execution path — it writes display text under a
  proposal id and nothing else; the backend MUST NOT treat message presence, authorship, or content
  as an approval signal.
- Access: only ACTIVE members of the Circle may read or post (else 403); a non-existent or
  non-payment proposal is 404. Text is length-capped and must be non-empty.
- Privacy: E.164-looking values in thread text or metadata are rejected with 400 (INV-P1).
- Endpoints: `POST` / `GET /v1/circles/:id/proposals/:proposalId/messages`.

## 8. SECURITY STANDARD

- **Authorization binding** (INV-A2/A3): recipient + amount + route in the signed envelope
  (ERC-3009 nonce + `resolutionHash` / `routeHash`); no in-flight mutation; single-use; replays
  rejected on-chain; ambiguous broadcast reconciles from chain before any retry (INV-A3).
- **Continuity** (INV-C1..C3): same identity + account with higher `aliasVersion` → no warning;
  stale attestation → 409; alias now resolving to a different identity → visibly blocked, never
  silently redirected. Enforced in resolver/identity/trust layers, above the account type.
- **Privacy** (INV-P1): no phone number (raw or plain hash) on any public, on-chain, or evidence
  surface. Phone encrypted at rest; index is private `HMAC(pepper, E.164)`; Aurora `sender` field
  is the EVM account address only. Pinned by `PrismPrivacy.t.sol`, `phone-leak-audit`, and
  `aurora-privacy.test.js` (each with a failing-scanner self-test).
- **Money truth** (INV-M1/M2): submission ≠ completion — terminal UI state only from confirmed
  on-chain receipt + reconciled effects; backend never the balance authority — balances are live
  token reads, backend holds state machines and projections.
- **Hardware/accounts** (INV-P256): RIP-7212 precompile `0x0100` verifies P-256 on Monad testnet;
  `PrismP256Account` path proven live; consumer settlement today is Mera secp256k1 EOA →
  `PrismPaymentRouter`.

## 9. BACKEND DISPATCHER FACADE — IMPLEMENTED

`backend/src/services/intentDispatcherService.js` exists: a prepare-only facade over the existing
tested services (circle, request, aurora, save), exposed at `POST /v1/intent/prepare` (plus the
Save alias `POST /v1/save/prepare`). It routes `SPEND / RECEIVE / CROSS_CHAIN / SAVE`:

- **SPEND** → `circleService.previewPayment` picks the route from live chain state: within limit →
  `prepareSpend` (member signs the module hash); over limit → Graceful Overflow `proposePayment`
  (the context message is display memo ONLY, §7).
- **RECEIVE** → `requestService.draft` with the destination recorded alongside the signed request;
  an omitted `payerPrismId` drafts a universal public request (§3).
- **CROSS_CHAIN** → `auroraService.quoteSend` (quote) / `prepareSend` (freeze into the routeHash-
  bound envelope, §6a); settlement stays inside aurora → payment.
- **SAVE** → `saveService.quote` (preview, writes nothing, §4); the position id references the
  user's own account.

It is strictly additive: **no store writes, no state transitions, no submissions, no balance
reads** — it returns only `prepared`-level artifacts from the delegates. It does not widen
`ALLOWED_TRANSITIONS`, never mints authority from memos/threads (INV-A1), and never presents a
Monad-leg confirmation as cross-chain delivery. Guardrails run before any delegation: INV-P1
rejects phone-looking values anywhere in the parameters or memo (recursively), and context messages
are length-capped and phone-scanned. Tests: `intent-dispatcher.test.js`.
