# Prism Circles — contributions and payments

> Where a Circle payment goes **after** it settles — its receipt, its place in the Circle's activity,
> its Payment Proof, and how a Circle is closed — is [CIRCLE_RECEIPTS.md](CIRCLE_RECEIPTS.md),
> [CIRCLE_PROOF.md](CIRCLE_PROOF.md) and [CIRCLE_LIFECYCLE.md](CIRCLE_LIFECYCLE.md).

How money gets into a Circle, and how it gets out.

Companion to [`CIRCLES_ARCHITECTURE.md`](CIRCLES_ARCHITECTURE.md) (what a Circle is) and
[`CIRCLES_AUTHORITY_MODEL.md`](CIRCLES_AUTHORITY_MODEL.md) (who may do what, and why it cannot be
forged). Every claim below names the test that establishes it.

**USDC only.** A Circle is denominated in one asset — mixing them would make "the Circle's balance"
ambiguous — and that asset is the officially configured USDC deployment for the chain. AUSD and
earnAUSD are a different product and appear nowhere in this path.

---

## 1. The shape of the thing

```
  CONTRIBUTION                                   PAYMENT
  ────────────                                   ───────

  personal PrismAccount                          Circle Safe
        │                                              │
        │  PaymentEnvelope + ERC-3009                  │  execTransaction, threshold signatures
        │  (the existing Prism router)                 │  (Safe v1.4.1)
        ▼                                              ▼
  PrismPaymentRouter ──── USDC ────▶ Circle Safe ──── USDC ────▶ resolved recipient
```

Money **in** reuses Prism's existing payment infrastructure whole. Money **out** is a Safe
transaction that Prism can only propose, never authorize.

The asymmetry is the point. Putting money into a shared account needs one person's consent — their
own. Taking it out needs the Circle's, and the Circle's consent is a threshold of owner signatures
on Monad, which Prism cannot manufacture.

---

## 2. Contributions — money in

A contribution is an **ordinary Prism payment whose recipient is the Circle's Safe**. There is no
contribution vault and no second settlement mechanism:

| Leg | What it uses |
|---|---|
| the signed intent | the same `PaymentEnvelope`, signed by the contributor's Mera account |
| the token authorization | the same ERC-3009 `ReceiveWithAuthorization`, addressed to the audited router |
| submission | the same MON-funded relayer — the contributor holds MON = 0 |
| reconciliation | the same receipt-driven lifecycle; `submitted` is never `completed` |

The only new thing is the **opaque hash slot**. On its own the envelope would bind "send $100 to
0xabc…", which says nothing about *why*. `contributionHash` folds the Circle id, its Safe, the
contributor and the amount into the same signature, so the contributor's one signature covers the
claim *"this is my contribution to this Circle"*. Reconciliation then holds the settled payment to
that claim rather than to a mutable row.

It is the third occupant of that slot, alongside `resolutionHash` (a direct payment) and `routeHash`
(a cross-chain send) — one settlement path, three meanings.

**The Circle's balance is never incremented by Prism.** It rises because a transfer landed, and the
number served to any caller is `USDC.balanceOf(safeAddress)`, read at the moment of asking. A
contribution records the balance either side of itself, both from the token contract, so "the Circle
went up by exactly this much" is an observation rather than an assertion.

### Flow

```
Lagos Trip → Add money → $100 → from your Prism balance
  → Face ID / PIN
  → Adding…  (signing)
  → Settling…  (relayed, awaiting the receipt)
  → Added
```

`PREPARED → SUBMITTED → CONFIRMING → COMPLETED`, with `FAILED` reachable from any of them.
`COMPLETED` requires three things, not one:

1. the underlying Prism payment reached `completed`, which only an on-chain receipt can do;
2. the settled envelope really paid **this** Circle's Safe;
3. the signed `contributionHash` still describes this contribution.

Check 3 is what makes a later edit to the stored row — a different Circle, a different amount —
surface as a contradiction instead of quietly re-labelling someone's money.
→ `circles-payments.test.js`: *a contribution re-labelled after signing does not reconcile*.

A `VIEWER` cannot contribute; a non-member cannot see that the Circle exists.

---

## 3. Payments — money out

### The recipient is resolved, not addressed

A Circle payment starts where every Prism payment starts: **the same Protected Alias Resolver**.
Contacts, `@handle`, QR and payment links all work exactly as they do for a personal payment, and the
resolver returns the same signed attestation.

