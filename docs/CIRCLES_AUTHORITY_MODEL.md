# Prism Circles — authority model

Who can move a Circle's money, who decides that, and why Prism cannot forge any of it.

Companion to `CIRCLES_ARCHITECTURE.md` (what was built) and `CIRCLES_ARCHITECTURE_PROOF.md` (why
Safe). Every claim here names the test that establishes it.

---

## 1. Authority is a signature, not a row

A Circle's money moves when a Safe transaction carries enough valid owner signatures. That is the
entire authority model. Everything Prism stores about roles and members is **description** of that
fact, never a source of it.

The practical consequence, and the thing worth internalising:

> If Prism's entire database were rewritten by an attacker, no Circle's money would move.

A row saying someone is an admin does not make them one. A counter saying a proposal has three
approvals does not give it three. Both are checked against Monad before they are allowed to mean
anything.

| Question | Answered by |
|---|---|
| Who are the admins? | `Safe.getOwners()` |
| How many approvals does a payment need? | `Safe.getThreshold()` |
| Has this proposal been approved enough? | ECDSA recovery over the digest, against the live owner set |
| Did the payment happen? | the Safe execution and the USDC `Transfer` log |
| What is the Circle worth? | `USDC.balanceOf(safeAddress)` |

---

## 2. A Circle admin is their existing Prism account

An admin's Safe owner key is their **existing Mera passkey-derived secp256k1 address** — the same
account that already holds their personal USDC. Decided 2026-09-13; settled, not a recommendation.

It needs no new credential, no per-admin contract, and no EIP-1271: a Mera account is already a
native Safe owner signing plain ECDSA. Joining a Circle changes nothing about a person's personal
Prism account.

`PrismP256SafeOwner` remains in the tree as proof the P-256 EIP-1271 path works, and
`SafeCircleAdapter.encodeContractSignature` produces the pre-image such an owner would be handed —
but that path is not on the shipping route. See the DECIDED section of
`CIRCLES_ARCHITECTURE_PROOF.md`.

**Prism never invents an authority address.** An admin must be a Prism identity that has already
bound a Mera account; someone who has not finished onboarding cannot be made an admin, and the
request is refused with a human reason rather than a placeholder address.
→ `circles-creation.test.js`: *admin addresses are never invented*.

---

## 3. Roles, and what each one can actually do

| Role | In Prism | On Monad | Can move money? |
|---|---|---|---|
| `ADMIN` | may invite, may prepare governance changes | **is a Safe owner** | yes — by contributing an approval toward the threshold |
| `SPENDER` | may propose a spend | nothing | **no** |
| `CONTRIBUTOR` | may add money, may propose | nothing | no |
| `VIEWER` | may see the Circle | nothing | no |

`ADMIN` is the only chain-backed role (`CHAIN_BACKED_ROLES`). The other three are Prism-side
permissions: they shape what the app offers, and they confer no ability to move funds.

`SPENDER` deserves a blunt note. In a design with per-member spending limits, a spender could spend
alone up to their allowance. **Circles has no spending limits**, because Safe's Allowance Module
v1.0.0 — the release that fixed a delegate-transfer replay vulnerability — is deployed on no chain,
and the only Allowance Module on Monad is the vulnerable v0.1.1. So today a `SPENDER` can *propose*
and nothing more, and the API does not imply otherwise. `config.js` refuses to enable limits against
the vulnerable address at all.
→ `circles-config.test.js`.

---

## 4. Accepting an invitation does not make you an admin

This is the seam where a system like this most easily starts lying, so it is stated plainly and
tested hardest.

An invitation is a Prism fact. Admin authority is a Monad fact. Prism can record that someone
accepted; only the Safe's owner set can make them an admin.

```
invited as ADMIN ──accept──▶ PENDING_ACTIVATION ──Safe owner set includes them──▶ ACTIVE
```

Accepting an `ADMIN` invitation returns, verbatim:

```jsonc
{ "status": "PENDING_ACTIVATION",
  "authorityConfirmedOnChain": false,
  "note": "Admin authority becomes active only once the Circle approves adding you on Monad." }
```

`listMembers` carries `authorityConfirmedOnChain` for every admin, so the UI can distinguish
"accepted in Prism" from "holds authority on Monad" without inferring it.

