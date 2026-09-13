# Prism Circles — member spending limits

Letting one person spend from a shared account without asking, up to a point the Circle agreed.

Companion to [`CIRCLE_PAYMENTS.md`](CIRCLE_PAYMENTS.md) (how money moves) and
[`CIRCLE_MODULE_SECURITY.md`](CIRCLE_MODULE_SECURITY.md) (why the module is gated, and what was
proven about it). Every claim here names the test that establishes it.

> **Limits are OFF.** Safe's Allowance Module v1.0.0 — the release that fixed a delegate-transfer
> replay — is not deployed on either Monad network, and the only Allowance Module that *is* deployed
> there is the vulnerable v0.1.1. `CIRCLE_LIMITS_ENABLED=false`. Everything below is built, tested,
> and switches on the moment a verified v1.0.0 exists. See `CIRCLE_MODULE_SECURITY.md` §8.

**USDC only.** Not as a policy but as a shape: no method on this surface takes a token parameter.
The encoders read the token from configuration, so there is no request that can express an allowance
for anything else. → *only USDC — there is no token parameter anywhere on the limit surface*.

---

## 1. The idea

A Circle already has one way to spend: **enough admins agree**. A limit adds a second, narrower one:

> This member may spend up to **$100 a day** from the Circle, on their own.

That is a real transfer of authority, so it is granted the way authority is always granted in a
Circle — by the admin threshold, on Monad. What changes is only *who needs to agree for the next
$40*: nobody, because the Circle already agreed to the shape of it.

Underneath, the member is an **allowance delegate** on Safe's Allowance Module, and the delegate is
their **existing Prism authority address** — the same Mera passkey-derived account that holds their
personal USDC and, for an admin, owns the Circle's Safe. No new credential is minted for spending.
→ *the delegate is the member's EXISTING Prism authority address*.

```
Sarah    $100 per day
David    $500 total
Jayson   $250 per week
```

→ *Sarah $100/day, David $500 total, Jayson $250/week*.

`TOTAL` is a one-off budget: the module stores a reset window of zero, so it never refills, however
long you wait. → asserted in the same test, 400 days later.

---

## 2. Changing a limit is a Circle decision

There is no method in this codebase that writes an allowance. `prepare` builds the Safe transaction
the Circle's admins must approve; the module stores the result; and the number the app shows is read
back from the module.

```
Sarah
Current      $100/day
Change to    $200/day

  → proposal
  → admin approvals          (the Circle's live threshold, from Safe.getThreshold())
  → on-chain allowance update
  → confirmation             (readback: the module now says $200/day)
  → Active
```

**One approval short is not a limit change.** → *setting a limit needs the admin threshold, and is
Active only after a chain readback*.

**A member cannot raise their own limit.** A `SPENDER` is not an admin, and preparing a limit change
is not offered to them at all. → *a member cannot raise their own limit*.

**Backend UI state alone cannot alter a limit.** Rewriting every Prism row that mentions the limit
changes nothing the API reports, because none of those rows is where the number comes from.
→ *the backend cannot change a limit by itself*.

### Why it can take more than one proposal

Up to three Safe transactions stand between "no spending access" and an active limit:

| Step | Why it is separate |
|---|---|
| `MODULE_ENABLE` | once per Circle — installing a module on someone's Safe is their decision |
| `SPEND_DELEGATE_ADD` | once per member — the module refuses `setAllowance` for a delegate it does not know |
| `SPEND_LIMIT_SET` | the limit itself |

They cannot be batched. Batching would need a MultiSend **delegatecall**, and Circles refuses to
construct a delegatecall at all (`CIRCLE_PAYMENTS.md` §3). So `prepareSpendingLimit` returns the
**next** step and says how many remain; a step already satisfied on-chain is skipped, which makes
*changing* an existing limit a single proposal.

The steps are decided from chain state, not from Prism's records — a Circle that enabled the module
months ago starts at step 3.

### "Active" means a readback