This is not code reuse for its own sake. It means a Circle payment inherits **Prism Continuity**
whole: a contact whose alias now resolves to a *different* `PrismIdentity` is blocked and reviewed,
never silently redirected. And because approvals are collected over hours rather than seconds, that
check is re-run **before every signature and again before execution** — not only at proposal time.
→ *a recipient whose account changed without an authenticated rotation blocks the payment*.

### The transaction Prism is allowed to build

```
to        = the officially configured USDC contract   (config.chain.usdc)
value     = 0
data      = USDC.transfer(resolvedRecipient, amount)
operation = CALL
safeTxGas = baseGas = gasPrice = 0
gasToken  = refundReceiver = address(0)
```

**No caller supplies a target or calldata.** Not the app, not an admin, not a backend route. The
whole of Circles has exactly one function that turns an intent into a Safe call —
`SafeCircleAdapter._intentToCall` — and its `PAYMENT` branch is hardcoded to the configured token.
There is no request shape that reaches `execTransaction` with an arbitrary destination.
→ *no caller can supply a target or calldata*, *the recipient comes from the Protected Alias
Resolver, and the Safe transaction is fixed in shape*.

Two fields deserve their own sentence, because both are quiet:

- **`operation` is always `CALL`.** `safeTransaction()` throws rather than constructing a
  delegatecall, so there is no code path that produces one to be reviewed carefully.
- **The gas-refund fields are always zero.** A non-zero `gasPrice` makes the Safe reimburse
  `refundReceiver` out of Circle funds — a second, unreviewed payment hidden inside the first.

### The lifecycle

```
CREATED → RESOLVING → RESOLVED → PROPOSED → APPROVAL_PENDING → APPROVED
        → SUBMITTED → CONFIRMING → CONFIRMED → RECONCILED → COMPLETED
```

Each state is a claim that has been established, not ceremony:

| State | What is now true |
|---|---|
| `CREATED` | the request is well-formed and the proposer may spend from this Circle |
| `RESOLVING` | the recipient is being resolved through the Protected Alias Resolver |
| `RESOLVED` | a signed resolver attestation names a `PrismIdentity` and its account |
| `PROPOSED` | the exact Safe transaction exists, and its digest agrees with the deployed Safe's own |
| `APPROVAL_PENDING` | fewer verified owner signatures than the Safe's **live** threshold |
| `APPROVED` | enough verified signatures from **current** owners over this exact digest |
| `SUBMITTED` | `execTransaction` was simulated, and then broadcast |
| `CONFIRMING` | awaiting a receipt |
| `CONFIRMED` | the receipt succeeded **and** the Safe emitted `ExecutionSuccess` for this digest |
| `RECONCILED` | a USDC `Transfer` log proves Safe → reviewed recipient, for the exact amount |
| `COMPLETED` | terminal; the money moved and Prism holds the evidence |

Off the path: `INVALIDATED` (a signed field changed), `EXPIRED` (the nonce was consumed elsewhere),
`CANCELLED`, `FAILED` (broadcast, and the chain said no).

`ALLOWED_CIRCLE_PAYMENT_TRANSITIONS` gives `COMPLETED` exactly one inbound edge — from `RECONCILED` —
and gives `RECONCILED` exactly one, from `CONFIRMED`. A backend that wants to call a payment done
must first hold a receipt *and* a matching `Transfer` log, because those are the only two functions
that take those edges.

**`APPROVAL_PENDING ↔ APPROVED` is the only pair that moves both ways**, because approval is not a
stored fact. It is recomputed on every read from signatures verified against the live owner set, so
an admin removed on-chain drops an `APPROVED` payment back to `APPROVAL_PENDING` with nobody telling
Prism anything. → *an approval from an admin removed on-chain stops counting, and the payment
un-approves itself*.

### Approval on the phone

Before Face ID is ever presented, iOS validates the complete `CircleApprovalPayload` against what it
independently knows about the Circle — `ios/Prism/Core/Circles/CircleApprovalPayload.swift`. It
checks the Circle, the Safe, the chain, the nonce, that the target is *this Circle's* USDC, that the
operation is a call, that the value is zero, that the gas-refund fields are neutral, that the
calldata decodes to exactly `transfer(reviewedRecipient, reviewedAmount)` in exactly 68 bytes — and
then **recomputes the Safe digest from the displayed fields** and refuses to sign if it disagrees
with the one the backend sent.

That last check is what makes the others load-bearing. The threat it closes is narrow and concrete: a
compromised backend rendering "Pay Tobi $40" while handing the Secure Enclave a digest for "pay the
attacker $9,000".