Reconciliation runs in both directions, from the owner set only:

- a `PENDING_ACTIVATION` admin who appears in `getOwners()` becomes `ACTIVE`;
- an `ACTIVE` admin who no longer appears becomes `REMOVED`.

So an admin removed by an approved Safe transaction stops being an admin in Prism the next time
anyone looks, without Prism being told.
→ `circles-members.test.js`: *accepting an ADMIN invitation does NOT grant admin authority*, *admin
authority turns ACTIVE only when the Safe owner set confirms it*, *an admin removed on-chain stops
being an admin in Prism*.

---

## 5. Approvals are counted from signatures

`collectedApprovals` is **never** a number Prism increments. It is recomputed on every read by
recovering each signature over the proposal's `safeTxHash` and checking the recovered address
against the *current* owner set.

Three consequences fall out of that, all tested:

- **Inflating the stored counter changes nothing.** Setting `collectedApprovals: 99` in the database
  still yields `0` on read.
- **An approval from a since-removed admin stops counting.** The signature is still on file and still
  cryptographically valid; the signer is simply no longer an owner, so Safe would not honour it —
  and neither does Prism. A `READY` proposal silently reverts to `PENDING`.
- **A stranger's signature never counts**, however well-formed.

→ `circles-governance.test.js`: *pending: approvals are counted from verified signatures, never from a
Prism counter*, *pending: an approval from a since-removed admin stops counting*;
`circles-safe-adapter.test.js`: *an approval must be a real signature from a current owner over this
exact digest*.

`SignatureType` records how an approval was expressed — `ECDSA`, `ETH_SIGN`, `CONTRACT_SIGNATURE`,
`APPROVED_HASH` — because the four differ in trust. Prism verifies the first two off-chain and
refuses to count the other two as self-verifying: one needs an EIP-1271 call, the other an on-chain
read.

### The Safe Transaction Service is not an authority

It is reachable on Monad and used, when configured, as shared storage so a co-admin on another device
can see a pending proposal. Every confirmation it returns is re-verified by `verifyApproval` before
it counts. A compromised or confused service cannot inflate an approval count; an outage degrades
sharing, not authority.

---

## 6. The digest binds the Circle, the chain, and the nonce

An approval is a signature over a Safe EIP-712 digest that contains the Safe's address and the chain
id in its domain separator, and the nonce in its struct hash. So one signature authorises **one**
transaction, for **one** Circle, on **one** chain, at **one** nonce:

| A signature cannot be replayed onto… | because |
|---|---|
| another Circle | the Safe address is in the domain separator |
| another chain | the chain id is in the domain separator |
| another nonce | the nonce is in the struct hash |
| a different recipient or amount | the calldata is hashed into the struct hash |
| a delegatecall | `operation` is in the struct hash — and Prism refuses to construct one at all |

→ `circles-safe-adapter.test.js`: *the digest binds the Circle, the chain and the nonce*.

Two further details that are easy to miss and both enforced:

- **Gas-refund neutrality.** A non-zero `gasPrice` makes the Safe reimburse `refundReceiver` out of
  Circle funds — a second, unreviewed payment hidden inside the first. Every Circle transaction is
  built with `gasPrice`, `baseGas`, `safeTxGas` zero and `gasToken`/`refundReceiver` zero-address.
  → *prepare-add: the gas-refund fields are
  neutral, so no second payment hides inside the first*.
- **Never delegatecall.** `safeTransaction()` throws rather than building one, so there is no code
  path that produces a delegatecall proposal to be reviewed carefully.

The phone independently recomputes this digest before signing and refuses if it disagrees with what
the backend sent (`ios/Prism/Core/Circles/`). The backend's encoding is pinned to a real Safe
contract's own hashes by `circles-safe-adapter.test.js`. Four implementations, one answer.

---

## 7. Prism cannot forge an active Circle

`ACTIVE` requires a verification receipt — `circle.activation` — written only by `_verifyDeployment`
from a live chain read, after matching chain, address, singleton, version, owner set and threshold.

- An `ACTIVE` Circle with the receipt stripped out is **demoted to `VERIFICATION_FAILED`** on the
  next read, not trusted.
  → `circles-creation.test.js`: *backend fake ACTIVE is rejected*.
