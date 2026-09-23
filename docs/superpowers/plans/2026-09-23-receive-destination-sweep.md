# RECEIVE → Circle/Savings Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A request tagged "into my Circle/Savings" auto-deposits its funds into the Circle Safe / savings vault on settlement, using an authorization the requester pre-signed at request time.

**Architecture:** Non-custodial two-hop. The paid request lands in the requester's account (audited path, unchanged); a `SweepService` then submits a pre-signed authorization built at request time (CIRCLE → `circleService` contribution; SAVINGS → sub-project A's MockVault deposit). The sweep fires from the existing `markPaid` settlement hook and is retried on request-status read. Every sweep authorization is signed with `validBefore = request.expiresAt` so it is still valid whenever the payer eventually pays.

**Tech Stack:** Node.js ESM + `node:test` + viem (backend); SwiftUI (iOS). Branch `feat/receive-destination-sweep` off `feat/save-demo-foundation` (reuses A's MockVault + `demoSaveExecutor`).

## Global Constraints

- **Money-truth (INV-M1/M2):** balances/positions are on-chain reads, never fabricated; no optimistic credit at the destination.
- **Non-custodial:** funds move only with the requester's own exact-amount signature; the relayer only relays.
- **Safe fallback:** a failed sweep leaves the received funds in the requester's primary account — never lost, never faked. Surface honestly ("received in your balance; couldn't auto-move to <destination>").
- **Idempotent:** at most one submit per sweep — on-chain ERC-3009 nonce single-use + a `sweep.state` guard (`PREPARING → PENDING → SUBMITTED → SWEPT | FAILED`).
- **Validity window:** every sweep authorization is signed with `validBefore = request.expiresAt` (unix seconds), NOT the short interactive windows (`prepareExternalSend` uses `AUTH_WINDOW_SECONDS`; demo Save quote uses 300s). The persisted record carries the same value so the settlement-time submit's expiry check passes.
- **Live vs demo:** CIRCLE sweep = live Safe contribution; SAVINGS sweep = A's demo MockVault (label SAVINGS as demo in the UI). SAVINGS requires `SAVE_MODE=demo`.
- **Commit rules:** NO Claude/Anthropic attribution in commit messages. Run `xcodegen generate` after adding/removing Swift files. Broadcast artifacts never committed.
- **Test commands:** backend `cd backend && npm test`; iOS `cd ios && xcodegen generate && xcodebuild -project Prism.xcodeproj -scheme Prism -destination 'platform=iOS Simulator,name=iPhone 17' build`.

---

## Phase 1 — Backend: validity override + sweep prepare/commit

### Task 1: `validBefore` override on the external-send + contribution prepare

**Files:**
- Modify: `backend/src/services/paymentService.js` (`prepareExternalSend`, ~line 150)
- Modify: `backend/src/services/circleService.js` (`prepareContribution`, ~line 947)
- Test: `backend/test/sweep.test.js` (new)

**Interfaces:**
- Produces: `prepareExternalSend({ senderPrismId, recipientAddress, amountAtomic, boundHash, kind, intent, validBefore? })` — when `validBefore` (unix seconds) is passed, the ERC-3009 token authorization uses it instead of `now + AUTH_WINDOW_SECONDS`; default unchanged. `prepareContribution({ circleId, prismId, amountAtomic, validBefore? })` threads it through.

- [ ] **Step 1: Write the failing test** — `backend/test/sweep.test.js`

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';

function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-sweep-')), 'store.json')); }

test('prepareExternalSend honors an explicit validBefore', async () => {
  const { PaymentService } = await import('../src/services/paymentService.js');
  const store = tmpStore();
  const identityService = { get: () => ({ prismId: 'p1', accountAddress: '0x00000000000000000000000000000000000000A1', account: '0x00000000000000000000000000000000000000A1', aliasVersion: 1 }) };
  const config = (await import('../src/config.js')).config;
  const svc = new PaymentService({ store, config, identityService });
  const far = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const prepared = await svc.prepareExternalSend({
    senderPrismId: 'p1', recipientAddress: '0x000000000000000000000000000000000000dEaD',
    amountAtomic: '1000000', boundHash: '0x' + '00'.repeat(32), kind: 'sweep-test', validBefore: far
  });
  // The prepared authorization must carry the far deadline, not now+AUTH_WINDOW.
  assert.equal(Math.floor(Date.parse(prepared.expiresAt) / 1000), far);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/sweep.test.js`. Expected: FAIL (expiresAt is `now + AUTH_WINDOW_SECONDS`, not `far`).

- [ ] **Step 3: Edit `prepareExternalSend`** — accept `validBefore`:

```javascript
  async prepareExternalSend({ senderPrismId, recipientAddress, amountAtomic, boundHash, kind, intent = {}, validBefore = null }) {
```
Then replace the internal `const validBefore = Math.floor(Date.now() / 1000) + AUTH_WINDOW_SECONDS;` with a renamed local that respects the override:
```javascript
    const authValidBefore = validBefore ?? (Math.floor(Date.now() / 1000) + AUTH_WINDOW_SECONDS);
```
and use `authValidBefore` everywhere the old `validBefore` local was used (the typed-data build, the stored record, and `expiresAt: new Date(authValidBefore * 1000).toISOString()`). Do NOT rename the parameter usage; only the internal deadline computation changes.

- [ ] **Step 4: Edit `prepareContribution`** — accept + thread `validBefore`:
```javascript
  async prepareContribution({ circleId, prismId, amountAtomic, validBefore = null }) {
```
and pass it into the `this.payments.prepareExternalSend({ ... })` call: add `validBefore` to that object.

- [ ] **Step 5: Run to verify it passes** — `cd backend && node --test test/sweep.test.js`. Expected: PASS. Then `npm test` — no regressions (default behavior unchanged).

- [ ] **Step 6: Commit**
```bash
git add backend/src/services/paymentService.js backend/src/services/circleService.js backend/test/sweep.test.js
git commit -m "Allow explicit validBefore on external-send + contribution prepare"
```

### Task 2: SweepService — build the pre-signed authorization

**Files:**
- Create: `backend/src/services/sweepService.js`
- Test: add to `backend/test/sweep.test.js`

**Interfaces:**
- Consumes: `circleService.prepareContribution({ circleId, prismId, amountAtomic, validBefore })` → `{ typedData: { envelope, tokenAuthorization }, contribution: { contributionId }, ... }` (the `prepared` fields include the payment `typedData`; `contribution.contributionId` is the preparedId); `saveService` demo quote path; `receiveAuthorizationTypedData` from `../chain/eth.js`; `randomHex` from `../lib/crypto.js`; the store.
- Produces: `SweepService` with:
  - `async prepareForDraft(request) -> sweep|null` — for a CIRCLE/SAVINGS request, builds the authorization with `validBefore = Math.floor(Date.parse(request.expiresAt)/1000)`, persists `request.sweep = { destination, circleId, preparedId, state: 'PREPARING', createdAt }`, and returns `{ destination, preparedId, authorization }` where `authorization` is the typed data to sign (CIRCLE: `{ envelope, tokenAuthorization }`; SAVINGS: a single ERC-3009 typed data). Returns `null` for PRIMARY.
  - `async attachSignatures({ requestId, requesterPrismId, sweepSignatures }) -> sweep` — validates the request is owned + has a PREPARING sweep, stores signatures, transitions to `PENDING`.

- [ ] **Step 1: Write the failing test** — append to `backend/test/sweep.test.js`

```javascript
test('SweepService.prepareForDraft builds a CIRCLE contribution authorization with far validBefore', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  const request = { requestId: 'req_1', requesterPrismId: 'p1', amountAtomic: '1000000', destination: 'CIRCLE', circleId: 'circle_1', expiresAt };
  store.mutate((d) => { d.requests = { req_1: request }; });
  let seenValidBefore = null;
  const circleService = {
    prepareContribution: async ({ circleId, prismId, amountAtomic, validBefore }) => {
      seenValidBefore = validBefore;
      return { typedData: { envelope: { primaryType: 'X' }, tokenAuthorization: { primaryType: 'ReceiveWithAuthorization' } }, contribution: { contributionId: 'ctb_1' } };
    }
  };
  const svc = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });
  const sweep = await svc.prepareForDraft(store.read().requests.req_1);
  assert.equal(sweep.destination, 'CIRCLE');
  assert.equal(sweep.preparedId, 'ctb_1');
  assert.equal(seenValidBefore, Math.floor(Date.parse(expiresAt) / 1000));
  assert.ok(sweep.authorization.tokenAuthorization, 'returns signable contribution typed data');
  assert.equal(store.read().requests.req_1.sweep.state, 'PREPARING');
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/sweep.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Write `backend/src/services/sweepService.js`**

```javascript
import { getAddress } from 'viem';
import { receiveAuthorizationTypedData } from '../chain/eth.js';
import { randomHex } from '../lib/crypto.js';

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

// SweepService — the second hop of a RECEIVE→Circle/Savings request. It builds the authorization the
// requester pre-signs at request time (validBefore = request expiry), stores it PENDING on the request,
// and — on settlement — relays it into the Circle Safe (live contribution) or the demo MockVault
// (SAVINGS). Non-custodial: the relayer only relays a signature the requester already made.
export class SweepService {
  constructor({ store, circleService, saveService, config, demoSaveExecutor = null, identityService = null }) {
    this.store = store;
    this.circles = circleService;
    this.saves = saveService;
    this.saveExecutor = demoSaveExecutor;
    this.identities = identityService;
    this.config = config;
  }

  _validBefore(request) { return Math.floor(Date.parse(request.expiresAt) / 1000); }

  async prepareForDraft(request) {
    const dest = request.destination ?? 'PRIMARY';
    if (dest === 'PRIMARY') return null;
    const validBefore = this._validBefore(request);

    if (dest === 'CIRCLE') {
      if (!request.circleId) throw httpError(400, 'circleId is required for a CIRCLE request');
      const prepared = await this.circles.prepareContribution({
        circleId: request.circleId, prismId: request.requesterPrismId, amountAtomic: request.amountAtomic, validBefore
      });
      const sweep = { destination: 'CIRCLE', circleId: request.circleId, preparedId: prepared.contribution.contributionId, state: 'PREPARING', createdAt: new Date().toISOString() };
      this.store.mutate((d) => { d.requests[request.requestId].sweep = sweep; });
      return { destination: 'CIRCLE', preparedId: sweep.preparedId, authorization: { envelope: prepared.typedData.envelope, tokenAuthorization: prepared.typedData.tokenAuthorization } };
    }

    if (dest === 'SAVINGS') {
      if (this.config.save.mode !== 'demo') throw httpError(503, 'SAVINGS destination requires demo Save');
      const account = getAddress(this.identities.get(request.requesterPrismId).accountAddress);
      const vault = getAddress(this.config.save.mockVault);
      const nonce = randomHex(32);
      const authorization = receiveAuthorizationTypedData({ from: account, to: vault, value: String(request.amountAtomic), validAfter: 0, validBefore, nonce });
      const quoteId = `sweep_${randomHex(16).slice(2)}`;
      // Persist a saveQuotes record demoSaveExecutor.submitDeposit can consume at settlement.
      this.store.mutate((d) => {
        d.saveQuotes ??= {};
        d.saveQuotes[quoteId] = { quoteId, kind: 'SAVE', prismId: request.requesterPrismId, account, amountAtomic: String(request.amountAtomic), vault, nonce, deadline: validBefore, minimumShares: null, estimatedShares: null, createdAt: new Date().toISOString() };
        const sweep = { destination: 'SAVINGS', preparedId: quoteId, state: 'PREPARING', createdAt: new Date().toISOString() };
        d.requests[request.requestId].sweep = sweep;
      });
      return { destination: 'SAVINGS', preparedId: quoteId, authorization };
    }
    throw httpError(400, `unknown destination '${dest}'`);
  }

  async attachSignatures({ requestId, requesterPrismId, sweepSignatures }) {
    return this.store.mutate((d) => {
      const r = d.requests[requestId];
      if (!r || r.requesterPrismId !== requesterPrismId) throw httpError(404, 'request not found');
      if (!r.sweep || r.sweep.state !== 'PREPARING') throw httpError(409, 'no sweep awaiting signatures');
      r.sweep.signatures = sweepSignatures;
      r.sweep.state = 'PENDING';
      return r.sweep;
    });
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `cd backend && node --test test/sweep.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/sweepService.js backend/test/sweep.test.js
git commit -m "Add SweepService: build pre-signed sweep authorization at request time"
```

### Task 3: Wire sweep into the request draft + commit routes

**Files:**
- Modify: `backend/src/server.js` (`/v1/requests/draft`, `/v1/requests/commit`, construct `SweepService`)
- Test: add to `backend/test/sweep.test.js`

**Interfaces:**
- Consumes: `SweepService.prepareForDraft`, `SweepService.attachSignatures` (Task 2).
- Produces: `POST /v1/requests/draft` returns `{ request, signable, sweep? }` (sweep present for CIRCLE/SAVINGS). `POST /v1/requests/commit` accepts `{ requestId, signature, sweepSignatures? }` and, when a PREPARING sweep exists, calls `attachSignatures`.

- [ ] **Step 1: Construct SweepService in server.js** — near the other service constructions:
```javascript
import { SweepService } from './services/sweepService.js';
const sweepService = new SweepService({ store, circleService, saveService, config, demoSaveExecutor, identityService });
```
(Reuse the already-constructed `circleService`, `saveService`, `demoSaveExecutor` from A; confirm those variable names exist in server.js and match.)

- [ ] **Step 2: Extend the draft route** — replace the existing `/v1/requests/draft` handler so it also builds the sweep:
```javascript
route('POST', '/v1/requests/draft', async ({ user, body }) => {
  const drafted = requestService.draft({ ...body, payerPrismId: body.payerPrismId ?? null, requesterPrismId: user.prismId });
  const sweep = await sweepService.prepareForDraft(drafted.request);
  return sweep ? { ...drafted, sweep } : drafted;
}, true);
```

- [ ] **Step 3: Extend the commit route**:
```javascript
route('POST', '/v1/requests/commit', async ({ user, body }) => {
  const committed = await requestService.commit({ ...body, requesterPrismId: user.prismId });
  if (body.sweepSignatures) {
    await sweepService.attachSignatures({ requestId: body.requestId, requesterPrismId: user.prismId, sweepSignatures: body.sweepSignatures });
  }
  return committed;
}, true);
```

- [ ] **Step 4: Write an integration-style test** — append to `backend/test/sweep.test.js` a test that drafts a CIRCLE request through `requestService.draft` + `sweepService.prepareForDraft`, then `sweepService.attachSignatures`, and asserts `store.read().requests[id].sweep.state === 'PENDING'` with the stored signatures. (Use the fake `circleService` from Task 2's test.)

- [ ] **Step 5: Run tests** — `cd backend && node --test test/sweep.test.js` then `npm test`. Expected: PASS, no regressions.

- [ ] **Step 6: Commit**
```bash
git add backend/src/server.js backend/test/sweep.test.js
git commit -m "Return + store sweep authorization through request draft/commit"
```

---

## Phase 2 — Backend: settlement execution

### Task 4: SweepService.executeFor — CIRCLE

**Files:**
- Modify: `backend/src/services/sweepService.js`
- Test: add to `backend/test/sweep.test.js`

**Interfaces:**
- Consumes: `circleService.submitContribution({ circleId, contributionId, prismId, prismSignature, tokenSignature }) -> { state, txHash }`.
- Produces: `async executeFor(requestId) -> { state }` — no-op unless `request.sweep.state === 'PENDING'`; transitions `PENDING → SUBMITTED` (single-flight), submits, then `SWEPT` (confirmed) or `FAILED` (throw/revert), recording the tx hash. Safe to call repeatedly (returns early when not PENDING).

- [ ] **Step 1: Write the failing test** — append to `backend/test/sweep.test.js`

```javascript
test('executeFor submits a PENDING CIRCLE sweep exactly once (idempotent)', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_1: { requestId: 'req_1', requesterPrismId: 'p1', circleId: 'circle_1', sweep: { destination: 'CIRCLE', circleId: 'circle_1', preparedId: 'ctb_1', state: 'PENDING', signatures: { prismSignature: '0xaa', tokenSignature: '0xbb' } } } }; });
  let calls = 0;
  const circleService = { submitContribution: async () => { calls++; return { state: 'confirming', txHash: '0xctb' }; } };
  const svc = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });
  const r1 = await svc.executeFor('req_1');
  const r2 = await svc.executeFor('req_1'); // second call must NOT resubmit
  assert.equal(calls, 1);
  assert.ok(['SUBMITTED', 'SWEPT'].includes(store.read().requests.req_1.sweep.state));
  assert.equal(store.read().requests.req_1.sweep.transactionHash, '0xctb');
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/sweep.test.js`. Expected: FAIL (`executeFor` not a function).

- [ ] **Step 3: Add `executeFor` (+ CIRCLE adapter) to `sweepService.js`**

```javascript
  async executeFor(requestId) {
    const r = (this.store.read().requests ?? {})[requestId];
    if (!r?.sweep || r.sweep.state !== 'PENDING') return { state: r?.sweep?.state ?? 'NONE' };
    // Single-flight: claim the sweep before any await so a concurrent/repeated call can't double-submit.
    this.store.mutate((d) => { d.requests[requestId].sweep.state = 'SUBMITTED'; d.requests[requestId].sweep.submittedAt = new Date().toISOString(); });
    try {
      const txHash = await this._submit(r);
      this.store.mutate((d) => { const s = d.requests[requestId].sweep; s.state = 'SWEPT'; s.transactionHash = txHash; s.sweptAt = new Date().toISOString(); });
      return { state: 'SWEPT', transactionHash: txHash };
    } catch (err) {
      // Safe fallback: the money stays in the requester's primary account. Never lost, never faked.
      this.store.mutate((d) => { const s = d.requests[requestId].sweep; s.state = 'FAILED'; s.failure = String(err?.message ?? 'sweep failed'); });
      return { state: 'FAILED' };
    }
  }

  async _submit(r) {
    if (r.sweep.destination === 'CIRCLE') {
      const result = await this.circles.submitContribution({
        circleId: r.sweep.circleId, contributionId: r.sweep.preparedId, prismId: r.requesterPrismId,
        prismSignature: r.sweep.signatures.prismSignature, tokenSignature: r.sweep.signatures.tokenSignature
      });
      return result.txHash ?? result.transactionHash ?? null;
    }
    if (r.sweep.destination === 'SAVINGS') {
      const result = await this.saveExecutor.submitDeposit({ prismId: r.requesterPrismId, quoteId: r.sweep.preparedId, signature: r.sweep.signatures.signature });
      return result.txHash ?? null;
    }
    throw httpError(400, `unknown sweep destination '${r.sweep.destination}'`);
  }
