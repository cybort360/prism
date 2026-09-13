# Prism Circles — the consumer product

The money movement is documented in `CIRCLE_PAYMENTS.md` and `CIRCLE_SPENDING_LIMITS.md`. This
document is about the part a person actually touches: where Circles live in the app, the words they
are described with, how each screen decides what is true, and what happens when something is not.

Status: **written, not compiled.** There is no Swift toolchain on the machine this was built on;
`make test-ios` needs macOS. Every claim about a screen below is `UNTESTED`. What *is* tested is the
layer underneath it — see §9.

---

## 1. Where Circles live

**On Home. There is no fifth tab.**

The tabs stay Home · People · Activity · Profile. A Circle is money, and it belongs where the
person's own money already is — a separate tab would file shared money as a separate product rather
than as another place their money sits.

```
Home
 ├── Total balance
 ├── Send · Request · Scan · Add money
 ├── [invitations waiting]
 ├── CIRCLES
 │    ├── Lagos Trip   $1,240.00   6 people
 │    ├── Family         $820.00   4 people
 │    └── [ + New Circle ]
 ├── People
 └── Recent activity
```

Opening one is a **full-screen place**, not a sheet, because a Circle is somewhere a person stays:
it has members, settings and a history to move between. Inside it, member/settings/invite are
pushes; add-money, pay and approve are sheets, presented by the Circle itself rather than by the app
shell — presenting them one level up would put a sheet over a sheet.

## 2. The vocabulary rule

**No Safe, multisig, wallet, signer, signature, threshold, nonce, delegate, allowance, on-chain,
gas, token, USDC, smart-contract or crypto vocabulary reaches a normal screen.**

The mechanism is real and load-bearing, and it is exactly as visible to a person as ACH is inside a
bank app. What they see instead:

| Underneath | On screen |
|---|---|
| Safe owner | Admin |
| Threshold | "2 of 3 admins" |
| Safe transaction awaiting confirmations | "Waiting for approval" |
| Nonce already consumed | "This needs to be suggested again" |
| Allowance delegate with a limit | "Can spend — $100 per day" |
| `execTransaction` reverted | "This didn't go through" |
| USDC | dollars |

`Monad` is the one piece of infrastructure named, and only where it is load-bearing for trust — "the
Circle is being created on Monad", "Prism read it back from Monad to confirm". It is never required
in order to complete an action.

All of this lives in one file, `CircleVocabulary.swift`, so it cannot drift between the six screens
that use it. `CircleProductTests` sweeps the entire vocabulary surface — every state, every role,
every payment status, every kind of change, every approval rule from 1-of-1 to 5-of-5 — against the
forbidden-term list.

## 3. Creating a Circle

Six steps, in this order, and the order is an argument about consent:

1. **Name** — "What are you managing together?" Plus an optional icon, and the kind of Circle
   (Trip · Household · Group). The kind exists for one reason: it is what makes a *safe default
   recommendation* possible at step 4. A template only ever recommends; it never picks a person and
   never overrides a choice.
2. **People** — contacts or an exact @handle, resolved through the **same Protected Alias Resolver a
   payment uses**. Someone who is not on Prism is refused here, with the reason, rather than added
   and broken later.
3. **Admins** — "Who can approve payments?" The creator is shown as a permanent admin (a Circle with
   no admin could never be governed), everyone else is a toggle.
4. **Approval rule** — every valid rule, each with its consequence next to it:
   - *1 of 3* — "Any one of the 3 admins can send a payment on their own, without the others agreeing."
   - *2 of 3* — recommended — "2 of the 3 admins have to approve each payment. The Circle still works if one admin can't be reached."
   - *3 of 3* — "Every one of the 3 admins has to approve every payment. If any of them loses access to their phone and can't recover it, the money can't be moved at all."

   The last one is the trap this screen exists to prevent. Selecting a rule *is* the acknowledgement
   the backend requires — it re-derives the warnings itself and refuses a creation whose
   acknowledgement does not match.
5. **Spending access** — see §6. With limits unavailable it does **not** fake a control: it says so,
   and shows everyone as "Approval required".
6. **Review** — the summary, then **WHO CAN MOVE THIS MONEY**, as plain sentences:

   > 2 of the 3 admins have to approve each payment. The Circle still works if one admin can't be reached.
   > Nobody can pay out of this Circle without the admins approving it.
   > Sarah, David can add money and suggest payments, but cannot approve them.
   > Prism cannot move this money. Only the approvals above can.

Then Face ID / PIN → **Creating… → Confirming… → Circle ready**.

"Ready" is a chain fact. The confirming loop is not idle polling — reading a Circle is what
*advances* it, so the loop is the mechanism, and it stops at `ACTIVE` only when Prism has read the
deployed Circle back and found it matches exactly what was authorized. A creation that is still
confirming reports that honestly rather than claiming success.