- A threshold rewritten in Prism's own database **loses to the chain**: the API returns the Safe's
  number, and the stored mirror is corrected back.
  → *a fabricated threshold in Prism's own database loses to the chain*.
- A Safe that deploys with different owners, a different threshold, a different version, or on a
  different chain **never becomes `ACTIVE`**.
  → *wrong owner set / threshold / chain / Safe version rejected*.

Authority drift on an already-active Circle — which an approved owner change produces legitimately —
re-anchors the receipt to what the chain now says and records a `circle.authority.changed` event,
rather than silently correcting.

---

## 8. Authorization at the API boundary

- **Membership is the read boundary.** A non-member receives `404`, not `403`: the existence of a
  Circle is itself private. → *membership is the read boundary: a stranger cannot see a Circle*.
- **Only an admin may invite or prepare a governance change.** A `VIEWER` who is a full member still
  cannot. → *only an admin can invite*, *only an admin may prepare a governance change*.
- **No route accepts a Safe address.** The Safe always comes from the stored Circle record the caller
  belongs to. This is structural: no `CircleService` method takes a Safe address parameter, so no
  request shape can aim a Circle operation at someone else's Safe.
- **Invitations are single-use, bound, and expiring.** One consumption (`409` on replay), only by the
  named invitee (`403` otherwise), 14-day expiry, and revoked outright if the invitee has left or
  been removed — so an invitation issued before a removal cannot be used to climb back in.
  → *invitation replay*, *an invitation cannot be redeemed by anyone other than its invitee*, *a
  removed user cannot regain their role from a stale invitation*.
- **Invitations carry no private identity material** — an opaque id and a role, no phone number and
  no address. → *an invitation carries no phone number, address, or other private identity material*.

---

## 9. Governance arithmetic

Safe rejects a zero threshold and a threshold above the owner count, so a proposal violating either
is guaranteed to revert. Prism refuses to *offer* one — a proposal that can never execute is worse
than an error message, because it looks actionable.

- threshold ≥ 1, and ≤ the owner count **after** the change;
- a Circle must keep at least one admin;
- removing an admin from a Circle whose threshold equals its owner count requires naming a valid new
  threshold in the same transaction. Prism will not quietly pick a weaker rule on the Circle's
  behalf — lowering how many people must agree is a governance decision, not a repair;
- `prevOwner` for a removal is derived from the **live** owner linked list. Deriving it from a
  remembered copy is how a removal proposal silently targets the wrong owner after an intervening
  change.

→ `circles-governance.test.js`: *owner removal cannot leave an invalid threshold*, *threshold cannot
be set to zero, or above the admin count*, *a Circle must keep at least one admin*, *prepare-remove
derives the predecessor from the live owner list*.

---

## 10. Known limits, stated plainly

1. **Zero spare authority is unrepairable.** A Circle at `threshold == adminCount` (2-of-2, 3-of-3)
   freezes **permanently** if one admin loses their phone: adding an owner, removing one, and
   lowering the threshold are each themselves Circle transactions requiring the signature that was
   lost. There is no admin override and no support path. Prism currently requires an explicit
   acknowledgement of that specific warning at creation; whether it should be forbidden outright is
   an open founder decision in `TODO.md`.
2. **Spare > 0 is necessary but not sufficient.** Two admin devices belonging to one person, or to
   one household, do not provide the independence the arithmetic assumes. Prism cannot currently tell
   the difference.
3. **No recovery story yet.** Social recovery, a Prism-held backup owner, time-locked escape hatches
   — all viable on Safe (`addOwnerWithThreshold` / `removeOwner` / `swapOwner` are ordinary
   threshold-approved transactions), all deferred. This must land before real money sits in Circles.
4. **No spending limits**, per §3.
5. **No live Circle Safe on Monad.** Everything is exercised against a faithful in-memory Safe and
   against digests taken from a real Safe on a testnet *fork*. The same funded-key constraint
   recorded throughout `proof/`.
6. **Monad mainnet Safe contracts are unverified.** Safe lists the same addresses for chainId 143;
   their codehashes have not been checked there.