```

- [ ] **Step 4: Run to verify it passes** — `cd backend && node --test test/sweep.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/sweepService.js backend/test/sweep.test.js
git commit -m "Add SweepService.executeFor with idempotent CIRCLE settlement"
```

### Task 5: executeFor — SAVINGS + failure fallback test

**Files:**
- Modify: `backend/src/services/sweepService.js` (SAVINGS branch already added in Task 4's `_submit`; this task proves it + the failure path)
- Test: add to `backend/test/sweep.test.js`

**Interfaces:**
- Consumes: `demoSaveExecutor.submitDeposit({ prismId, quoteId, signature }) -> { txHash, state }` (from sub-project A).

- [ ] **Step 1: Write the failing/【covering】tests** — append to `backend/test/sweep.test.js`

```javascript
test('executeFor submits a SAVINGS sweep via the demo Save executor', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_2: { requestId: 'req_2', requesterPrismId: 'p1', sweep: { destination: 'SAVINGS', preparedId: 'sweep_q1', state: 'PENDING', signatures: { signature: '0xcc' } } } }; });
  const demoSaveExecutor = { submitDeposit: async ({ quoteId }) => ({ txHash: '0xsave', state: 'SAVED', operationId: 'op1' }) };
  const svc = new SweepService({ store, circleService: null, saveService: null, demoSaveExecutor, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_2');
  assert.equal(res.state, 'SWEPT');
  assert.equal(store.read().requests.req_2.sweep.transactionHash, '0xsave');
});

