# Prism Circles — architecture

A **Circle** is a shared USDC account. Several people can see it, put money in, and — with enough
agreement — spend it. Its authority lives in a [Safe](https://safe.global) Smart Account on Monad.

This document describes what was built. The evidence that Safe is the right substrate is a separate
document, `CIRCLES_ARCHITECTURE_PROOF.md`; the version and address audit is
`CIRCLES_DEPENDENCY_AUDIT.md`; who may do what, and why that cannot be forged, is
`CIRCLES_AUTHORITY_MODEL.md`.

**Scope of this phase: the domain model, persistence, and Circle creation.** There is no Circle UI,
no Circle payment flow, and no spending limits.

---

## The one idea

> Prism owns the **human** layer. Monad owns the **money and authority** layer.

A Circle's name, its icon, who was invited, and what a proposal was *for* exist only in Prism —
there is nowhere else to keep them. The balance, the admin set, the number of approvals a payment
needs, and whether a payment actually happened exist on Monad, and Prism is only ever a reader of
them.

The failure this is designed against is not exotic. It is the ordinary one: a backend that shows a
balance it remembers instead of the balance that exists, or lists an admin who was removed an hour
ago. So the rule is stated as an invariant rather than an intention:

**The backend never fabricates a balance, an owner, a threshold, an allowance, or a successful
payment.**

`NEVER_FABRICATED` in `backend/src/circles/model.js` is that sentence as code, and
`circles-domain.test.js` asserts it.

### Canonical source map

| Fact | Canonical source | How Prism gets it |
|---|---|---|
| Circle name, icon | **Prism** | it exists nowhere else |
| Circle USDC balance | **Monad** | `USDC.balanceOf(safeAddress)`, read per request |
| Circle admin authority | **Monad** | membership of `Safe.getOwners()` |
| Circle threshold | **Monad** | `Safe.getThreshold()` |
| Executed payment | **Monad** | Safe execution + the USDC `Transfer` log |
| Pending proposal | **coordinated** | Prism's intent + Safe Transaction Service |
| Collected approvals | **signatures** | ECDSA recovery against the digest and the live owner set |
| Member spending allowance | **on-chain module** | not applicable — limits are off (see below) |
| Recipient human identity | **Protected Alias Resolver** | the existing Prism resolver |
| Activity | **reconciled** | Prism operations reconciled against on-chain evidence |

The map is not prose only: `CANONICAL_SOURCES` is exported from the model and asserted in tests, so
a future field that claims the wrong authority fails the suite.

**What this looks like in practice.** A Circle record has no `balance` field to go stale — there is
nowhere to put one. `threshold` and `adminCount` exist, but they start `null` and are written by
exactly one function, `_verifyDeployment`, from a chain read; the number the creator *asked* for
lives separately under `creation.requestedThreshold`, plainly labelled as an intent. And when Monad
cannot be reached, the API returns `{ unavailable: true, reason }` rather than a number:

```jsonc
// GET /v1/circles/:id, RPC unreachable
"balance":   { "unavailable": true, "reason": "rpc unavailable", "source": "chain" },
"authority": { "unavailable": true, "reason": "rpc unavailable", "source": "chain" }
```

"I don't know" is a truthful answer. A remembered number presented as the current one is not.

---

## Shape of the code

```
backend/src/circles/
  model.js               domain types, the canonical source map, threshold rules — pure, no I/O
  templates.js           FAMILY / TRIP / COMMUNITY / CUSTOM — UX defaults only
  safeEncoding.js        Safe v1.4.1 encoding: digests, setup, CREATE2, owner calldata — pure
  safeCircleAdapter.js   SafeCircleAdapter — the ONLY place Prism talks to Safe
backend/src/chain/
  safeCircle.js          live wiring: Prism's chain provider + the Safe Transaction Service
backend/src/services/
  circleService.js       orchestration: creation, membership, governance proposals
```

`model.js`, `templates.js` and `safeEncoding.js` are pure functions. That is what lets the test suite
check Prism's Safe digest against hashes that came out of a real Safe contract, with no chain
present — see below.

### SafeCircleAdapter

Every Safe concern stops at this boundary: the proxy factory, the singleton ABI, the owner linked
list, the transaction service. `CircleService` and the route handlers speak the Circle domain
language and never see a Safe ABI, so changing Safe version or SDK is a change to one file.

```
predictCircleAddress   createCircle          getCircleState        getOwners
getThreshold           buildTransaction      getTransactionHash    encodeContractSignature
proposeTransaction     addConfirmation       getPendingTransactions executeTransaction
getUsdcBalance         getDeploymentReceipt  verifyApproval
```

`SAFE_ADAPTER_METHODS` lists that contract, and `CircleService` validates any injected adapter
against it at construction — so a test double that forgets a method fails at wiring time rather than
halfway through a creation flow.

Two rules the adapter enforces for the whole system:

1. **Chain-owned reads are always live.** There is no cache, because a cached authority is a
   fabricated authority the moment it goes stale.
2. **Nothing the Safe Transaction Service says is taken on its word.** Every confirmation it returns
   is re-verified with `verifyApproval` against the digest and the live owner set before it counts.
   The service is shared storage; a service outage degrades *sharing*, never authority.

### The digest is computed four times, independently

The digest an admin signs is the one thing a compromised backend would have to lie with. So the
backend's copy is checkable offline, against hashes it did not produce:

| # | Implementation | Where |
|---|---|---|
| 1 | the Safe contract itself | `getTransactionHash()` on a real Safe v1.4.1, Monad testnet fork |
| 2 | the official Safe protocol-kit | `tools/circles/verify-vectors.mjs` |
| 3 | Swift, on the phone | `ios/Prism/Core/Circles/SafeTransactionHash.swift` |
| 4 | **the backend** | `backend/src/circles/safeEncoding.js` |

All four agree on every vector in `proof/circles/safe-tx-vectors.json` — safeTxHash, domain
separator and EIP-712 pre-image, across varying recipient, amount, nonce, Safe address and chainId.
`circles-safe-adapter.test.js` is what holds #4 to #1.

The adapter additionally cross-checks its locally computed digest against the deployed Safe's own
`getTransactionHash()` on every proposal, and **raises** on disagreement rather than proceeding —
the check that would catch a Safe version drift.

---

## Creation

Creation is a state machine because each state is a claim that has been checked, not ceremony:

| State | What has been established |
|---|---|
| `CREATED` | the request is well-formed |
| `MEMBERS_SELECTED` | every admin is a real Prism identity with a real authority address |
| `POLICY_REVIEWED` | the threshold is valid, and the creator confirmed the same trade-off Prism computed |
| `AWAITING_AUTHORIZATION` | the creator explicitly authorized this exact shape |
| `DEPLOYING` | a deployment transaction was broadcast |
| `CONFIRMING` | that transaction was actually mined |
| `RECONCILING` | the deployed Safe has been read back from Monad |
| `ACTIVE` | that read matched what was authorized, in **every** field that matters |

`ALLOWED_CIRCLE_TRANSITIONS` gives `RECONCILING` the only edge to `ACTIVE`, and
`CircleService._verifyDeployment` is the only function that takes it. Before it does, it checks:

- the chain is the configured chain;
- the Safe is at the **predicted** address;
- the singleton is the audited Safe v1.4.1 deployment, and `VERSION()` really returns `1.4.1`;
- the owner set is **exactly** the authorized admin authorities;
- the threshold is **exactly** the authorized threshold.

Any mismatch → `VERIFICATION_FAILED` with the reason, never `ACTIVE`.

**A client's request never produces ACTIVE on its own.** If the deployment has not been mined by the
time the request returns, the API says `DEPLOYING` or `CONFIRMING` with `verifiedOnChain: false` and
an `unavailable` balance. Simply reading the Circle later finishes the flow. The proof that `ACTIVE`
was earned is `circle.activation`, a receipt of the chain read; an `ACTIVE` Circle without one is
demoted to `VERIFICATION_FAILED` on the next read rather than trusted.

### Idempotency

The Safe's `saltNonce` is a pure function of the Circle's shape — creator, name, admin authorities,
threshold — so a retried request predicts the same address and therefore *is* the same Circle. A
repeat resumes the existing flow instead of deploying a second Safe, with or without an
`Idempotency-Key`. An interrupted creation (a failed broadcast, a crash mid-deploy) parks at the
state it reached and resumes on retry.

Validation happens **before** anything is persisted, so a rejected request leaves no half-built
Circle behind.

### Templates

Templates are UX defaults and nothing else. A template never selects a person, never invents an
admin address, and never overrides the creator.

| Template | Preferred | With fewer admins |
|---|---|---|
| `FAMILY` | 2-of-3 when three admins exist | degrades to a majority, capped at the admins present |
| `TRIP` | 2-of-3 | same |
| `COMMUNITY` | 3-of-5 where sufficient admins exist | same |
| `CUSTOM` | — | no recommendation at all |

`recommendThreshold` never returns more than the admin count, for any template at any size — a
property asserted exhaustively rather than spot-checked.

**Two-person Circles get no safe default, because there isn't one.** Both choices are stated:

> **1 of 2** — Either admin can move money alone.
> **2 of 2** — Both admins are required. Losing access to either authority can block spending.

`2 of 2` is the sharper of the two: at zero spare authority, one lost phone freezes the funds
*permanently*, because adding an owner, removing one, and lowering the threshold are each themselves
Circle transactions requiring the signature that was lost. Whether Prism should forbid that shape
outright remains an open founder decision, tracked in `TODO.md`. Until it is settled, creation
requires the creator to acknowledge the specific warning by code, and the acknowledgement must carry
the same threshold and admin count the sheet displayed — an acknowledgement for a different policy
is refused rather than reconciled.

---

## Members

Roles are `ADMIN`, `SPENDER`, `CONTRIBUTOR`, `VIEWER`; statuses are `INVITED`,
`PENDING_ACTIVATION`, `ACTIVE`, `PENDING_REMOVAL`, `LEFT`, `REMOVED`.

Invitations go through Prism's existing human identity layer — Prism id or `@handle`. Phone remains
reachability only, exactly as everywhere else in Prism; an invitation is an opaque id plus a role and
carries no phone number and no address.

**Accepting an invitation never grants admin authority.** An accepted `ADMIN` invitation lands in
`PENDING_ACTIVATION` and stays there until `Safe.getOwners()` includes that person. This is the point
where Prism's model could most easily lie, so it is the point most thoroughly tested: see
`CIRCLES_AUTHORITY_MODEL.md`.

Invitations are single-use, bound to their invitee, expire after 14 days, and are revoked if the
invitee has left or been removed — so an invitation issued before a removal cannot be used to climb
back in.

---

## Governance

`prepare-add`, `prepare-remove` and `threshold/prepare` **change nothing on-chain**. Each builds the
Safe transaction and returns the digest the Circle's current admins must sign. Authority moves only
when enough owners have signed and the transaction executes.

Rules enforced before a proposal is even offered, because Safe would reject them anyway and a
proposal that can never execute is worse than an error:

- threshold ≥ 1 and ≤ the owner count *after* the change;
- removing an admin from a Circle whose threshold equals its owner count requires naming a new valid
  threshold in the same transaction — Prism will not silently pick a weaker rule on the Circle's
  behalf, because that is a governance decision;
- a Circle must keep at least one admin;
- `prevOwner` for a removal is derived from the **live** owner list, never a remembered copy.

`requiredApprovals` is the current on-chain threshold, since that is what Safe will enforce.
`collectedApprovals` is counted from verified signatures and recomputed on every read, so an approval
from an admin who has since been removed simply stops counting. A proposal built against a nonce the
Safe has already consumed is reported as stale rather than left to look actionable.

---

## What is deliberately not here

- **Spending limits.** They require Safe's Allowance Module v1.0.0, which fixed a delegate-transfer
  replay vulnerability and is **deployed on no chain**; the only module on Monad is the pre-fix
  v0.1.1. `CIRCLE_LIMITS_ENABLED=false`, and `config.js` refuses that address explicitly rather than
  letting it work by accident. A `SPENDER` therefore has proposal rights, not independent spending
  authority, and the API says so. See `CIRCLES_DEPENDENCY_AUDIT.md`.
- **Circle payments.** The `PAYMENT` proposal kind and the USDC-transfer intent exist and are tested;
  the approve-and-execute flow is the next phase.
- **Circle UI.** None.
- **ERC-4337.** Circles uses Safe's ordinary `execTransaction` path; the relayer is a courier and
  members need no MON.
- **Recovery.** Social recovery, a Prism-held backup owner, and time-locked escape hatches are all
  viable on Safe and all deferred. Tracked in `TODO.md`, and required before real money.
- **A live Circle Safe on Monad.** Everything above is exercised against a faithful in-memory Safe
  and against digests taken from a real Safe on a testnet *fork*. No Circle Safe has been broadcast
  to live Monad — the same funded-key constraint recorded throughout `proof/`.

---

## API

All routes require a session. Membership is the read boundary: a non-member gets `404`, not `403` —
the existence of a Circle is itself private.

| Route | Purpose |
|---|---|
| `GET /v1/circles/templates?template=&admins=` | threshold guidance for the creation sheet |
| `POST /v1/circles` | create a Circle and drive the creation flow |
| `GET /v1/circles` | Circles this user belongs to |
| `GET /v1/circles/:id` | one Circle, with authority and balance read live from Monad |
| `GET /v1/circles/:id/members` | members, with `authorityConfirmedOnChain` |
| `POST /v1/circles/:id/invitations` | invite by Prism id or `@handle` (admin only) |
| `POST /v1/circles/:id/invitations/:inviteId/accept` | accept — grants membership, never authority |
| `POST /v1/circles/:id/invitations/:inviteId/decline` | decline |
| `POST /v1/circles/:id/admins/prepare-add` | build the owner-add transaction to be approved |
| `POST /v1/circles/:id/admins/prepare-remove` | build the owner-remove transaction to be approved |
| `POST /v1/circles/:id/threshold/prepare` | build the threshold-change transaction to be approved |
| `GET /v1/circles/:id/pending` | proposals awaiting approval, with verified approval counts |

**No route accepts a Safe address.** The Safe always comes from the stored Circle record the caller
belongs to. This is structural rather than validated: no method on `CircleService` takes a Safe
address parameter at all, so there is no shape of request that can aim a Circle operation at a Safe
the caller does not belong to.

---

## Tests

```
make test-backend                      # 237 tests, includes everything below
```

| Suite | Covers |
|---|---|
| `circles-domain.test.js` | the canonical source map, the creation flow graph, threshold arithmetic, two-person warnings, templates, every model factory |
| `circles-safe-adapter.test.js` | the backend digest against a real Safe's own hashes, digest binding, owner linked list, signature envelope ordering, CREATE2 prediction, approval verification, the adapter contract |
| `circles-creation.test.js` | creation, predicted address, correct owners and threshold, wrong owner set / threshold / chain / version rejected, duplicate creation idempotent, fabricated `ACTIVE` and fabricated threshold rejected, unreadable chain, resumable creation, no ghost Circles |
| `circles-members.test.js` | invitation, replay, wrong redeemer, stale invite after removal, expiry, admin authority only from the owner set, on-chain removal demotes, invitation privacy |
| `circles-governance.test.js` | prepare-add/remove/threshold calldata, gas-refund neutrality, removal leaving an invalid threshold, approval counting from signatures, stale nonce, authorization |
| `circles-config.test.js` | the Allowance Module refusal |

The chain is faked in `circles-harness.js`; the **adapter and service are real**. The fake decodes
the setup initializer, stores the owner set and threshold it was actually given, and derives the
CREATE2 address with the factory's formula spelled out independently of Prism's — so a mistake in
Prism's prediction surfaces as a Safe that deployed somewhere else.
