# Circle Activity & Receipts

The one rule: **a Circle does not get its own money object.** Paying from a shared account is still
one `PrismPayment` — the same canonical projection, the same receipt, the same detail screen, the
same proof surface — carrying an extra block that says which Circle the money came from and what
authority released it. There is no Circle ledger, no Circle-only transaction history, and no
Circle-only receipt type.

Everything here extends what already exists: [PAYMENT_MODEL.md](PAYMENT_MODEL.md),
[RECEIPTS.md](RECEIPTS.md), [PAYMENT_PROOF.md](PAYMENT_PROOF.md).

---

## 1. The payment model, extended

`canonicalPayment()` and `receiptFor()` (`backend/src/lib/lifecycle.js`) gain two fields:

| Field | Meaning |
|---|---|
| `sourceType` | `personal` \| `circle`. Absent Circle context means personal, always. |
| `circle` | The optional Circle block below, or `null`. |

The Circle block (`backend/src/circles/circlePayment.js` `circleContext`):

```
circleId · circleName · circleIcon · circleSafeAddress · chainId
flow                   in | out
state                  the full Circle payment lifecycle state (never instead of lifecycleState)
approvalPolicy         THRESHOLD | SPENDING_LIMIT | CONTRIBUTION
authority              Shared | Delegated | Personal
approvalRule           "2 approvals"           (threshold payments only)
policy                 "2 of 3 admins"         (from the Safe, when it could be read)
requiredApprovals      n
approvers[]            { prismId, displayName, handle, authorityAddress, signatureType, status }
proposer               { prismId, displayName, handle, authorityAddress }
proposalId · contributionId · operationId
safeTxHash · safeNonce
spendingLimitReference { module, delegate, period, limitAtomic, availableAtSigningAtomic,
                         allowanceNonce, summary, source: "chain" }
restricted             true when the viewer is the payee rather than a member
```

Every field is nullable, and a field that could not be established stays null. An unreadable owner
set yields a null `policy`, never a plausible one.

### Three kinds, one object

| `kind` | What it is | Authority |
|---|---|---|
| `circleContribution` | money **into** a Circle | the contributor's own account and signature |
| `circlePayment` | money **out**, under the threshold | n-of-m admin signatures over the Safe digest |
| `circleSpend` | money **out**, inside a member's limit | the Allowance Module, on-chain |

`entryMethod` is `circle` for all three. The **payer of an outgoing Circle payment is the Circle**,
not the admin who tapped send: `payment.sender` is the Circle's name and Safe address. Naming a
person there would say they spent their own money, which is the one thing a shared account never
means.

### Ids are the addressing scheme

Circle payment ids are prefixed at creation — `prp_` (threshold payment), `spd_` (limit spend),
`ctb_` (contribution) — so **one** endpoint serves both kinds of payment and the app never has to
know which it is holding:

```
GET /v1/payments/:id/canonical   → { payment, events, receipt }
GET /v1/payments/:id/proof       → the canonical Payment Proof, with a SHARED ACCOUNT section
```

`server.js` dispatches on the prefix; `CircleService.canonicalFor` / `evidenceFor` project the Circle
records into the same shape `PaymentService` produces for an operation.

### Who may see what

| Viewer | Sees |
|---|---|
| A member of the Circle | the whole block |
| The person who was paid (not a member) | the Circle's name and account; `restricted: true`, with `approvers`, `proposer`, `requiredApprovals`, `policy` and the limit reference stripped |
| Anyone else | `404 payment not found` |

Being paid by a Circle entitles you to know which Circle paid you. It does not entitle you to how it
governs itself.

---

## 2. Circle Activity

`GET /v1/circles/:id/activity` — one feed, two classes of event, **no invented history**.

Every **financial** row is a projection of a record that was already reconciled against the chain: a
contribution's settled Prism payment, a Safe execution plus the USDC `Transfer` inside its receipt,
an allowance transfer. Every **governance** row is a projection of either a member's own guarded
lifecycle or a governance transaction that was *read back from the chain* after it executed. The
response says so explicitly: `source: "reconciled"`.

```
{ id, class: "financial" | "governance", type, occurredAt,
  title, subtitle, detail,
  direction, amountAtomic, amountDisplay, signedAmountDisplay, asset, status, settled,
  actor, subject, counterparty,
  paymentId, operationId, transactionHash, proposalId, approvalRule,
  evidenceSource }
```

**A governance row carries no money fields at all** — `direction`, `amountAtomic` and
`signedAmountDisplay` are null, not zero — so no client can sum a limit change into a balance or
render it with a payment's vocabulary.

What it reads like:

```
Tobi added                         +$100.00
Sarah · Groceries                   -$42.00     (within their spending limit)
Airbnb · Apartment                 -$480.00
Tobi joined
Sarah's spending limit changed      $50.00 per day → $100.00 per day
```