test('a failed sweep marks FAILED and leaves the request intact (funds stay in primary)', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_3: { requestId: 'req_3', requesterPrismId: 'p1', sweep: { destination: 'SAVINGS', preparedId: 'q', state: 'PENDING', signatures: { signature: '0x' } } } }; });
  const demoSaveExecutor = { submitDeposit: async () => { throw new Error('quote expired'); } };
  const svc = new SweepService({ store, circleService: null, saveService: null, demoSaveExecutor, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_3');
  assert.equal(res.state, 'FAILED');
  assert.equal(store.read().requests.req_3.sweep.state, 'FAILED');
  assert.match(store.read().requests.req_3.sweep.failure, /quote expired/);
});
```

- [ ] **Step 2: Run** — `cd backend && node --test test/sweep.test.js`. Expected: PASS (the SAVINGS branch + failure handling were implemented in Task 4). If SAVINGS fails, fix `_submit`'s SAVINGS branch.

- [ ] **Step 3: Commit**
```bash
git add backend/test/sweep.test.js
git commit -m "Cover SAVINGS sweep + failed-sweep safe fallback"
```

### Task 6: Fire the sweep from the settlement hook

**Files:**
- Modify: `backend/src/services/paymentService.js` (~line 595, the `markPaid` call site; constructor)
- Modify: `backend/src/server.js` (wire the callback)
- Test: add to `backend/test/sweep.test.js`

**Interfaces:**
- Produces: `PaymentService` constructor accepts `onRequestPaid?` (a `(requestId) => void|Promise`); after `markPaid` on a completed request payment it calls `this.onRequestPaid?.(requestId)` best-effort (never throws into the payer's flow). server.js wires `onRequestPaid: (requestId) => sweepService.executeFor(requestId).catch(() => {})`.

- [ ] **Step 1: Write the failing test** — append to `backend/test/sweep.test.js`

```javascript
test('PaymentService calls onRequestPaid after markPaid on a completed request payment', async () => {
  const { PaymentService } = await import('../src/services/paymentService.js');
  const store = tmpStore();
  const identityService = { get: () => ({ prismId: 'p1', accountAddress: '0x00000000000000000000000000000000000000A1' }) };
  const config = (await import('../src/config.js')).config;
  let paidWith = null;
  const requestService = { markPaid: () => {} };
  const svc = new PaymentService({ store, config, identityService, requestService, onRequestPaid: (id) => { paidWith = id; } });
  // Drive the private completion path used at paymentService.js:595 (adjust the helper name to the real one).
  svc._onPaymentCompleted?.({ kind: 'payment', operationId: 'op1', intent: { requestId: 'req_9' }, transactionHash: '0xtx' });
  assert.equal(paidWith, 'req_9');
});
```
> Note: the exact private method that contains line 595 must be located by the implementer (read paymentService.js around 595). If it is inline in a larger reconcile/poll method, expose the hook call at that exact spot instead of via `_onPaymentCompleted`, and adjust this test to drive that method. The assertion (onRequestPaid called with the requestId) is the contract.

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/sweep.test.js`. Expected: FAIL (onRequestPaid not called / not accepted).

