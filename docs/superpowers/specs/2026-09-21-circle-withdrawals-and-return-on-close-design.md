# Circle member withdrawals & return-on-close

**Date:** 2026-09-21
**Status:** Approved (design)

## Problem

A Circle is a Gnosis Safe holding a **shared USDC pool**. Today money only leaves via a
threshold-approved payment to a recipient, and closing a Circle requires the members to manually
empty it first — "Prism never decides where a shared balance goes." There is no first-class way for
a member to get *their* money back, and closing can strand funds.

We want:
1. A member can **withdraw** their money back to their own Prism account, subject to admin approval.
2. **Closing** a Circle returns the remaining balance to members instead of requiring a manual empty-out.

## Decisions (from brainstorming)

- **"Their money" = net contribution.** `netContributed(member) = Σ confirmed contributions −
  Σ confirmed withdrawals`. That is the withdrawal ceiling.
- **Shortfall on close is shared pro-rata by contribution** (group spending can drain the pool below
  the sum of contributions; everyone shares the loss in proportion to their net contribution).
- **Normal threshold approval.** A withdrawal is a payment proposal (recipient = the member) needing
  the Circle's usual admin threshold; close proposes one payout per member the same way. Reuses the
  audited propose → approve → execute → reconcile pipeline. Prism never moves money unilaterally.

## Design

### A. Contribution ledger
Derived, not authoritative: computed from existing CONFIRMED contribution records plus new
WITHDRAWAL records. For each member:
- `netContributed = Σ(confirmed contributions) − Σ(confirmed withdrawals)`  (integer base units)
- `withdrawableNow = min(netContributed, liveSafeBalance)`

All amounts are integer USDC base units (6 decimals) as BigInt/strings — never floats. The live
Safe balance is a chain read (money-truth); the ledger only *bounds* what may be proposed.

### B. Withdrawal flow
1. Member opens their Circle → **Withdraw** → sees `withdrawableNow`, enters `amount ≤ withdrawableNow`.
2. `circleService.proposeWithdrawal({ circleId, memberPrismId, amountAtomic })`:
   - re-reads the ledger + live balance; rejects `amount > withdrawableNow` (409/400).
   - creates a **threshold payment proposal** with `recipient = member.accountAddress`, tagged
     `kind: WITHDRAWAL`, `beneficiaryPrismId = member`.
3. Admins approve to threshold → executes the Safe transfer to the member (existing execute path).
4. On confirmed receipt, a `CircleWithdrawal` record (CONFIRMED) is written, decrementing the
   member's net. Reconciliation is from the on-chain transfer, never from the request.

New logic vs an ordinary payment: the cap check (proposal time **and** re-checked at execute),
recipient-defaults-to-self, and the ledger decrement on confirmation. Everything else is existing.

### C. Close → return to members
On entering CLOSING, compute per-member payouts pro-rata to net contribution against the live balance:
- `raw_i = netContrib_i / Σ netContrib × balance`
- integer split via **largest-remainder** so `Σ payout_i == balance` exactly; leftover base unit(s)
  assigned to the largest-remainder members deterministically (stable member ordering).
- generate one WITHDRAWAL/payout proposal per member with `payout_i > 0` (recipient = their account).
Each payout needs threshold approval; as they execute the balance drains. When balance == 0 with no
open proposals, close finalizes to CLOSED (existing CLOSE_REQUIREMENTS: REMAINING_FUNDS satisfied).

### D. Invariants
- Money-truth (INV-M1/M2): balance + execution are chain-truth; the backend computes *suggested*
  amounts and holds state machines/projections, never a balance. No terminal state without a
  confirmed on-chain receipt.
- Authority: every withdrawal/payout is threshold-approved by admins — Prism never unilaterally
  distributes. Pro-rata amounts are suggestions admins approve.
- A withdrawal never exceeds the member's net contribution (server-enforced at propose AND execute).
- Privacy (INV-P1): no phone-derived value on any withdrawal/close surface; beneficiary is an
  account address.

### E. iOS surfaces
- Circle detail: a **Withdraw** action for members showing `withdrawableNow`, then amount entry →
  proposal (routes into the existing approval UI).
- Close screen: previews each member's computed return **before** generating the payout proposals.

### F. Testing
- Ledger math: net contribution, `withdrawableNow` cap (contribution vs balance).
- Pro-rata: payouts sum exactly to balance; largest-remainder dust handling; zero-contribution member
  gets nothing.
- Hostile: withdrawal > net contribution rejected at propose and at execute; withdrawal while another
  is pending cannot double-spend the ledger.
- Close with shortfall → pro-rata reduction.

## Files (anticipated)
- `backend/src/services/circleService.js` — `proposeWithdrawal`, ledger computation, close payout
  generation; `domain/circle*.js` — `CircleWithdrawal` shape + transitions + pro-rata helper.
- `backend/src/server.js` — withdrawal + withdrawable-preview routes.
- `backend/test/circle-withdrawals.test.js` — ledger, pro-rata, hostile.
- `ios/…/Circles/*` — Withdraw action + close preview.

## Out of scope
- No new on-chain contract (reuses Safe threshold execution). No per-member vault. No automatic
  execution without approval.