Admins exist at deployment (they are the Safe's owner set); everyone else is invited immediately
afterwards. If an invitation fails, the Circle is *not* reported as failed — it exists — and the
screen says which person still needs adding.

## 4. Inside a Circle

```
LAGOS TRIP
$1,240.00        6 people

[ Add money ]  [ Pay ]  [ Invite ]

NEEDS YOUR APPROVAL
  Airbnb   $480     Requested by Octane    1 of 2 approvals   [ Review ]

ACTIVITY
  Tobi added                 +$100     Added
  Airbnb                     −$480     Paid
  Sarah · Groceries           −$42     Paid

MEMBERS                                            Settings →
```

Order is deliberate: balance first (the question everyone opens the app to answer), then the only
thing on the screen *waiting on this person*, then the shared history that makes the account
trustworthy, then members — who change rarely, and whose change is a governed act.

**The dash.** When Monad cannot be read the balance renders `—`, not the last number seen. A shared
account showing a balance nobody can confirm is precisely how two people end up disagreeing about
what is in it. The same rule covers approval counts ("Approvals unknown") and member authority.

**The activity feed** merges three sources — money in, payments the Circle approved, and payments a
member made inside their own limit — because a person thinks of them as one list. Newest first; a
line with no usable timestamp sorts last rather than being dropped, because a line whose time is
unknown is still a line that happened. Only a payment that is still open is tappable through to an
approval; a settled one is a receipt.

## 5. Approvals

The inbox holds two genuinely different things and decodes them as such: **payments**, which carry a
recipient and an amount, and **changes**, which carry a target and calldata. Rendering one with the
other's vocabulary would show a settings change with a blank amount next to an Approve button.

Both approval screens hold the same discipline, and it is the reason they are safe to trust:

> Before you approve, this device rebuilds the transaction from what you see here and refuses to
> sign if it doesn't match.

For a payment that is `CircleApprovalValidator` (recipient, amount, USDC target, nonce, Safe, chain,
then the digest). For a change it is `CircleGovernanceValidator`, and what it binds is different:

- **Two targets are legitimate and no others** — the Circle's own Safe (admins, approval rule,
  turning limits on) and the verified Allowance Module (delegates and limits).
- An **unrecognized kind is refused**, not waved through with a generic check. A kind this build has
  never heard of is exactly the thing that must not be auto-signed.
- The gas-refund fields must be neutral, or a second unreviewed payment could ride inside the first.
- Then the digest is recomputed from the displayed fields — which is what makes every check above it
  load-bearing rather than decorative.

An admin whose approval is already counted is told so and is not asked again. The match is on the
**authority address that signed**, not on a Prism id, because that address is what the Safe counts —
and a governance approval comes back without a Prism id at all.

After approving: *Approved — waiting for one more approval*. When the last approval lands, the
action becomes **Send payment** / **Apply change**, and that grants nothing further: the backend
re-reads the live admin set, re-verifies every signature, simulates, and broadcasts only if the
simulation succeeds. A refusal is the normal, honest outcome, surfaced as a reason.

For a change there is one more step, and it is the one that means anything: after broadcast Prism
**reads the change back off Monad**. "Active" means the readback agreed, not that a transaction
succeeded.

## 6. Members, roles and limits

A member page answers "what can this person do with our money", and is exact about where each
answer comes from. Two rows are Prism facts an admin can change here and now; two are chain facts
nobody can change here at all:

| Row | Who decides | Control |
|---|---|---|
| Can add money | Prism | segmented picker, immediate |
| Can suggest payments | Prism | same |
| Can spend on their own | the Allowance Module | starts a change the Circle approves |
| Admin | the Safe's owner set | starts a change the Circle approves |

Mixing those behind identical-looking toggles is how a person ends up believing they revoked
something they did not. So:

- **`setMemberRole` cannot grant or revoke ADMIN in either direction.** The backend refuses, and
  names the governance action that does work.
- **Neither a role change nor a removal is allowed while the member still holds a live spending
  allowance.** Taking away the label and leaving the money access would be worse than refusing.
  This check **fails closed**: if Monad cannot be read, the change is refused, because recording a
  removal we cannot verify is the stale-session failure limits exist to prevent.
- Removing someone also **revokes their unanswered invitation**, so a pending invite cannot quietly
  re-admit them.

**Invitations** choose the role *before* the person, with its consequence on screen the whole time —
choosing a person first makes the role feel like a detail to tidy up afterwards, when it is the only
part of the screen that decides what they can do with the money. And an invitation grants nothing:
accepting makes someone a member, and admin authority still waits on the Circle approving them on
Monad. The acceptance confirmation says exactly that, in the backend's own words.