The phone then signs with the admin's existing Mera passkey-derived secp256k1 key — an ordinary Safe
owner producing an ordinary ECDSA signature. No new credential, no per-admin contract, no EIP-1271
on the shipping path (see `CIRCLES_AUTHORITY_MODEL.md` §2).

---

## 4. Execution: seven checks, then a broadcast

`CircleService.executePayment` is where the whole design either holds or doesn't, so it is worth
reading as a sequence:

1. **the binding still holds** — nothing was edited after approval (§5);
2. **the recipient is still the same person** — Prism Continuity, re-run;
3. **owners, threshold and nonce are read LIVE from Monad** — never inferred from Prism's rows, and
   an unreadable chain is a refusal, not a reason to fall back on memory;
4. **every stored approval is re-verified** as a signature from a *current* owner over *this* digest;
5. **the count meets the live threshold**;
6. **the proposal's nonce is the Safe's next nonce** — a consumed nonce is a replay, not a payment;
7. **`execTransaction` is SIMULATED.**

Only after all seven is anything broadcast.

Step 7 carries more weight than it looks. Safe re-derives the digest and re-checks every signature
against its own live owner set *inside* `execTransaction`. So a successful simulation is the **Safe
itself** confirming — at this block, with these owners, at this nonce — that the approvals Prism
collected really do authorize this transaction. It is not Prism checking its own work.

**If the simulation fails, nothing is broadcast.** The reason is recorded and returned, and the
payment stays exactly where it was; it is never sent "to see what happens".
→ *a simulation that fails is never broadcast*.

### The relayer is a courier

The relayer pays MON and holds no authority. Every field it submits is covered by the owners'
signatures, so rewriting the recipient, the token, the amount or the nonce on the way out does not
redirect the money — it produces a digest the signatures do not authorize, and the Safe reverts.

This is tested against a Safe that actually checks signatures: the harness's fake recomputes the
digest from the arguments it is handed, recovers each signature, requires strictly ascending owner
order and current ownership, and enforces its own nonce.
→ *a relayer that rewrites the transaction cannot redirect the funds* — a hostile relayer holding two
genuine approvals submits a $480 transfer to itself and gets `GS026`, with the Circle untouched.

### One broadcast, even under a double tap

Two simultaneous sends would otherwise both pass every check above and both broadcast. The Safe would
reject the second — its nonce is consumed — so the money is never at risk, but an atomic reservation
turns a wasted revert into a reconcile. `JsonStore.mutate` is synchronous, so the check and the write
happen with no `await` between them, the same discipline the idempotency layer uses.
→ *two simultaneous sends produce exactly one broadcast*.

---

## 5. Mutation security

Changing any of these after approval must void the approvals:

```
recipient · amount · USDC target · Safe nonce · Safe · chain
```

They already are void, **cryptographically**: all six are inside the Safe EIP-712 digest (the Safe
address and chain id in the domain separator, the nonce and `keccak256(calldata)` in the struct
hash), so changing one produces a different digest and every collected signature stops verifying.
Safe would simply refuse to execute.

What Prism adds is making that failure **visible before anyone is asked to sign again**, and before a
relayer burns gas discovering it. `_paymentBinding` rebuilds the digest from the stored fields and
compares it with the digest the approvals were collected against. A row edited after approval
therefore reads as a contradiction — `INVALIDATED`, with the specific reason — rather than as a
payment still waiting to go out.

`APPROVAL_BOUND_FIELDS` is that list as code, asserted by
→ *the six bound fields are exactly the fields a Safe signature covers*,
with one test per field:
→ *changing {recipient, amount, the USDC target, the Safe nonce, the Safe, the chain} after approval
invalidates it*.

### Threshold is never inferred from Prism's rows

Rewriting `requiredApprovals: 1`, `collectedApprovals: 99` and the Circle's stored `threshold` in
Prism's own database changes nothing: the API still reports 1 of 2, and execution is still refused.
→ *the required count comes from the Safe, never from a Prism row*.

The same holds for a forged approval. A perfectly valid signature from a non-owner, written straight
into the approvals table, does not count — approvals are re-verified against the live owner set on
every read. → *a signature from someone who is not an admin never counts*.

One approval per authority: a second is refused (`409`), and could never have raised the count
anyway, since Safe counts an owner once however many signatures it is handed.
→ *approving twice is refused*.

---

## 6. Reconciliation: what "COMPLETED" costs

After a broadcast, three separate facts must line up before a payment is COMPLETED:

| # | Fact | Why it is not implied by the others |
|---|---|---|
| 1 | the transaction succeeded | otherwise nothing happened at all |
| 2 | the Safe emitted `ExecutionSuccess` for **this** `safeTxHash` | Safe catches a failing inner call and emits `ExecutionFailure` while the **outer** receipt still says `success` — so (1) does not imply this |
| 3 | the configured USDC emitted `Transfer`, **from** this Safe, **to** the reviewed recipient, for the **exact** amount | the only evidence that money moved, and the only one tied to who was actually paid |

Fact 3 is filtered by `log.address`: any contract may emit a log with the `Transfer` topic, so "a
Transfer happened" means nothing until it is "a Transfer emitted by the USDC we configured".

Anything less is a `FAILED` with a reason attached, never rounded up.
→ *a receipt with no USDC Transfer never becomes COMPLETED* — the receipt succeeds, the Safe reports
`ExecutionSuccess`, the `Transfer` log is removed, and the payment fails with
*"no USDC Transfer from this Circle to the reviewed recipient for the exact amount"*.

And the blunter forgery: a payment hand-marked `COMPLETED` in the database, with an invented
transaction hash, **reads back as `INVALIDATED`** — `reconcilePayment` is the only writer of
`evidence`, and it writes it only from a receipt carrying both facts above. What the row claimed
stays visible as `storedLifecycle`, so the tampering is legible rather than merely corrected.
→ *a payment hand-marked COMPLETED in the database reads back as INVALIDATED*.

This is the same rule as `circle.activation` for Circle creation: a state that can only be earned
from a chain read is demoted, not trusted, when its receipt is missing.

### Balance reconciles

A payment records the Circle's USDC balance either side of itself, both read from the token
contract, and end to end the arithmetic is checked against the Circle's own balance:

```
contributions in − payments out == USDC.balanceOf(safeAddress)
```

→ *contribute, propose, approve 2 of 2, execute, and the ledger reconciles* — $500 + $300 in, $480
out, $320 left, and the Airbnb host holds $480.

---

## 7. Claim compatibility — **DEFERRED**

**Question.** Can a Circle pay someone who has not joined Prism yet, using the existing
`PrismClaimVault`, with expiry refunds returning to the Circle Safe?

**Answer: DEFERRED.** Not "not yet built" — *not possible against the deployed vault without
changing it*, which the brief rightly forbids.

Three findings, each asserted in `contracts/test/PrismClaimVaultCircleCompat.t.sol` rather than only
written down, so a future change to either contract has to confront them:

1. **Funding is `ecrecover`-only.** `fundClaim` — the only way USDC enters the vault — authorizes
   through ERC-3009 `receiveWithAuthorization(sender, …, uint8 v, bytes32 r, bytes32 s)`. That is an
   EOA signature. A Safe has no private key, and no `v, r, s` recovers to a contract address. The
   vault's interface has no `bytes`-signature overload, so an EIP-1271 approval from the Safe has
   nowhere to go — even on a USDC deployment that would honour one.
   → *a Safe cannot fund a claim because funding is ecrecover-only*.

2. **There is no allowance path.** The "Safe multisend: `approve(ClaimVault)` + `createClaim`" shape
   named in the brief has no function to call: the vault never invokes `transferFrom`, so granting it
   an allowance is inert. With `type(uint256).max` approved, funding still fails for reason 1.
   → *approving the vault does nothing because there is no pull path*.

3. **The refund leg is not the blocker.** `refund` pays `claim.sender` unconditionally and
   permissionlessly — a stranger may trigger it and cannot benefit from it — so if a Safe could ever
   be the sender, an expired claim would return to the Circle exactly as required.
   → *refund would return to a contract sender and cannot be redirected*.

**What SUPPORTED would require.** A new entry point on a deployed, audited vault: either a
`fundClaim` variant taking a `bytes` signature routed to a USDC deployment that verifies EIP-1271
inside ERC-3009, or a pull-based `createClaim` after `approve`. Both widen the vault's trusted
surface for one caller's benefit, and both need a re-audit and a redeploy. That is precisely the
"do not weaken ClaimVault for Circles" line, so it is recorded as a decision rather than taken.

**What a Circle can do today.** Pay any recipient who *is* a Prism identity — which includes someone
who joined moments ago — through the ordinary threshold path above. Sending to a phone number that
has never seen Prism is the one thing that stays personal-account-only.

---

## 8. API

All routes require a session. Membership is the read boundary: a non-member gets `404`, not `403`.
**No route accepts a Safe address, a target, or calldata.**

