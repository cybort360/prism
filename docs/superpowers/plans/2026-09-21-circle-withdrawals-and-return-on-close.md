# Circle Withdrawals & Return-on-Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Circle member withdraw up to their net contribution back to their own Prism account (admin-approved), and return the balance pro-rata to members on close.

**Architecture:** A pure accounting module computes the net-contribution ledger and the pro-rata split. `circleService` gains a `withdrawablePreview`, a `proposeWithdrawal` (a normal threshold PAYMENT proposal whose recipient is the member's own account, tagged as a withdrawal), a confirmation hook that records the withdrawal, and a close-payout planner. No new contract — reuses the audited propose → approve → execute → reconcile Safe path. iOS adds a Withdraw action and a close preview.

**Tech Stack:** Node (ESM, `node --test`), the existing `circleService` + `src/circles/*` domain, `store.mutate`/`store.read` JsonStore, SwiftUI iOS.

## Global Constraints

- Money is **integer USDC base units** (6 decimals) as decimal strings / BigInt. **Never floats.** (verbatim: "All amounts are integer USDC base units (6 decimals) as BigInt/strings — never floats.")
- **Money-truth (INV-M1/M2):** balance + execution are chain-truth; backend computes *suggested* amounts and holds state machines/projections, never a balance; no terminal state without a confirmed on-chain receipt.
- **Authority:** every withdrawal/payout is threshold-approved by admins — Prism never distributes unilaterally.
- **Cap invariant:** a withdrawal never exceeds the member's net contribution — enforced at **propose AND execute**.
- **Privacy (INV-P1):** no phone-derived value on any withdrawal/close surface; beneficiary is an account address.
- Net contribution counts only `ContributionStatus.COMPLETED` contributions and `CircleWithdrawalStatus.COMPLETED` withdrawals.
- Run backend tests with `node --test test/<file>.test.js` from `backend/`.

---

### Task 1: Pure withdrawal-accounting module

The correctness core: three pure functions, no I/O. Everything else builds on these.

**Files:**
- Create: `backend/src/circles/withdrawal.js`
- Test: `backend/test/circle-withdrawal-math.test.js`

**Interfaces:**
- Produces:
  - `netContributions(contributions, withdrawals) -> Map<prismId, bigint>` — sum COMPLETED contributions minus COMPLETED withdrawals per member (never negative; floored at 0n).
  - `withdrawableFor(prismId, net, balanceAtomic) -> bigint` — `min(net.get(prismId) ?? 0n, balanceAtomic)`.
  - `proRataPayouts(net, balanceAtomic) -> Map<prismId, bigint>` — split `balanceAtomic` in proportion to each member's net using **largest-remainder**; the returned amounts sum to exactly `balanceAtomic`; members with 0 net are omitted; if total net is 0n returns an empty map.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/test/circle-withdrawal-math.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { netContributions, withdrawableFor, proRataPayouts } from '../src/circles/withdrawal.js';

const C = (prismId, amount, status = 'COMPLETED') => ({ contributorPrismId: prismId, amount: String(amount), status });
const W = (prismId, amount, status = 'COMPLETED') => ({ beneficiaryPrismId: prismId, amount: String(amount), status });

test('netContributions sums COMPLETED only, minus withdrawals, floored at 0', () => {
  const net = netContributions(
    [C('a', 100), C('a', 50), C('b', 30), C('a', 999, 'CONFIRMING')],
    [W('a', 40), W('b', 30), W('b', 5, 'PREPARED')]
  );
  assert.equal(net.get('a'), 110n); // 150 - 40; the CONFIRMING contribution ignored
  assert.equal(net.get('b'), 0n);   // 30 - 30; the PREPARED withdrawal ignored
});

test('withdrawableFor caps at the live balance', () => {
  const net = new Map([['a', 110n]]);
  assert.equal(withdrawableFor('a', net, 500n), 110n); // balance ample
  assert.equal(withdrawableFor('a', net, 40n), 40n);   // pool drained below net
  assert.equal(withdrawableFor('z', net, 40n), 0n);    // non-contributor
});

test('proRataPayouts sums exactly to the balance with largest-remainder', () => {
  // net 100/50/50 (total 200), balance 100 -> 50/25/25
  const p = proRataPayouts(new Map([['a', 100n], ['b', 50n], ['c', 50n]]), 100n);
  assert.equal(p.get('a'), 50n); assert.equal(p.get('b'), 25n); assert.equal(p.get('c'), 25n);
  assert.equal([...p.values()].reduce((s, v) => s + v, 0n), 100n);
});

test('proRataPayouts gives dust to the largest remainder deterministically', () => {
  // net 1/1/1 (total 3), balance 100 -> 34/33/33 (first by remainder, ties by prismId order)
  const p = proRataPayouts(new Map([['a', 1n], ['b', 1n], ['c', 1n]]), 100n);
  assert.equal([...p.values()].reduce((s, v) => s + v, 0n), 100n);
  assert.equal(p.get('a'), 34n); assert.equal(p.get('b'), 33n); assert.equal(p.get('c'), 33n);
});

test('proRataPayouts omits zero-net members and returns empty when total net is 0', () => {
  const p = proRataPayouts(new Map([['a', 0n], ['b', 10n]]), 10n);
  assert.equal(p.has('a'), false); assert.equal(p.get('b'), 10n);
  assert.equal(proRataPayouts(new Map([['a', 0n]]), 50n).size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/circle-withdrawal-math.test.js`
Expected: FAIL — `Cannot find module '../src/circles/withdrawal.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// backend/src/circles/withdrawal.js
// Pure Circle withdrawal accounting. Integer USDC base units (bigint) only — never floats.

const big = (v) => BigInt(String(v ?? '0'));

/** Net contribution per member: COMPLETED contributions minus COMPLETED withdrawals, floored at 0. */
export function netContributions(contributions = [], withdrawals = []) {
  const net = new Map();
  for (const c of contributions) {
    if (c.status !== 'COMPLETED') continue;
    net.set(c.contributorPrismId, (net.get(c.contributorPrismId) ?? 0n) + big(c.amount));
  }
  for (const w of withdrawals) {
    if (w.status !== 'COMPLETED') continue;
    net.set(w.beneficiaryPrismId, (net.get(w.beneficiaryPrismId) ?? 0n) - big(w.amount));
  }
  for (const [k, v] of net) net.set(k, v < 0n ? 0n : v);
  return net;
}

/** What a member may withdraw now: their net, capped by the live Safe balance. */
export function withdrawableFor(prismId, net, balanceAtomic) {
  const own = net.get(prismId) ?? 0n;
  const bal = big(balanceAtomic);
  return own < bal ? own : bal;
}

/** Pro-rata split of `balanceAtomic` by net contribution, largest-remainder so it sums exactly. */
export function proRataPayouts(net, balanceAtomic) {
  const balance = big(balanceAtomic);
  const entries = [...net.entries()].filter(([, v]) => v > 0n).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = entries.reduce((s, [, v]) => s + v, 0n);
  if (total === 0n || balance === 0n) return new Map();

  const out = new Map();
  const remainders = [];
  let assigned = 0n;
  for (const [id, share] of entries) {
    const numerator = share * balance;
    const floor = numerator / total;
    out.set(id, floor);
    assigned += floor;
    remainders.push([id, numerator % total]);
  }
  // Distribute the leftover base units to the largest remainders (ties broken by prismId order above).
  remainders.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : (a[0] < b[0] ? -1 : 1)));
  let leftover = balance - assigned;
  for (let i = 0; leftover > 0n && i < remainders.length; i++, leftover--) {
    const id = remainders[i][0];
    out.set(id, out.get(id) + 1n);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/circle-withdrawal-math.test.js`
Expected: PASS — 5 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add backend/src/circles/withdrawal.js backend/test/circle-withdrawal-math.test.js
git commit -m "Add pure Circle withdrawal accounting (net ledger + pro-rata split)"
```

---

### Task 2: CircleWithdrawal domain shape

**Files:**
- Modify: `backend/src/circles/model.js` (add near `newCircleContribution`, ~line 474-490)
- Test: `backend/test/circle-withdrawal-math.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CircleWithdrawalStatus` = `{ PROPOSED, SUBMITTED, CONFIRMING, COMPLETED, FAILED }` (frozen).
  - `newCircleWithdrawal({ withdrawalId, circleId, beneficiaryPrismId, beneficiaryAccount, amount, proposalId }) -> record` with `status: 'PROPOSED'`, `createdAt`, `updatedAt`, `transactionHash: null`.

- [ ] **Step 1: Write the failing test** (append to `circle-withdrawal-math.test.js`)

```javascript
import { CircleWithdrawalStatus, newCircleWithdrawal } from '../src/circles/model.js';

test('newCircleWithdrawal starts PROPOSED with the beneficiary and amount bound', () => {
  const w = newCircleWithdrawal({
    withdrawalId: 'wd_1', circleId: 'c1', beneficiaryPrismId: 'a',
    beneficiaryAccount: '0xabc', amount: '1000000', proposalId: 'prp_1'
  });
  assert.equal(w.status, CircleWithdrawalStatus.PROPOSED);
  assert.equal(w.beneficiaryPrismId, 'a');
  assert.equal(w.amount, '1000000');
  assert.equal(w.transactionHash, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/circle-withdrawal-math.test.js`
Expected: FAIL — `CircleWithdrawalStatus` / `newCircleWithdrawal` not exported.

- [ ] **Step 3: Implement in `model.js`** (add after `newCircleContribution`)

```javascript
export const CircleWithdrawalStatus = Object.freeze({
  PROPOSED: 'PROPOSED', SUBMITTED: 'SUBMITTED', CONFIRMING: 'CONFIRMING',
  COMPLETED: 'COMPLETED', FAILED: 'FAILED'
});

export function newCircleWithdrawal({ withdrawalId, circleId, beneficiaryPrismId, beneficiaryAccount, amount, proposalId }) {
  const now = new Date().toISOString();
  return {
    withdrawalId, circleId, beneficiaryPrismId, beneficiaryAccount,
    amount: String(amount), proposalId,
    status: CircleWithdrawalStatus.PROPOSED, transactionHash: null,
    createdAt: now, updatedAt: now
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/circle-withdrawal-math.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/circles/model.js backend/test/circle-withdrawal-math.test.js
git commit -m "Add CircleWithdrawal domain shape"
```

---

### Task 3: `withdrawablePreview` on circleService

Compute a member's withdrawable from COMPLETED contributions/withdrawals + the live Safe balance.

**Files:**
- Modify: `backend/src/services/circleService.js` (new method; import `withdrawal.js` + `newCircleWithdrawal`, `CircleWithdrawalStatus`)
- Test: `backend/test/circle-withdrawals.test.js` (create; use `./circles-harness.js`)

**Interfaces:**
- Consumes: `netContributions`, `withdrawableFor` (Task 1); store keys `circleContributions`, `circleWithdrawals` (new).
- Produces: `async withdrawablePreview({ circleId, memberPrismId }) -> { circleId, memberPrismId, netContributedAtomic: string, balanceAtomic: string, withdrawableAtomic: string }`.

Implementation notes: gather `Object.values(store.read().circleContributions ?? {}).filter(c => c.circleId === circleId)` and the same for `circleWithdrawals`; `net = netContributions(contribs, wds)`; `balance = await this.safe.getUsdcBalance(circle.safeAddress).catch(() => 0n)`; `withdrawable = withdrawableFor(memberPrismId, net, balance)`. Assert the actor is an ACTIVE member first (reuse existing membership check used by `circleMessageService`/`_spendableCircle`).

- [ ] **Step 1: Write the failing test** — seed two COMPLETED contributions (a:100, b:60) via `store.mutate`, stub `stack.circles.safe.getUsdcBalance` to return `160n`, assert `withdrawablePreview({circleId, memberPrismId: a})` returns `withdrawableAtomic === '100000000'`-style value; then set balance `40n` and assert it caps to `40`. (Model the harness setup on `circle-messages.test.js` `circleWithProposal`.)
- [ ] **Step 2: Run** `node --test test/circle-withdrawals.test.js` → FAIL (method undefined).
- [ ] **Step 3: Implement `withdrawablePreview`** per the notes above.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add withdrawablePreview to circleService"`.

---

### Task 4: `proposeWithdrawal` — capped payment to self

**Files:**
- Modify: `backend/src/services/circleService.js`
- Test: `backend/test/circle-withdrawals.test.js` (append)

**Interfaces:**
- Consumes: `withdrawablePreview` (Task 3); `_createProposal`, `ProposalKind.PAYMENT`, `_readAuthority`, `newCircleWithdrawal`.
- Produces: `async proposeWithdrawal({ circleId, memberPrismId, amountAtomic }) -> { proposal, withdrawalId }`.

Implementation notes:
- `const member = this._activeMember(circleId, memberPrismId)` (must be ACTIVE, must have `authorityAddress`/account).
- `const { withdrawableAtomic } = await this.withdrawablePreview({ circleId, memberPrismId })`; `const amount = this._assertAmount(amountAtomic)`; if `BigInt(amount) > BigInt(withdrawableAtomic)` throw `conflict('you can withdraw at most ' + withdrawableAtomic + ' base units')`.
- Create the proposal exactly like `proposePayment` but with `recipient = member account` (NO resolver — the member is a known Circle member), `kind: ProposalKind.PAYMENT`, and `payment.recipientPrismId = memberPrismId`. Add `withdrawal: { beneficiaryPrismId: memberPrismId }` to the proposal so the confirmation hook (Task 5) recognizes it.
- Write a `newCircleWithdrawal(...)` record (status PROPOSED) into `store.circleWithdrawals[withdrawalId]`, linked to `proposal.proposalId`.

- [ ] **Step 1: Failing test** — hostile: with withdrawable `100000000`, `proposeWithdrawal(amount: 100000001)` rejects; at `100000000` it succeeds and creates a PAYMENT proposal whose `payment.recipientAccount === member account` and a PROPOSED withdrawal record.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per notes.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add proposeWithdrawal (capped payment to the member's own account)"`.

---

### Task 5: Record the withdrawal on execution (ledger decrement)

When a withdrawal-tagged proposal reaches confirmed/COMPLETED, mark its `CircleWithdrawal` COMPLETED so `netContributions` drops. Re-assert the cap at execute time.

**Files:**
- Modify: `backend/src/services/circleService.js` (the payment reconcile/execute completion path — where a PAYMENT proposal becomes confirmed; search `CirclePaymentState.` completion / `_setPaymentState`/reconcile)
- Test: `backend/test/circle-withdrawals.test.js` (append)

**Interfaces:**
- Consumes: proposal `.withdrawal.beneficiaryPrismId`, the linked withdrawal record.
- Produces: side effect — on confirmation, `circleWithdrawals[withdrawalId].status = COMPLETED`, `transactionHash` set.

Implementation notes: at the point a Circle PAYMENT proposal is reconciled to confirmed, if `proposal.withdrawal` is set, find the withdrawal record by `proposalId`, set it `COMPLETED` with the tx hash. Guard: before execute, recompute `withdrawablePreview` and throw if the amount now exceeds it (a second pending withdrawal must not double-spend the ledger).

- [ ] **Step 1: Failing test** — propose withdrawal of full net; drive the proposal to confirmed via the harness's execute/reconcile path; assert the withdrawal record is COMPLETED and a *new* `withdrawablePreview` returns `0`. Then a second `proposeWithdrawal` of any positive amount rejects.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the confirmation hook + execute-time re-check.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Record Circle withdrawals on confirmation; re-check cap at execute"`.

---

### Task 6: Close-payout planner (pro-rata)

**Files:**
- Modify: `backend/src/services/circleService.js`
- Test: `backend/test/circle-withdrawals.test.js` (append)

**Interfaces:**
- Consumes: `netContributions`, `proRataPayouts` (Task 1); live balance.
- Produces:
  - `async planClosePayouts({ circleId }) -> { balanceAtomic, payouts: [{ prismId, account, amountAtomic }] }` (preview; writes nothing).
  - `async proposeClosePayouts({ circleId, actorPrismId }) -> { proposals: [...] }` (one `proposeWithdrawal`-style PAYMENT proposal per member with payout > 0; requires an admin actor; only in ACTIVE/CLOSING).

Implementation notes: `planClosePayouts` computes `proRataPayouts(net, balance)` and maps prismIds to member accounts. `proposeClosePayouts` iterates and creates a withdrawal proposal per member (reuse Task 4's proposal builder, skipping the per-member cap since the pro-rata amount is already ≤ net by construction — but still tag each as a withdrawal so Task 5 decrements ledgers). Do NOT auto-approve; admins approve each.

- [ ] **Step 1: Failing test** — net a:100/b:50/c:50, balance stub 100 → `planClosePayouts` returns payouts summing to 100 with a:50,b:25,c:25; shortfall case balance 80 → sums to 80; zero-net member excluded.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both methods.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add Circle close-payout planner (pro-rata) + proposal generation"`.

---

### Task 7: Server routes

**Files:**
- Modify: `backend/src/server.js` (near the other `/v1/circles/:id/...` routes, ~line 360-390)
- Test: exercised via `circle-withdrawals.test.js` service calls; optionally add an HTTP smoke like `universal-requests.test.js`.

**Interfaces (all `authRequired: true`):**
- `GET  /v1/circles/:id/withdrawable` → `circleService.withdrawablePreview({ circleId: params.id, memberPrismId: user.prismId })`
- `POST /v1/circles/:id/withdrawals` → `circleService.proposeWithdrawal({ circleId: params.id, memberPrismId: user.prismId, amountAtomic: String(body.amountAtomic) })`
- `GET  /v1/circles/:id/close/plan` → `circleService.planClosePayouts({ circleId: params.id })`
- `POST /v1/circles/:id/close/payouts` → `circleService.proposeClosePayouts({ circleId: params.id, actorPrismId: user.prismId })`

- [ ] **Step 1** Add the four routes following the existing `route('POST', '/v1/circles/:id/...', async ({ user, params, body }) => ..., true)` pattern.
- [ ] **Step 2** Run the full backend suite: `node --test test/*.test.js` → all pass (no regressions).
- [ ] **Step 3: Commit** `git commit -m "Add Circle withdrawal + close-payout routes"`.

---

### Task 8: iOS — Withdraw action & close preview

**Files:**
- Modify: `ios/Prism/Services/PrismAPI+Circles.swift` (API calls), `ios/Prism/Features/Circles/CircleDetailView.swift` (Withdraw action), the Circle close flow view (close preview).
- Create: `ios/Prism/Features/Circles/CircleWithdrawView.swift` (amount entry, shows withdrawable).

**Interfaces:**
- `PrismAPI.circleWithdrawable(circleId) async throws -> WithdrawableResponse { netContributedAtomic, balanceAtomic, withdrawableAtomic }`
- `PrismAPI.proposeCircleWithdrawal(circleId, amountAtomic) async throws -> CircleProposalResponse`
- `PrismAPI.circleClosePlan(circleId) async throws -> ClosePlanResponse { balanceAtomic, payouts: [{ prismId, account, amountAtomic }] }`

- [ ] **Step 1** Add the three API methods (mirror existing `PrismAPI+Circles.swift` calls; use the fixed query helper for any query strings).
- [ ] **Step 2** Add a "Withdraw" button in `CircleDetailView` (members with `withdrawableAtomic > 0`), presenting `CircleWithdrawView` (amount capped at withdrawable, calls `proposeCircleWithdrawal`, routes into the existing approval UI).
- [ ] **Step 3** In the close flow, call `circleClosePlan` and render each member's computed return before confirming; confirming calls `POST /close/payouts`.
- [ ] **Step 4** `cd ios && xcodegen generate` (only if files added), then build: `xcodebuild -project Prism.xcodeproj -scheme Prism -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_REQUIRED=NO build` → BUILD SUCCEEDED.
- [ ] **Step 5** Run the app in the simulator, verify Withdraw shows the correct ceiling and the close preview lists per-member returns.
- [ ] **Step 6: Commit** `git commit -m "iOS: Circle withdraw action and return-on-close preview"`.

---

## Self-Review

- **Spec coverage:** A(ledger)→Task1/3; B(withdraw flow)→Task4/5/7/8; C(close pro-rata)→Task1/6/7/8; D(invariants: cap at propose+execute)→Task4/5, money-truth (chain balance)→Task3/6; E(iOS)→Task8; F(tests)→Tasks1-6. All covered.
- **Placeholder scan:** Tasks 1-2 fully coded; Tasks 3-8 give exact methods, signatures, files, and runnable commands. Service/iOS steps describe concrete code against named, existing helpers (`_createProposal`, `circles-harness.js`, `PrismAPI+Circles.swift`).
- **Type consistency:** `netContributions`/`withdrawableFor`/`proRataPayouts` names + bigint returns consistent across Tasks 1,3,6. `CircleWithdrawalStatus.COMPLETED` is the status the ledger counts (Tasks 2,5). `withdrawablePreview` return shape reused verbatim in Tasks 4,7,8.