`GET /v1/circles/invitations` exists because without it an invitation is unreachable — accepting one
needs an id only the invited person's device can supply, and nothing else in Prism would ever hand
it to them.

**When limits are unavailable** (the current deployment — no Allowance Module ≥ v1.0.0 on Monad),
"Can spend" is not offered anywhere: not in the invite roles, not in the creation flow, not on the
member page. The state is shown as an ordinary fact, not an error:

> **Spending limits aren't available yet.** Every payment from this Circle is approved by its
> admins. Personal spending limits need a verified spending contract that isn't available on this
> network yet.

That is a complete and safe way for a Circle to work, and the copy says so rather than implying
something is broken.

## 7. Every state, and its next action

`CircleState` is one enum with one rule: **every state names something the person can do next.** A
dead end in a shared-money product is where people start guessing. The two exceptions are the two
states where nothing is wrong and nothing is owed — "Nothing waiting on you" and "Spending limits
aren't available yet" — and the test asserts that only those two may omit an action.

| State | What it says | Next action |
|---|---|---|
| No Circles | what a Circle is for | New Circle |
| No members yet | invite the people sharing this money | Invite people |
| No balance | nothing added yet | Add money |
| No pending approvals | nothing waiting on you | — |
| Setting up on Monad | DEPLOYING / CONFIRMING / RECONCILING, each worded | Check again |
| Circle setup failed | the mismatch verification actually found | Start again |
| Proposal stale | another payment went first; this can never send | Suggest it again |
| Admin removed | their approval stopped counting | Review it |
| Not enough in the Circle | amount vs. holding; can still be topped up | Add money |
| Spending limit reached | this is a fork, not a failure | Request approval |
| Network unavailable | unknown, not out of date | Try again |
| Approval already counted | a second approval moves nothing | Done |
| Already executed | sending again would be a second payment | View receipt |
| Limits unavailable | the Circle spends by approval | — |

## 8. Accessibility

- **No status is distinguishable by colour alone.** `CircleTone` never travels without a symbol;
  `CircleStatusBadge` renders symbol + word, so the same information survives a colour-blind reader,
  a greyscale screenshot and VoiceOver. A test asserts every state and every member status carries a
  non-empty symbol.
- **Dynamic Type**: text sizes come from the shared scale; `@ScaledMetric` drives the Circle avatar;
  every multi-line string carries `fixedSize(horizontal: false, vertical: true)` so it grows rather
  than truncating; amounts use `minimumScaleFactor` rather than clipping.
- **VoiceOver**: each composite row is one element with a written label — a Circle row reads
  "Lagos Trip, $1,240.00, 6 people" and hints "Opens this Circle"; an approval-rule option reads its
  label, whether it is recommended, its consequence *and* its warnings; the PIN dots read
  "3 of 6 PIN digits entered"; decorative icons are `accessibilityHidden`.
- **Small iPhone / Pro Max**: no fixed-width containers on content; long names lineLimit + scale;
  every long screen is a `ScrollView`; the creation footer keeps back and forward on one row.
- **Safe area**: screens use `prismScreen()` (the shared background + ignoresSafeArea) with explicit
  bottom padding on action rows.
- **Reduced motion**: no custom animation was added by this work; transitions are the system sheet
  and push, which honour the setting.

## 9. What is tested, and what is not

**Tested (executed):**

- `backend/test/circles-members.test.js` — role changes, removal, the two refusals, invitation
  listing and expiry. 21 tests.
- `backend/test/circles-governance.test.js` — the full authority loop: prepare → approve by the
  threshold → apply → **read the owner set back off the chain**. Includes a change whose transaction
  is altered after proposal (refused, and stays dead), payment/governance route confusion, and a
  non-admin approval. 22 tests.
- The fake Safe now genuinely applies `addOwnerWithThreshold` / `removeOwner` / `changeThreshold`.
  It previously emitted `ExecutionSuccess` without changing anything, which would have made every
  governance readback pass vacuously. The new readback caught it.
- Whole backend suite: **306 pass / 0 fail**.

**Written, not executed:** every iOS file. `ios/PrismTests/CircleProductTests.swift` covers the
vocabulary sweep, the no-dead-ends sweep, the symbol sweep, the approval-rule consequences, the
activity merge and ordering, and the two-shapes-in-one-array decode — but it has not been run,
because there is no Swift toolchain here.

**Deliberately not built:**

- Closing a Circle. Withdrawing a shared balance and closing it is its own flow with its own
  consent question, and inventing one here would have been worse than leaving it.
- Re-inviting someone who was removed. The backend already requires a fresh invitation; the UI path
  for it is an admin re-inviting them normally, which works.