- [ ] **Step 3: Edit `paymentService.js`** — add `onRequestPaid` to the constructor destructure and store `this.onRequestPaid = onRequestPaid ?? null;`. At line ~595, right after the existing `this.requestService.markPaid(record.intent.requestId, record.operationId, tx);`, add:
```javascript
      // Second hop: if this request was tagged into a Circle/Savings, sweep it now. Best-effort —
      // a sweep failure must never affect the payer's settlement (the money is already delivered).
      if (this.onRequestPaid) { try { const p = this.onRequestPaid(record.intent.requestId); if (p && typeof p.then === 'function') p.catch(() => {}); } catch { /* swallow */ } }
```

- [ ] **Step 4: Wire the callback in `server.js`** — where `paymentService` is constructed, add `onRequestPaid: (requestId) => sweepService.executeFor(requestId).catch(() => {})`. NOTE: `sweepService` is constructed after `paymentService` today; to avoid a use-before-def, either (a) construct `sweepService` before `paymentService`, or (b) pass `onRequestPaid: (id) => sweepService.executeFor(id).catch(() => {})` as an arrow that captures `sweepService` by closure and is only invoked later (safe even if defined below, since it's called at settlement time, not construction). Prefer (b) — verify `sweepService` is in scope at call time.

- [ ] **Step 5: Run tests** — `cd backend && node --test test/sweep.test.js` then `npm test`. Expected: PASS, no regressions.

- [ ] **Step 6: Commit**
```bash
git add backend/src/services/paymentService.js backend/src/server.js backend/test/sweep.test.js
git commit -m "Fire the destination sweep from the request settlement hook"
```

### Task 7: Request-status read retries a PENDING sweep

**Files:**
- Modify: `backend/src/server.js` (add `GET /v1/requests/:requestId`)
- Modify: `backend/src/services/requestService.js` (add `getOwn(requestId, prismId)` returning the request incl. a public `sweep` view)
- Test: add to `backend/test/sweep.test.js`

**Interfaces:**
- Produces: `GET /v1/requests/:requestId` (auth) → the requester's own request with `sweep: { state, destination, transactionHash?, failure? }`; before returning, if `sweep.state === 'PENDING'` it calls `sweepService.executeFor(requestId)` so a sweep missed at settlement is retried on read. `requestService.getOwn(requestId, prismId)` returns the stored request or 404 if not owned.

- [ ] **Step 1: Write the failing test** — append to `backend/test/sweep.test.js` a test that seeds a PENDING CIRCLE sweep + a fake `sweepService.executeFor` that flips it to SWEPT, calls the `getOwn` + retry logic (extract it into a small server-independent helper or test `requestService.getOwn` plus a direct `executeFor`), and asserts the returned/stored state is SWEPT. (Keep it a unit test on `requestService.getOwn` + `sweepService.executeFor`; the route is thin glue.)

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/sweep.test.js`. Expected: FAIL (`getOwn` not a function).

- [ ] **Step 3: Add `getOwn` to `requestService.js`**
```javascript
  getOwn(requestId, prismId) {
    const r = this.store.read().requests[requestId];
    if (!r || r.requesterPrismId !== prismId) { const e = new Error('request not found'); e.statusCode = 404; throw e; }
    const sweep = r.sweep ? { state: r.sweep.state, destination: r.sweep.destination, transactionHash: r.sweep.transactionHash ?? null, failure: r.sweep.failure ?? null } : null;
    return { requestId: r.requestId, status: r.status, amountAtomic: r.amountAtomic, destination: r.destination ?? 'PRIMARY', sweep };
  }
```

- [ ] **Step 4: Add the route in `server.js`**
```javascript
route('GET', '/v1/requests/:requestId', async ({ user, params }) => {
  const view = requestService.getOwn(params.requestId, user.prismId);
  if (view.sweep?.state === 'PENDING') { await sweepService.executeFor(params.requestId).catch(() => {}); return requestService.getOwn(params.requestId, user.prismId); }
  return view;
}, true);
```

- [ ] **Step 5: Run tests** — `cd backend && node --test test/sweep.test.js` then `npm test`. Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add backend/src/services/requestService.js backend/src/server.js backend/test/sweep.test.js
git commit -m "Add GET /v1/requests/:id that retries a pending sweep on read"
```

---

## Phase 3 — iOS

### Task 8: iOS models + API for destination + sweep

**Files:**
- Modify: the request models + `ios/Prism/Services/PrismAPI.swift` (find the request draft/commit methods: `grep -rn "requests/draft\|requests/commit\|func .*[Rr]equest" ios/Prism/Services`)
- Test: iOS build

**Interfaces:**
- Produces: request draft response gains an optional `sweep` (`{ destination: String, preparedId: String, authorization: JSONValue }`); the commit body gains optional `sweepSignatures`. `RequestDestination` enum (`primary/circle/savings`). A `RequestStatusView` decode with `sweep: { state, destination, transactionHash?, failure? }`. Reuse the `JSONValue` type (Prism/Models/PrismModels.swift) for `authorization`, exactly as sub-project A did for Save.

- [ ] **Step 1: Add the models** — mirror sub-project A's Task 9: add optional decodes for the draft `sweep` (with `authorization: JSONValue`), the commit body's `sweepSignatures` (a small Encodable: CIRCLE `{ prismSignature, tokenSignature }` or SAVINGS `{ signature }` — model as all-optional fields), and a `requestStatus(requestId:)` GET method returning the `sweep` state. Keep existing request calls working (new fields optional).

- [ ] **Step 2: Build** — `cd ios && xcodegen generate && xcodebuild ... build`. Expected: BUILD SUCCEEDED. (Cross-file SourceKit "cannot find type" are false positives — trust xcodebuild.)

- [ ] **Step 3: Commit**
```bash
git add ios/Prism/Models ios/Prism/Services/PrismAPI.swift ios/Prism.xcodeproj
git commit -m "Add request destination + sweep authorization iOS models/API"
```

### Task 9: iOS request-creation destination picker + sign sweep

**Files:**
- Modify: the request-creation view (find it: `grep -rln "requests/draft\|Request money\|RequestView\|New request" ios/Prism/Features`)
- Test: iOS build

**Interfaces:**
- Consumes: the draft (returns `sweep.authorization`), the Mera signer (`MeraAccountManager.shared.beginSession(.payments)` + `signTypedDataHex(_ data: Data)`), commit with `sweepSignatures`. For CIRCLE, sign BOTH `authorization.envelope` and `authorization.tokenAuthorization` (→ `{ prismSignature, tokenSignature }`); for SAVINGS, sign the single `authorization` (→ `{ signature }`). Encode each JSONValue with `.jsonData()` (extension in PrismModels.swift:158), exactly as A's SaveView does.

- [ ] **Step 1: Add a destination picker** (Primary / Circle / Savings) to the request-creation flow. When Circle is chosen, pick which Circle (reuse the existing Circle list). SAVINGS shows a "Demo — deposits into your testnet savings" note. Persist the choice into the draft body (`destination`, `circleId`).

- [ ] **Step 2: Sign the sweep on commit** — after drafting, if `draft.sweep != nil`:
```swift
let mera = MeraAccountManager.shared
try await mera.beginSession(.payments)
var sweepSigs = SweepSignaturesBody()
if draft.sweep!.destination == "CIRCLE" {
  sweepSigs.prismSignature = try await mera.signTypedDataHex(draft.sweep!.authorization.envelope!.jsonData())
  sweepSigs.tokenSignature = try await mera.signTypedDataHex(draft.sweep!.authorization.tokenAuthorization!.jsonData())
} else { // SAVINGS
  sweepSigs.signature = try await mera.signTypedDataHex(draft.sweep!.authorization.jsonData())
}
```
Then sign the request itself (existing path) and call commit with both the request signature and `sweepSignatures`. Match the exact envelope/tokenAuthorization shape from the backend `authorization` object (the CIRCLE authorization is `{ envelope, tokenAuthorization }`; adjust the Swift model so those are `JSONValue?`).

- [ ] **Step 3: Build** — `cd ios && xcodebuild ... build`. Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**
```bash
git add ios/Prism/Features
git commit -m "Request-creation destination picker + pre-sign the sweep authorization"
```

### Task 10: iOS request surface shows sweep intent + state

**Files:**
- Modify: the request detail / list surface (where a created request is shown)
- Test: iOS build

- [ ] **Step 1: Show intent + state** — on a request with a destination, show "Auto-deposits into <Circle name>/Savings when paid" (SAVINGS labeled demo). Poll `requestStatus(requestId:)` to reflect the sweep `state`: PENDING → "will deposit on payment"; SWEPT → "deposited into <destination>"; FAILED → honest fallback "Received in your balance — couldn't auto-move to <destination>." Never claim deposited unless `state == "SWEPT"`.

- [ ] **Step 2: Build** — `cd ios && xcodebuild ... build`. Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**
```bash
git add ios/Prism/Features
git commit -m "Show request sweep intent + honest state (pending/swept/failed)"
```

### Task 11: End-to-end smoke + close-out

**Files:** none (verification)

- [ ] **Step 1:** Backend in demo mode (`SAVE_MODE=demo`, `SAVE_MOCK_VAULT` set, MockVault deployed per sub-project A) + a Circle with the requester as a member.
- [ ] **Step 2: CIRCLE smoke** — create a request into a Circle → confirm two signatures collected → have the payer pay it → confirm the funds sweep into the Circle Safe (Circle balance rises) and the request shows "deposited".
- [ ] **Step 3: SAVINGS smoke** — create a request into Savings → pay it → confirm the funds land as vault shares (Savings position rises) and the request shows "deposited"; then force a failure (e.g. expire the authorization) and confirm the FAILED fallback shows funds in primary.
- [ ] **Step 4: Full pass** — `cd backend && npm test` (all green incl. sweep.test.js), `cd ios && xcodebuild ... build` (BUILD SUCCEEDED).

---

## Self-Review

**Spec coverage:**
- Pre-signed authorization at request time (§1) → Tasks 1–3. Validity window = expiresAt → Task 1 (override) + Task 2 (uses it).
- SweepService + settlement execution (§2) → Tasks 4–6. Retry-on-read → Task 7.
- Money-truth / safe fallback / idempotency (§3) → Task 4 (single-flight + FAILED fallback), Task 5 (failure test), Task 6 (best-effort, never affects payer).
- iOS destination picker + signing + honest state (§4) → Tasks 8–10.
- Testing (§5) → per-task + Task 11.

**Placeholder scan:** No TBD/TODO. Task 6's private-method name and Task 8/9/10's exact iOS file paths are "locate and match" instructions pointing at real code (the private completion method around paymentService.js:595; the request-creation view) — not invented APIs. Task 7's test is described rather than coded because it is thin glue over `getOwn` + `executeFor` which are fully coded; the covering assertion is stated.

**Type consistency:** `sweep` record shape (`destination, circleId?, preparedId, state, signatures, transactionHash, failure`) is written in Task 2/4 and read in Tasks 4/7. `prepareForDraft` returns `{ destination, preparedId, authorization }` (Task 2) consumed by Task 3 route + Task 9 iOS. `executeFor(requestId) -> { state }` defined Task 4, called Tasks 6/7. `onRequestPaid(requestId)` defined Task 6. `submitContribution`/`submitDeposit` shapes match the real services (verified against circleService.js / demoSaveExecutor.js).

**Open items the implementer confirms (not blockers):** the exact private method containing `paymentService.js:595` (Task 6); the exact `prepareContribution` return field names for the envelope/tokenAuthorization typed data (Task 2 — read the `prepared`/`typedData` shape and match); the iOS request-creation view path (Tasks 9–10).