| Route | Purpose |
|---|---|
| `POST /v1/circles/:id/contributions/prepare` | build the signable envelope for adding money |
| `POST /v1/circles/:id/contributions/:cid/submit` | relay the signed contribution |
| `GET /v1/circles/:id/contributions` | contributions to this Circle |
| `GET /v1/circles/:id/contributions/:cid` | reconcile one contribution from chain truth |
| `POST /v1/circles/:id/payments/propose` | resolve a recipient and build the Safe transaction |
| `GET /v1/circles/:id/payments` | payments on this Circle |
| `GET /v1/circles/:id/payments/:pid` | one payment, approvals re-counted from signatures |
| `POST /v1/circles/:id/payments/:pid/approve` | record one admin's signature over the digest |
| `POST /v1/circles/:id/payments/:pid/execute` | check, simulate, and broadcast if it will succeed |
| `GET /v1/circles/:id/pending` | the admin's approval inbox |

Roles: `ADMIN`, `SPENDER` and `CONTRIBUTOR` may contribute and propose; `VIEWER` may do neither.
Only an `ADMIN` who is a **current Safe owner** can approve, and only an admin or the proposer can
trigger execution — which grants nothing the signatures had not already authorized.

---

## 9. Tests

```
make test-backend    # includes backend/test/circles-payments.test.js  (27 tests)
make test-contracts  # includes contracts/test/PrismClaimVaultCircleCompat.t.sol  (4 tests)
```

The fake chain in `backend/test/circles-harness.js` is what makes the payment suite worth reading. It
implements Safe's real `execTransaction` rules — recomputing the digest from the arguments it is
handed, recovering every signature, requiring ascending owner order and current ownership, enforcing
its own nonce — over a **single USDC ledger shared with the payment router**. So a contribution
really moves a balance the Circle then reads back, and "1 of 2 cannot execute" is a refusal by a
Safe rather than by a Prism `if`.

The digest, the CREATE2 address and the event topics are all derived independently inside the
harness, from the type strings and the factory formula, so a mistake in `safeEncoding.js` shows up as
a Safe that rejects the signatures or deploys somewhere else — the suite checks Prism's encoding
rather than agreeing with it.

| Requirement | Test |
|---|---|
| contribute USDC, Circle balance increases | *USDC moves from a personal Prism account into the Circle, and the balance rises* |
| threshold proposal | *the recipient comes from the Protected Alias Resolver, and the Safe transaction is fixed in shape* |
| 1 of 2 cannot execute · 2 of 2 executes | *1 of 2 cannot execute, 2 of 2 executes* |
| wrong signer rejected | *a signature from someone who is not an admin never counts* |
| removed admin rejected | *an approval from an admin removed on-chain stops counting…* |
| duplicate approval rejected | *approving twice is refused…* |
| recipient mutation rejected | *changing recipient after approval invalidates it* |
| amount mutation rejected | *changing amount after approval invalidates it* |
| wrong token rejected | *changing the USDC target after approval invalidates it* |
| wrong Safe rejected | *changing the Safe after approval invalidates it* |
| Safe nonce replay rejected | *a payment built against a nonce the Safe has already used cannot be replayed* |
| relayer cannot redirect funds | *a relayer that rewrites the transaction cannot redirect the funds* |
| backend cannot mark complete without chain evidence | *a receipt with no USDC Transfer never becomes COMPLETED* · *a payment hand-marked COMPLETED in the database reads back as INVALIDATED* |
| Circle balance before/after reconciles | *contribute, propose, approve 2 of 2, execute, and the ledger reconciles* |
| one broadcast under concurrency | *two simultaneous sends produce exactly one broadcast* |
| claim compatibility audited | `PrismClaimVaultCircleCompat.t.sol` (4 tests) |

---

## 10. What is deliberately not here

- **Send-before-signup from a Circle.** §7 — DEFERRED, with the contract change it would need named.
- **Spending limits.** Still off. Safe's Allowance Module v1.0.0 is deployed on no chain, and the
  only module on Monad is the pre-fix v0.1.1. A `SPENDER` can propose and nothing more.
- **Batching / multisend.** One payment, one Safe transaction. Circles builds no `MultiSend`
  delegatecall, because the only way to delegatecall safely is to not.
- **A live Circle Safe on Monad.** Everything here runs against the faithful in-memory Safe above and
  against digests taken from a real Safe on a testnet *fork*. No Circle Safe has been broadcast to
  live Monad — the same funded-key constraint recorded throughout `proof/`.