A governance change reaches `COMPLETED` only when the module has been **read back** and says what
the Circle approved. A transaction that succeeded but left the allowance at a different number is a
failure, and without the readback it would look like success. A change recorded as applied without
one reads back as `INVALIDATED`.
→ *a governance change recorded as applied without a readback reads back as INVALIDATED*.

---

## 3. Allowance truth

```
Daily limit   $100.00
Spent today   $42.00
Available     $58.00
```

All three come from one call — `AllowanceModule.getTokenAllowance(safe, delegate, token)` — which
runs the module's own internal `getAllowance`. That matters: it is the **same function a transfer
uses**, and it applies the period reset on read. So the `spent` shown is exactly the figure the next
transfer will be checked against.

**Deriving "available" from Prism's activity would be wrong in two ordinary situations**, not exotic
ones: a period that rolled over since the last payment, and a transfer that happened without Prism
originating it. Both are normal. So the numbers are never summed from activity.

Deleting Prism's entire record of a member's spends does not change what the API reports.
→ *limit, spent and available all come from the module, not from Prism activity*.

The window rolls over on-chain with nothing from Prism: spend the full $100, wait a day, and $100 is
available again — no transaction, no job, no backend timer.
→ *the window rolls over on-chain, with nothing from Prism*.

---

## 4. Spending within a limit

The member signs the module's own EIP-712 transfer hash; a Prism relayer submits it. The member
holds **MON = 0**, exactly as for every other kind of Prism payment.

The recipient comes from the **same Protected Alias Resolver** as every other payment, so a spend
inside a limit inherits Prism Continuity whole — a contact who now resolves to a different
`PrismIdentity` is blocked and reviewed, never silently paid.

Prism computes the transfer hash locally **and cross-checks it against the deployed module's own
`generateTransferHash`** before handing it over to be signed — the same discipline the Safe digest
gets, for the same reason. It is also pinned offline against vectors the real module produced:
→ *the backend computes the same transfer hash the deployed module does*.

### Authorization is always against a fresh read

Between preparing a spend and submitting it, the Circle may have cut the limit. So `submitSpend`
re-reads the chain before authorizing anything, in this order:

1. the signature recovers to **the member's own** authority — → *someone else cannot authorize a
   spend against your limit*;
2. the recipient is still the same person (Continuity);
3. the allowance is **re-read from the module** — still configured, the nonce still matches, and the
   amount still fits;
4. the module is asked, by simulation, whether it would allow this.

Only then is anything broadcast.

**A spend signed under a $100 limit does not survive the Circle cutting it to $20.** Refused before
it reaches the chain. → *a spend authorized before the Circle cut the limit is refused*.

**Replay is closed twice.** The module's per-delegate nonce makes one signature good for exactly one
transfer, and Prism refuses a stale authorization before broadcasting rather than letting it revert.
Re-submitting a completed spend is idempotent — it reports what already happened rather than
spending again. → *a stale authorization cannot be replayed after the nonce moves*.

---

## 5. Over the limit: a fork, not a dead end

A member trying to spend $140 against a $100 daily limit is not doing anything wrong. They are doing
something that needs the Circle's agreement instead of their own, and the honest answer says so and
offers the way forward:

```
This is above your $100.00 daily limit.

Request approval from the Circle?

[ Request approval ]
```

`POST /v1/circles/:id/payments/preview` decides the route from live chain state and returns the limit
alongside it, so the sheet can show the numbers it is talking about — and `requiredApprovals`, so it
can say how many admins would have to agree.

Choosing **Request approval** turns the intent into an ordinary threshold `PAYMENT` proposal: the
same path a Circle with no limits uses at all. → *choosing "request approval" produces an ordinary
threshold payment*.

A threshold payment does **not** come out of the member's allowance — it is the Circle's spending,
not theirs. Asserted in the same test.

The routing degrades honestly in every direction. A member with no spending access, a Circle that has
not enabled the module, an unreadable chain, or limits disabled outright all route to `THRESHOLD`
with a reason — never to a refusal.
→ *a member with no spending access is routed to the Circle, not refused*, *when the module cannot be
verified, limits are simply unavailable*.

