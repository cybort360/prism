# Circle Lifecycles

Five state machines, all guarded, all with the same discipline: **a state is a claim that has been
established, and the transition into it is the only place that claim can be made.** Where the claim
is about money or authority, the establishing evidence is a chain read — never a backend row, never
a caller's assertion.

The tables below are the executable ones in `backend/src/circles/model.js`; the tests read the same
constants, so this document and the code cannot drift apart silently.

---

## 1. Circle creation

```
CREATED → MEMBERS_SELECTED → POLICY_REVIEWED → AWAITING_AUTHORIZATION
        → DEPLOYING → CONFIRMING → RECONCILING → ACTIVE
```

| State | The claim it makes |
|---|---|
| `CREATED` | the request is well-formed |
| `MEMBERS_SELECTED` | every admin is a real Prism identity with a real authority address |
| `POLICY_REVIEWED` | the threshold is valid and the creator acknowledged the same trade-off Prism computed |
| `AWAITING_AUTHORIZATION` | the creator authorized this exact shape |
| `DEPLOYING` | a deployment transaction was broadcast |
| `CONFIRMING` | it was mined |
| `RECONCILING` | the deployed Safe was read back from the chain |
| `ACTIVE` | that read matched what was asked for, in every field that matters |

**`RECONCILING` is the only state with an edge to `ACTIVE`**, and `CircleService` only takes it
holding a verification receipt (`circle.activation`). A Circle marked `ACTIVE` without one is a
forgery and `_assertActivationIntegrity` un-trusts it.

Off-path: `VERIFICATION_FAILED` from anywhere; `DEPLOYING → AWAITING_AUTHORIZATION` when a broadcast
never landed, so the Circle is re-authorizable rather than stuck.

The public flow reported to callers collapses the first three into the user-visible sequence
`CREATED → AWAITING_AUTHORIZATION → DEPLOYING → CONFIRMING → ACTIVE`; `MEMBERS_SELECTED`,
`POLICY_REVIEWED` and `RECONCILING` are the checks in between, and they exist so that each of those
visible states is earned.

---

## 2. Threshold payment (money out, approved together)

```
CREATED → RESOLVING → RESOLVED → PROPOSED → APPROVAL_PENDING → APPROVED
        → SUBMITTED → CONFIRMING → CONFIRMED → RECONCILED → COMPLETED
```

| State | The claim it makes |
|---|---|
| `CREATED` | the request is well-formed and the proposer may spend from this Circle |
| `RESOLVING` | the recipient is being resolved through the Protected Alias Resolver |
| `RESOLVED` | a signed resolver attestation names a PrismIdentity and its account |
| `PROPOSED` | the exact Safe transaction exists and its digest is cross-checked with the Safe |
| `APPROVAL_PENDING` | fewer verified owner signatures than the Safe's **live** threshold |
| `APPROVED` | enough verified signatures from **current** owners over this exact digest |
| `SUBMITTED` | `execTransaction` was simulated, then broadcast |
| `CONFIRMING` | awaiting a receipt |
| `CONFIRMED` | the receipt succeeded **and** the Safe reported `ExecutionSuccess` for this digest |
| `RECONCILED` | a USDC `Transfer` proves Safe → reviewed recipient, for the exact amount |
| `COMPLETED` | terminal; the money moved and Prism holds the evidence |

`APPROVAL_PENDING ⇄ APPROVED` is the only bidirectional pair: approval is not stored, it is recomputed
from signatures against the live owner set on every read, so an admin removed on-chain drops an
approved payment back by itself.

There is **no edge into `COMPLETED` except from `RECONCILED`**, and none into `RECONCILED` except
from `CONFIRMED`. A backend that wants to call a payment done must first hold a receipt *and* a
matching Transfer log.

Off the happy path: `INVALIDATED` (a field the signatures cover changed), `EXPIRED` (the Safe
consumed the nonce elsewhere), `CANCELLED` (pre-broadcast, by an admin or the proposer), `FAILED`
(broadcast, and the chain said no).

## 3. Limited spend (money out, inside one member's allowance)

```
CREATED → RESOLVING → LIMIT_CHECKED → AUTHORIZED → SUBMITTED → CONFIRMED → COMPLETED
```

Stored as `spend.status` (`PREPARED → SUBMITTED → CONFIRMING → COMPLETED | FAILED`) and projected
onto the shared vocabulary above by `spendCircleState`:

| Step | What actually happens |
|---|---|
| `RESOLVING` | the same Protected Alias Resolver as every other Prism payment |
| `LIMIT_CHECKED` | the allowance is read **from the module**, immediately before signing |
| `AUTHORIZED` | the member signs the module's transfer hash, bound to its per-delegate nonce |
| `SUBMITTED` | the allowance is **re-read**, the module is asked by simulation, then broadcast |
| `CONFIRMED` | a USDC `Transfer` from the Safe to the reviewed recipient for the exact amount |
| `COMPLETED` | terminal, with the limit re-read afterwards |

Nobody approves a limited spend, and no surface may render one as if they had. The authority is the
module; the evidence is the same three-part test a threshold payment must pass.

## 4. Member authority

```
INVITED → ACCEPTED → PENDING_ACTIVATION → ACTIVE → PENDING_REMOVAL → REMOVED
```

| State | Meaning |
|---|---|
| `INVITED` | an invitation exists. It grants nothing |
| `ACCEPTED` | accepted in Prism |
| `PENDING_ACTIVATION` | an admin invitation accepted, waiting for the Safe to confer authority |
| `ACTIVE` | in the Circle — and for an ADMIN, an owner of the Safe **right now** |
| `PENDING_REMOVAL` | an owner-removal transaction is on the table; authority is unchanged until it executes |
| `LEFT` / `REMOVED` | terminal. An old invitation can never revive either |