The arrow appears only when there really was a previous limit. A first grant reads *"Sarah's
spending limit was set — $100.00 per day"*, with no invented starting point (a registered delegate
holding a zero allowance had no limit either).

`paymentId` on a financial row is what opens the ordinary Prism receipt. `proposalId` is set only
while a payment is still **open**, so a settled payment offers a receipt rather than an approval.

### Types

| Class | Types |
|---|---|
| financial | `CONTRIBUTION` `PAYMENT` `SPEND` |
| governance | `MEMBER_INVITED` `MEMBER_JOINED` `MEMBER_PENDING_ACTIVATION` `MEMBER_PENDING_REMOVAL` `MEMBER_LEFT` `MEMBER_REMOVED` `ADMIN_ADDED` `ADMIN_REMOVED` `THRESHOLD_CHANGED` `LIMITS_ENABLED` `SPENDING_ACCESS_GRANTED` `SPENDING_ACCESS_REMOVED` `SPENDING_LIMIT_CHANGED` `CIRCLE_CREATED` `CIRCLE_ACTIVE` `CIRCLE_CLOSING` `CIRCLE_CLOSED` |

`MEMBER_ACCEPTED` is deliberately absent: accepting is a step in the member's own lifecycle, not a
change to the Circle. What the Circle's feed reports is whether they are in (`MEMBER_JOINED`) or
still waiting on Monad (`MEMBER_PENDING_ACTIVATION`).

A governance change that was **proposed but never executed** is not in the feed. It did not happen.

### Personal Activity

The same records reach the people involved, through the feed they already have:

| Row | Who sees it | Shape |
|---|---|---|
| `circle-contribution` | the contributor | an ordinary outgoing payment, labelled with the Circle |
| `circle-received` | the person a Circle paid | incoming, counterparty = the Circle's name |

An admin who was neither payer nor payee gets **no** personal row for the Circle's payment: it is the
Circle's money and it belongs in the Circle's feed. Approval events are not mirrored into personal
Activity — the approval inbox on the Circle is where a decision waiting on you lives.

---

## 3. The receipt

One receipt surface. `PaymentDetailsView` renders a **Paid from a Circle** / **Added to a Circle**
section above the ordinary receipt rows, built by `PaymentDisplay.circleRows`.

A threshold payment:

```
LAGOS TRIP
Airbnb
-$480.00

Paid from        Lagos Trip
Requested by     Octane
Approved by      Octane
                 Tobi
Approval rule    2 approvals
Asset            USDC
Status           Sent
Sep 10, 2026

[ Payment Proof ]
```

A contribution:

```
LAGOS TRIP
+$100.00

Added to         Lagos Trip
Added by         Octane
Asset            USDC
Status           Added
```

A within-limit spend names the limit and **never** claims an approval:

```
Paid from        Lagos Trip
Spending limit   $100.00 per day
```

`approvers` on a settled payment are the signatures the **Safe itself accepted** when it executed
(`proposal.approvalsAtExecution`), not a list re-derived later from an owner set that may have
changed. Before broadcast they are re-counted from signatures against the live owner set on every
read, so an admin removed on-chain drops out by themselves.

The lifecycle timeline names the authority too: *Approved by the Circle* for a threshold payment,
*Within your limit* for a spend, and neither for a contribution.

---

## 4. What this is not

- Not a second ledger. `circles-activity.test.js` proves the feed's money rows correspond one-to-one
  with the contributions, payments and spends that exist, and that `in − out == USDC.balanceOf(safe)`.
- Not a separate receipt type. The same `PaymentDetailsView`, the same `PrismReceipt`.
- Not a separate proof surface. See [CIRCLE_PROOF.md](CIRCLE_PROOF.md).
- Not a place where Prism computes balances. Every figure in the Circle block that belongs to the
  chain is read from the chain — see `CANONICAL_SOURCES` in `backend/src/circles/model.js`.

## 5. Where the code is

| Piece | File |
|---|---|
| Circle context + projections | `backend/src/circles/circlePayment.js` |
| Canonical projection | `backend/src/lib/lifecycle.js` (`canonicalPayment`, `receiptFor`) |
| `canonicalFor` / `evidenceFor` | `backend/src/services/circleService.js` |
| The feed | `backend/src/services/circleActivityService.js` |
| Personal Activity rows | `backend/src/services/activityService.js` |
| iOS model | `ios/Prism/Models/PrismCanonicalModel.swift` (`PrismCircleContext`) |
| iOS receipt rows | `ios/Prism/Features/Receipts/PaymentDetailsModel.swift` (`circleRows`) |
| iOS feed row | `ios/Prism/Features/Circles/CircleVocabulary.swift` (`CircleActivityItem`) |
| Tests | `backend/test/circles-evidence.test.js`, `circles-activity.test.js`, `ios/PrismTests/CircleReceiptTests.swift` |