---

## 6. Revoking

Removing spending access is a threshold-approved Circle transaction —
`removeDelegate(delegate, removeAllowances: true)` — which unregisters the member **and** zeroes
their figures, so a later re-add cannot silently restore a limit the Circle thought it had taken
away. The readback checks both.

```
→ threshold-approved Circle transaction
→ revoke delegate + zero the allowance
→ confirmed on-chain
→ only then: "No spending access"
```

**A stale app session cannot preserve spending access**, and the reason is structural rather than a
matter of session handling: the app never held the authority. The module's delegate list did, and
that is what changed. An authorization signed *before* the revoke is refused after it.
→ *spending access ends on-chain, and a stale session cannot preserve it*.

Revoking is itself a threshold decision — one admin cannot do it alone.
→ *a revoke is itself a threshold decision*.

---

## 7. What a delegate cannot do

Covered in full in `CIRCLE_MODULE_SECURITY.md` §7, and proven against Safe's real deployed bytecode.
In short: the module's only outward instruction to the Safe is a fixed-shape
`transfer(address,uint256)` it assembles itself, and a delegate never supplies calldata. Arbitrary
calls, owner changes, enabling modules and unlimited approvals are therefore all structurally
unreachable rather than merely validated against.

---

## 8. API

| Route | Purpose |
|---|---|
| `GET /v1/circles/limits/status` | are limits available on this deployment, and why not |
| `GET /v1/circles/:id/limits` | every member's limit, read from the module |
| `GET /v1/circles/:id/limits/me` | my limit — daily limit, spent, available |
| `POST /v1/circles/:id/limits/prepare` | build the next threshold transaction for a limit change |
| `POST /v1/circles/:id/limits/revoke/prepare` | build the revoke transaction |
| `POST /v1/circles/:id/governance/:pid/execute` | apply an approved change, then read the module back |
| `POST /v1/circles/:id/payments/preview` | allowance or threshold, decided from live chain state |
| `POST /v1/circles/:id/spend/prepare` | build the transfer hash for the member to sign |
| `POST /v1/circles/:id/spend/:sid/submit` | verify, re-read, simulate, relay |

Roles: only an **admin** may prepare or approve a limit change. `ADMIN`, `SPENDER` and `CONTRIBUTOR`
may spend against one; a `VIEWER` may do neither.

---

## 9. Tests

```
cd backend   && node --test test/circles-limits.test.js                     # 22
cd contracts && forge test --match-path 'test/AllowanceModuleCompat.t.sol'  # 23, vs real bytecode
```

| Requirement | Test |
|---|---|
| old module version → gate FAIL | *an old Allowance Module version fails the build/integration gate* · gate CLI against `0xAA4672…` |
| allowance replay → fail | *a stale authorization cannot be replayed after the nonce moves* · `testNonceExhaustionIsRefusedRatherThanWrapping` |
| same transfer signature reused → fail | `testTheSameTransferSignatureCannotBeReused` |
| over limit → fail | `testSpendingOverTheLimitFails` · `testSpendingIsCumulativeWithinTheWindow` |
| wrong token → fail | `testWrongTokenFails` · *only USDC — there is no token parameter* |
| removed delegate → fail | `testARemovedDelegateCannotSpend` · *spending access ends on-chain* |
| changed allowance race → reconcile | *a spend authorized before the Circle cut the limit is refused* · `testLoweringAnAllowanceInvalidatesAnInFlightSpend` |
| stale allowance → fresh read before authorization | *a stale authorization cannot be replayed…* (steps 3-4 of §4) |
| delegate tries arbitrary Safe call → fail | `testADelegateCannotMakeAnArbitrarySafeCall` |
| delegate tries to change owners → fail | `testADelegateCannotChangeTheOwnerSet` |
| delegate tries to enable module → fail | `testADelegateCannotEnableAnotherModule` |
| delegate tries unlimited USDC approval → fail | `testADelegateCannotGrantAnUnlimitedTokenApproval` |