Guarded by `ALLOWED_MEMBER_TRANSITIONS`, and every step appends to the member's own event log with a
real timestamp — which is what the activity feed reads to say *"Tobi joined"*.

Two properties worth stating:

- **Nothing in this machine can grant on-chain authority.** `ACTIVE` for an ADMIN is written by
  `_reconcileMembersFromOwners`, from the Safe's own owner set. Accepting an admin invitation lands
  in `PENDING_ACTIVATION`, and stays there until the Circle approves adding them on Monad.
- **`PENDING_REMOVAL` can go back to `ACTIVE`.** A removal that was cancelled, or that never
  executed, removed nobody. The owner-set reconciler leaves `PENDING_REMOVAL` alone while the person
  is still an owner, rather than "correcting" it away.

## 5. Closing

```
ACTIVE → CLOSING → CLOSED
```

`CLOSED` is reachable **only** from `CLOSING`, which is the only state in which the closure
requirements are checked. A closure can be called off — but the Circle re-enters through
`RECONCILING` and re-earns `ACTIVE` from a fresh chain read, because there is exactly one route to
`ACTIVE` in this service and reopening is not an exception to it.

See [§6](#6-what-closing-requires).

---

## 6. What closing requires

`GET /v1/circles/:id/close` returns a preflight computed from **live reads**, never from a checklist
the caller fills in. `CLOSE_REQUIREMENTS`:

| Code | Check | Source |
|---|---|---|
| `OPEN_PROPOSALS` | no unresolved Prism proposal may outlive the Circle | Prism |
| `SPENDING_ACCESS` | no member may still be able to spend from the Safe | the Allowance Module |
| `REMAINING_FUNDS` | the balance must be zero | the USDC contract |
| `CHAIN_RECONCILED` | the Safe's own state must be readable at close time | the Safe contract |

**A read that fails is itself a blocker.** Closing a Circle whose balance could not be read would
record a closure Prism cannot stand behind, so "we couldn't tell" is never treated as "it's fine".

### The refusal at the centre of it

> **Prism does not decide where a shared balance goes.**

There is no equal split, no automatic return to contributors, and no default. A Circle holding money
cannot be closed at all — it can only be **emptied first**, by the same threshold-approved payments
it has always used, to recipients its members choose. That is why `CLOSING` still permits money
*out* (which is how the balance leaves) and forbids money *in* (which would strand a contributor
behind a decision everyone else has already made).

### The flow

| Call | Effect |
|---|---|
| `GET /v1/circles/:id/close` | the preflight: blockers, checks, balance, authority |
| `POST /v1/circles/:id/close/begin` | `ACTIVE → CLOSING`, with an optional reason kept on the record |
| *(ordinary Circle payments)* | the members send the remaining balance where they decided |
| `POST /v1/circles/:id/close/cancel` | `CLOSING → RECONCILING → ACTIVE`, re-verified against the chain |
| `POST /v1/circles/:id/close/finalize` | `CLOSING → CLOSED`, if and only if every requirement holds |

`finalize` carries the balance the closer was shown. If it no longer matches what Monad reports, the
request is refused — the same discipline creation uses for the approvals-policy acknowledgement: a
confirmation that does not match the chain means the screen they agreed to is not this Circle.

While `CLOSING`, governance still works. Revoking a member's spending access is a threshold-approved
Safe transaction, and it is one of the things a Circle must do before it can close.

### What closing keeps

Closing is a lifecycle, **not a delete**. Nothing is removed: every payment, contribution, approval,
receipt and proof stays readable, and `circle.closing.evidence` records what the Circle was at the
moment it ended:

```
readAt · safeAddress · chainId
balanceAtomic (0) · balanceSource: "chain"
owners · threshold · safeNonce          — read from the Safe
moduleEnabled · spendDelegates          — read from the module
openProposals (0)
withdrawals[]                           — the Circle's own completed payments that emptied it,
                                          with recipient and transaction hash
```

`withdrawals` is derived from the Circle's completed payments, not from anything the closer typed.
An empty list is a truthful answer for a Circle that never held anything.

A `CLOSED` Circle refuses new money, new invitations, new payments and new governance. Its live
authority and balance are no longer presented — what it held at close is preserved in the closing
evidence, and showing a fresh read of an account nobody is using would be theatre.

---

## 7. Failure codes

Circle payments use the **shared** failure taxonomy (`backend/src/lib/lifecycle.js`), not a parallel
one:

| Code | Persisted | Canonical | Retryable | Means |
|---|---|---|---|---|
| `CIRCLE_APPROVAL_INVALIDATED` | requires_attention | requiresAttention | yes | a field the signatures cover changed; propose it again |
| `CIRCLE_NONCE_CONSUMED` | expired | expired | yes | the Safe used this nonce elsewhere |
| `CIRCLE_EXECUTION_FAILED` | failed | failedTerminal | no | broadcast, mined, and not the payment that was approved |
| `AUTHORIZATION_CANCELLED` | prepared | cancelled | yes | cancelled before broadcast |

## 8. Tests

| Claim | Test |
|---|---|
| one route to ACTIVE, through verification | `circles-domain.test.js` |
| the ten evidence proofs | `circles-evidence.test.js` |
| the feed is reconciled, money and governance stay apart | `circles-activity.test.js` |
| closing: every requirement, the funds refusal, fail-closed reads, history retained | `circles-closing.test.js` |
