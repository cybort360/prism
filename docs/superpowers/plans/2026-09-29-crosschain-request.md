# Cross-chain Payment Request — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone pay a Prism payment-request link from any chain via Aurora Intents — no Prism app, no Monad funds — landing USDC in the requester's Monad account (and Circle/Savings sweep).

**Architecture:** A standalone `apps/pay-web` Vite+React page drives an unauthenticated backend seam (`crossChainPayService`) with two routes: a real Aurora dry-run **quote** and a **fulfill** that verifies the payer's wallet signature, mints USDC to the requester (simulated arrival, real credit), marks the request PAID, and fires the requester's pre-signed sweep. Reuses the existing public-request view, the demo-mint path, and `sweepService`.

**Tech Stack:** Backend — Node (no framework), `viem`, `node:test`. Web — Vite + React + TypeScript, `wagmi` + `viem`.

## Global Constraints

- **Money-truth (INV-M1/M2):** never fabricate a number; the credit is a real on-chain mint the balance reads. Only the cross-chain *arrival* is simulated.
- **Settlement gate:** the fulfill mint runs only when `AURORA_MODE=demo`. The **quote** is always a real Aurora dry-run (call `auroraApiClient` directly — the active client is the demo stub in demo mode and returns `null`).
- **Payer cannot alter** amount / recipient / destination — all read from the stored request, never the request body.
- **One payment per request:** replay protection is the `OPEN → PAID` transition; the signed message is bound to the unique `requestId`.
- **CORS:** open only the public + `/v1/pay/*` routes to `PAY_WEB_ORIGIN`; the authenticated API stays same-origin.
- Existing test command: `node --test` in `backend/`. Full suite must stay green (currently 531 pass).
- Commit rules (repo): NO Claude/Anthropic attribution in commit messages.

---

## Task 1: Extract `mintUsdcTo` chain helper

Shared on-chain USDC mint (relayer → account), so both the Aurora receive flow and the new fulfill reuse one implementation.

**Files:**
- Modify: `backend/src/chain/eth.js` (add `mintUsdcTo`)
- Modify: `backend/src/services/auroraService.js:255-259` (use the helper)
- Test: `backend/test/mint-usdc.test.js` (create)

**Interfaces:**
- Produces: `mintUsdcTo(account: string, amountAtomic: string|bigint) => Promise<string>` (returns tx hash). Uses `chainProvider().writeContract` with the MockUSDC `mint(address,uint256)` ABI against `config.chain.usdc`.

- [ ] **Step 1: Write the failing test**

```js
// backend/test/mint-usdc.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { setChainProvider, resetChainProvider } from '../src/providers/index.js';
import { mintUsdcTo } from '../src/chain/eth.js';

test('mintUsdcTo calls MockUSDC.mint(to, amount) via the relayer and returns the tx hash', async (t) => {
  let seen;
  setChainProvider({ writeContract: async (args) => { seen = args; return '0xmint'; } });
  t.after(resetChainProvider);
  const tx = await mintUsdcTo('0x9226D56F93A3Fe4E78795BBaC1aecfF61E6A28F1', '20000000');
  assert.equal(tx, '0xmint');
  assert.equal(seen.functionName, 'mint');
  assert.equal(seen.args[1], 20000000n); // amount coerced to bigint
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/mint-usdc.test.js`
Expected: FAIL — `mintUsdcTo` is not exported.

- [ ] **Step 3: Add the helper to `eth.js`**

```js
// backend/src/chain/eth.js — add near usdcBalanceOf
const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }];

/** Relayer mints MockUSDC to `account`. Demo-only credit path (real on-chain, money-truth holds). */
export async function mintUsdcTo(account, amountAtomic) {
  return chainProvider().writeContract({
    address: getAddress(usdcToken().address),
    abi: MINT_ABI,
    functionName: 'mint',
    args: [getAddress(account), BigInt(amountAtomic)]
  });
}
```

- [ ] **Step 4: Point auroraService at the helper**

In `backend/src/services/auroraService.js:255-259`, replace the inline `this.chain.writeContract({... mint ...})` with:

```js
const { mintUsdcTo } = await import('../chain/eth.js');
const txHash = await mintUsdcTo(account, amountAtomic);
```

(Leave the `MINT_ABI` static getter in place if other code references it; otherwise remove it.)

- [ ] **Step 5: Run tests**

Run: `cd backend && node --test test/mint-usdc.test.js test/aurora-receive.test.js`
Expected: PASS (both the new test and the existing Aurora receive test).

- [ ] **Step 6: Commit**

```bash
git add backend/src/chain/eth.js backend/src/services/auroraService.js backend/test/mint-usdc.test.js
git commit -m "chain: extract mintUsdcTo helper (shared by Aurora receive + cross-chain fulfill)"
```

---

## Task 2: `markPaid` accepts a cross-chain payer

**Files:**
- Modify: `backend/src/services/requestService.js:207-217`
- Test: `backend/test/request.test.js` (add a case)

**Interfaces:**
- Produces: `markPaid(requestId, operationId, transactionHash, crossChainPayer = null)`. When `crossChainPayer` is `{ payerAddress, sourceChain }`, stores it on the request as `r.crossChainPayer = { payerAddress, sourceChain, viaAurora: true }`. Back-compat: existing 3-arg calls unchanged.

- [ ] **Step 1: Write the failing test** (append to `backend/test/request.test.js`)

```js
test('markPaid records a cross-chain payer when given one', async () => {
  const { store, service } = makeRequestFixture(); // existing helper in this file
  const r = service.draft({ requesterPrismId: 'req1', amountAtomic: '20000000', destination: 'PRIMARY' });
  service.commit({ requestId: r.request.requestId, requesterPrismId: 'req1' }); // → OPEN
  service.markPaid(r.request.requestId, null, '0xdeliver', { payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base' });
  const stored = store.read().requests[r.request.requestId];
  assert.equal(stored.status, 'PAID');
  assert.equal(stored.crossChainPayer.payerAddress, '0xAbc0000000000000000000000000000000000001');
  assert.equal(stored.crossChainPayer.sourceChain, 'base');
  assert.equal(stored.crossChainPayer.viaAurora, true);
});
```

> If `makeRequestFixture`/draft-commit helpers differ in this file, mirror the existing test setup in `request.test.js` verbatim — do not invent new helpers.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test test/request.test.js`
Expected: FAIL — `crossChainPayer` is undefined.

- [ ] **Step 3: Implement**

```js
// backend/src/services/requestService.js
markPaid(requestId, operationId, transactionHash, crossChainPayer = null) {
  if (!requestId) return;
  this.store.mutate(data => {
    const r = data.requests[requestId];
    if (!r || r.status !== 'OPEN') return;
    r.status = 'PAID';
    r.paymentOperationId = operationId;
    r.transactionHash = transactionHash ?? null;
    if (crossChainPayer) {
      r.crossChainPayer = { payerAddress: crossChainPayer.payerAddress, sourceChain: crossChainPayer.sourceChain, viaAurora: true };
    }
    r.paidAt = new Date().toISOString();
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && node --test test/request.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/requestService.js backend/test/request.test.js
git commit -m "requests: markPaid records an optional cross-chain payer"
```

---

## Task 3: `crossChainPayService.quote` — real Aurora dry route (inbound)

**Files:**
- Create: `backend/src/services/crossChainPayService.js`
- Test: `backend/test/crosschain-pay.test.js` (create)

**Interfaces:**
- Consumes: `requestService.getPublicView`, the real `auroraApiClient.quote`, `resolveAsset`/`knownChain` from `src/aurora/assets.js`, `config.aurora.destinationChain` (= `monad`).
- Produces: `class CrossChainPayService({ store, config, requestService, sweepService, auroraClient, mint })`.
  `async quote({ requestId, payerAddress, sourceChain, sourceAsset }) => { route, requester, amountAtomic, destinationChain, preview: boolean }`. Injectable seams `auroraClient` (defaults to the real `auroraApiClient`) and `mint` (defaults to `mintUsdcTo`) keep it testable.

- [ ] **Step 1: Write the failing test**

```js
// backend/test/crosschain-pay.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CrossChainPayService } from '../src/services/crosschainPayService.js';

function fixture(overrides = {}) {
  const request = { requestId: 'req_x', requesterPrismId: 'req1', amountAtomic: '20000000', token: 'USDC',
    memo: '', destination: 'PRIMARY', status: 'OPEN', isPublic: true, expiresAt: new Date(Date.now() + 6e5).toISOString(),
    ...overrides.request };
  const store = { _d: { requests: { req_x: request } }, read() { return this._d; }, mutate(fn) { fn(this._d); return this._d.requests.req_x; } };
  const requester = { accountAddress: '0x9226D56F93A3Fe4E78795BBaC1aecfF61E6A28F1', handle: 'tester1' };
  const requestService = {
    getPublicView: (id) => ({ requestId: id, requesterAccount: requester.accountAddress, requesterHandle: requester.handle, amountAtomic: request.amountAtomic, token: 'USDC', destination: request.destination, status: request.status }),
    markPaid: (...a) => { store._d.requests.req_x.status = 'PAID'; store._d.requests.req_x._markPaidArgs = a; }
  };
  const sweepService = { executeFor: async () => ({ state: 'SWEPT' }) };
  const auroraClient = { quote: async (req) => ({ quote: { amountIn: '20020000', amountInFormatted: '20.02', timeEstimate: 30, dry: req.dry } }) };
  const mint = async () => '0xmint';
  const config = { aurora: { destinationChain: 'monad', mode: overrides.mode ?? 'demo' } };
  return { store, requestService, sweepService, auroraClient, mint, config,
    svc: new CrossChainPayService({ store, config, requestService, sweepService, auroraClient, mint }) };
}

test('quote returns a real dry Aurora route for payer-chain → USDC on Monad → requester', async () => {
  const { svc } = fixture();
  const q = await svc.quote({ requestId: 'req_x', payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base', sourceAsset: 'USDC' });
  assert.equal(q.amountAtomic, '20000000');
  assert.equal(q.requester.handle, 'tester1');
  assert.equal(q.route.amountInFormatted, '20.02');
  assert.equal(q.route.dry, true); // always a dry quote
});

test('quote rejects a request that is not open', async () => {
  const { svc } = fixture({ request: { status: 'PAID' } });
  await assert.rejects(() => svc.quote({ requestId: 'req_x', payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base', sourceAsset: 'USDC' }), /not open/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test test/crosschain-pay.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `quote`**

```js
// backend/src/services/crosschainPayService.js
import { getAddress, isAddress } from 'viem';
import { auroraApiClient } from '../aurora/index.js';
import { knownChain, resolveAsset } from '../aurora/assets.js';
import { mintUsdcTo } from '../chain/eth.js';

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

export class CrossChainPayService {
  constructor({ store, config, requestService, sweepService, auroraClient = auroraApiClient, mint = mintUsdcTo }) {
    this.store = store; this.config = config; this.requests = requestService; this.sweeps = sweepService;
    this.aurora = auroraClient; this.mint = mint;
  }

  _openRequest(requestId) {
    const view = this.requests.getPublicView(requestId); // throws 404 if not a public request
    if (view.status !== 'OPEN') throw httpError(409, 'this request is not open');
    if (!view.requesterAccount || !isAddress(view.requesterAccount)) throw httpError(409, 'this request has no payable account');
    return view;
  }

  async quote({ requestId, payerAddress, sourceChain, sourceAsset }) {
    const view = this._openRequest(requestId);
    if (!isAddress(String(payerAddress ?? ''))) throw httpError(400, 'a valid payer address is required');
    const chain = String(sourceChain ?? '').trim().toLowerCase();
    if (!knownChain(chain)) throw httpError(400, `unsupported source chain '${chain}'`);

    const origin = await resolveAsset(chain, sourceAsset || 'USDC');
    if (!origin.ok) throw httpError(400, origin.reason, origin.options);
    const destChain = this.config.aurora.destinationChain; // monad
    const destination = await resolveAsset(destChain, 'USDC');
    if (!destination.ok) throw httpError(503, `cannot resolve USDC on ${destChain}: ${destination.reason}`);

    // Always a real DRY quote — the active client is the demo stub in demo mode and returns null.
    const quoted = await this.aurora.quote({
      dry: true, swapType: 'EXACT_OUTPUT', depositType: 'ORIGIN_CHAIN',
      amount: String(view.amountAtomic),
      originAsset: origin.asset.assetId, destinationAsset: destination.asset.assetId,
      recipient: getAddress(view.requesterAccount), recipientType: 'DESTINATION_CHAIN',
      refundTo: getAddress(payerAddress), refundType: 'ORIGIN_CHAIN',
      deadline: new Date(Date.now() + 5 * 60_000).toISOString()
    });
    if (!quoted?.quote) throw httpError(502, 'Aurora could not quote this route');

    return {
      requestId, amountAtomic: view.amountAtomic, destinationChain: destChain,
      requester: { handle: view.requesterHandle, account: view.requesterAccount },
      route: quoted.quote,
      preview: this.config.aurora.mode !== 'demo' // demo → will settle (mint); else quote-only
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && node --test test/crosschain-pay.test.js`
Expected: PASS (both quote tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/crosschainPayService.js backend/test/crosschain-pay.test.js
git commit -m "crosschain-pay: real Aurora dry-quote for inbound request payment"
```

---

## Task 4: `crossChainPayService.fulfill` — verify sig, mint, mark paid, sweep

**Files:**
- Modify: `backend/src/services/crosschainPayService.js`
- Test: `backend/test/crosschain-pay.test.js` (add cases)

**Interfaces:**
- Consumes: `verifyAccountMessage(account, message, signature)` from `src/chain/eth.js`, `mint` seam, `requestService.markPaid(id, null, txHash, { payerAddress, sourceChain })`, `sweepService.executeFor(id)`.
- Produces: `paymentMessage(view, payerAddress) => string` (the canonical string the payer signs) and `async fulfill({ requestId, payerAddress, sourceChain, signature }) => { status, deliveryTxHash, destination, sweep }`.

- [ ] **Step 1: Write the failing tests**

```js
// append to backend/test/crosschain-pay.test.js
import { CrossChainPayService } from '../src/services/crosschainPayService.js';

test('fulfill verifies the payer signature, mints to the requester, marks PAID, fires the sweep', async (t) => {
  const { svc, store, requestService } = fixture();
  // stub signature verification via the injectable seam
  svc._verify = async () => true;
  let minted;
  svc.mint = async (to, amt) => { minted = { to, amt }; return '0xdeliver'; };
  const res = await svc.fulfill({ requestId: 'req_x', payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base', signature: '0xsig' });
  assert.equal(res.status, 'PAID');
  assert.equal(res.deliveryTxHash, '0xdeliver');
  assert.equal(minted.to, '0x9226D56F93A3Fe4E78795BBaC1aecfF61E6A28F1');
  assert.equal(minted.amt, '20000000');
  assert.equal(store.read().requests.req_x.status, 'PAID');
});

test('fulfill rejects a bad signature', async () => {
  const { svc } = fixture();
  svc._verify = async () => false;
  await assert.rejects(() => svc.fulfill({ requestId: 'req_x', payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base', signature: '0xbad' }), /signature/);
});

test('fulfill is a no-op mint when not in demo mode (quote-only / preview)', async () => {
  const { svc } = fixture({ mode: 'preview' });
  svc._verify = async () => true;
  let minted = false; svc.mint = async () => { minted = true; return '0x'; };
  await assert.rejects(() => svc.fulfill({ requestId: 'req_x', payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base', signature: '0xsig' }), /not available/);
  assert.equal(minted, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && node --test test/crosschain-pay.test.js`
Expected: FAIL — `fulfill`/`_verify` undefined.

- [ ] **Step 3: Implement `fulfill` + message + verify seam**

```js
// add to CrossChainPayService, and import verifyAccountMessage at top:
//   import { verifyAccountMessage, mintUsdcTo } from '../chain/eth.js';

paymentMessage(view, payerAddress) {
  // Human-readable, and binds the exact request + amount + both parties so a captured signature
  // cannot be reused for another request (and the OPEN→PAID transition blocks re-use of this one).
  return `Prism cross-chain payment\nRequest: ${view.requestId}\nAmount: ${view.amountAtomic} ${view.token}\nTo: ${getAddress(view.requesterAccount)}\nFrom: ${getAddress(payerAddress)}`;
}

async _verify(payerAddress, message, signature) {
  return verifyAccountMessage(payerAddress, message, signature);
}

async fulfill({ requestId, payerAddress, sourceChain, signature }) {
  const view = this._openRequest(requestId);
  if (!isAddress(String(payerAddress ?? ''))) throw httpError(400, 'a valid payer address is required');
  const chain = String(sourceChain ?? '').trim().toLowerCase();
  if (!knownChain(chain)) throw httpError(400, `unsupported source chain '${chain}'`);

  const ok = await this._verify(payerAddress, this.paymentMessage(view, payerAddress), signature);
  if (!ok) throw httpError(400, 'payment signature does not match the connected wallet');

  if (this.config.aurora.mode !== 'demo') {
    // preview: real quote shown, but this build cannot settle (Aurora carries Monad mainnet only).
    throw httpError(409, 'settlement is not available on this deployment (AURORA_MODE must be demo)');
  }

  // Simulated Aurora delivery = a real on-chain USDC mint to the requester (money-truth credit).
  const deliveryTxHash = await this.mint(view.requesterAccount, view.amountAtomic);
  // Mark PAID with the cross-chain payer, then relay the requester's pre-signed sweep (if any).
  this.requests.markPaid(requestId, null, deliveryTxHash, { payerAddress: getAddress(payerAddress), sourceChain: chain });
  const sweep = await this.sweeps.executeFor(requestId).catch(() => ({ state: 'FAILED' }));

  return { status: 'PAID', deliveryTxHash, destination: view.destination, sweep };
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && node --test test/crosschain-pay.test.js`
Expected: PASS (all quote + fulfill tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/crosschainPayService.js backend/test/crosschain-pay.test.js
git commit -m "crosschain-pay: fulfill verifies payer sig, mints credit, marks PAID, fires sweep"
```

---

## Task 5: Wire routes + CORS in `server.js`

**Files:**
- Modify: `backend/src/server.js` (instantiate service; 2 routes; CORS for public + pay routes; OPTIONS preflight)
- Modify: `backend/src/config.js` (add `payWebOrigin`)
- Test: `backend/test/crosschain-routes.test.js` (create — drives the routes through a real `http` server like the existing server tests)

**Interfaces:**
- Consumes: `CrossChainPayService`, existing `route()` registrar, existing `send()`.
- Produces: `POST /v1/pay/:requestId/quote`, `POST /v1/pay/:requestId/fulfill` (both unauthenticated), and CORS headers (`Access-Control-Allow-Origin: <PAY_WEB_ORIGIN>`, methods, headers) on `/v1/pay/*` and `/v1/requests/:id/public`, plus a 204 OPTIONS preflight response.

- [ ] **Step 1: Add config** — in `backend/src/config.js`, add to the exported config object:

```js
  payWebOrigin: env('PAY_WEB_ORIGIN', 'http://localhost:5173'),
```

- [ ] **Step 2: Instantiate the service** — in `server.js` near the other service constructors (after `auroraService`):

```js
import { CrossChainPayService } from './services/crosschainPayService.js';
const crossChainPayService = new CrossChainPayService({ store, config, requestService, sweepService });
```

- [ ] **Step 3: Write the failing route test**

```js
// backend/test/crosschain-routes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
// Mirror the harness used by the other server route tests in this repo (start the app on an
// ephemeral port, seed a public OPEN request in the store, then fetch). Follow the existing
// server test file's setup verbatim; the assertions below are the new behavior:

test('OPTIONS /v1/pay/:id/quote returns 204 with CORS headers', async () => {
  const { base } = await startTestServer(); // existing helper pattern
  const res = await fetch(`${base}/v1/pay/req_x/quote`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('POST /v1/pay/:id/quote returns a route for a seeded OPEN public request', async () => {
  const { base, seedPublicRequest, setAuroraQuote } = await startTestServer();
  seedPublicRequest({ requestId: 'req_x', amountAtomic: '20000000', requesterAccount: '0x9226D56F93A3Fe4E78795BBaC1aecfF61E6A28F1' });
  setAuroraQuote({ quote: { amountInFormatted: '20.02', dry: true } });
  const res = await fetch(`${base}/v1/pay/req_x/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base', sourceAsset: 'USDC' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.amountAtomic, '20000000');
});
```

> The repo already has server route tests (`tests/security-server.test.mjs` / `test/*server*`). Reuse that exact bootstrapping (do not hand-roll a new server harness). Inject the mock Aurora client via `setAuroraClient` and a mintable store as those tests do.

- [ ] **Step 4: Run to verify it fails**

Run: `cd backend && node --test test/crosschain-routes.test.js`
Expected: FAIL — routes 404 / no CORS.

- [ ] **Step 5: Add CORS + OPTIONS + routes**

In `server.js`, in the request handler (where `match()` is called, before auth), add CORS for the two public prefixes. Concretely, after computing `url.pathname`:

```js
const isPayPublic = url.pathname.startsWith('/v1/pay/') || /^\/v1\/requests\/[^/]+\/public$/.test(url.pathname);
if (isPayPublic) {
  res.setHeader('access-control-allow-origin', config.payWebOrigin);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
}
```

Then register the routes (near the request routes):

```js
route('POST', '/v1/pay/:requestId/quote', async ({ params, body, ip }) => {
  rateLimit(`pay-quote:${params.requestId}:${ip}`, 60);
  return crossChainPayService.quote({ requestId: params.requestId, payerAddress: body.payerAddress, sourceChain: body.sourceChain, sourceAsset: body.sourceAsset });
});
route('POST', '/v1/pay/:requestId/fulfill', async ({ params, body, ip }) => {
  rateLimit(`pay-fulfill:${params.requestId}:${ip}`, 20);
  return crossChainPayService.fulfill({ requestId: params.requestId, payerAddress: body.payerAddress, sourceChain: body.sourceChain, signature: body.signature });
});
```

> Both routes are registered WITHOUT the `auth=true` flag (unauthenticated). `rateLimit`/`ip` are already available in this file (used by the aurora demo route).

- [ ] **Step 6: Run tests + full suite**

Run: `cd backend && node --test test/crosschain-routes.test.js && node --test`
Expected: new tests PASS; full suite still green (was 531).

- [ ] **Step 7: Commit**

```bash
git add backend/src/server.js backend/src/config.js backend/test/crosschain-routes.test.js
git commit -m "server: cross-chain pay quote+fulfill routes with scoped CORS"
```

---

## Task 6: Scaffold `apps/pay-web`

**Files:**
- Create: `apps/pay-web/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.env.example`, `.gitignore`, `src/main.tsx`, `src/App.tsx`, `src/api.ts`, `src/wagmi.ts`

**Interfaces:**
- Produces: a Vite app that builds and serves `/pay/:requestId`; `api.ts` exports `getPublicRequest(id)`, `quote(id, body)`, `fulfill(id, body)` against `import.meta.env.VITE_API_BASE_URL`.

- [ ] **Step 1: Scaffold + deps**

```bash
cd apps && npm create vite@latest pay-web -- --template react-ts && cd pay-web
npm install wagmi viem @tanstack/react-query react-router-dom
```

- [ ] **Step 2: `.env.example`**

```
VITE_API_BASE_URL=http://localhost:8787
VITE_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
```

- [ ] **Step 3: `src/api.ts`** (concrete)

```ts
const BASE = import.meta.env.VITE_API_BASE_URL as string;
async function post(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}
export const getPublicRequest = (id: string) =>
  fetch(`${BASE}/v1/requests/${id}/public`).then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
export const quote = (id: string, body: { payerAddress: string; sourceChain: string; sourceAsset: string }) => post(`/v1/pay/${id}/quote`, body);
export const fulfill = (id: string, body: { payerAddress: string; sourceChain: string; signature: string }) => post(`/v1/pay/${id}/fulfill`, body);
```

- [ ] **Step 4: `src/wagmi.ts`** (injected + WalletConnect, a few EVM chains)

```ts
import { createConfig, http } from 'wagmi';
import { base, arbitrum, optimism, mainnet } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';
export const wagmiConfig = createConfig({
  chains: [base, arbitrum, optimism, mainnet],
  connectors: [injected(), walletConnect({ projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string })],
  transports: { [base.id]: http(), [arbitrum.id]: http(), [optimism.id]: http(), [mainnet.id]: http() }
});
```

- [ ] **Step 5: Verify it builds**

Run: `cd apps/pay-web && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/pay-web
git commit -m "pay-web: scaffold Vite+React app (wagmi, api client)"
```

---

## Task 7: Review screen — load + render the public request

**Files:**
- Modify: `apps/pay-web/src/App.tsx`, add `src/PayPage.tsx`, `src/state.ts`

**Interfaces:**
- Consumes: `getPublicRequest`. Produces a `PayPage` component routed at `/pay/:requestId` with states `loading | invalid | review | …`.

- [ ] **Step 1: Router + providers in `App.tsx`**

```tsx
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { wagmiConfig } from './wagmi';
import { PayPage } from './PayPage';
const qc = new QueryClient();
export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}><QueryClientProvider client={qc}><BrowserRouter>
      <Routes><Route path="/pay/:requestId" element={<PayPage />} /></Routes>
    </BrowserRouter></QueryClientProvider></WagmiProvider>
  );
}
```

- [ ] **Step 2: `PayPage.tsx` review state**

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicRequest } from './api';
type Req = { requestId: string; requesterHandle: string | null; amountAtomic: string; tokenSymbol: string | null; memo: string; destination: string; status: string };
const usd = (a: string) => `$${(Number(a) / 1e6).toFixed(2)}`;
export function PayPage() {
  const { requestId = '' } = useParams();
  const [req, setReq] = useState<Req | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getPublicRequest(requestId).then(setReq).catch(() => setError('This request link is invalid, expired, or already paid.')); }, [requestId]);
  if (error) return <main className="card"><p>{error}</p></main>;
  if (!req) return <main className="card"><p>Loading…</p></main>;
  if (req.status !== 'OPEN') return <main className="card"><p>This request is {req.status.toLowerCase()}.</p></main>;
  return (
    <main className="card">
      <h1>{req.requesterHandle ? `@${req.requesterHandle}` : 'Someone'} requests {usd(req.amountAtomic)}</h1>
      {req.memo && <p className="memo">{req.memo}</p>}
      {req.destination !== 'PRIMARY' && <p className="dest">Lands in their {req.destination.toLowerCase()}</p>}
      <p className="notice">Demo: Aurora route is real; settlement is simulated on testnet.</p>
      {/* Connect + quote UI added in Task 8/9 */}
    </main>
  );
}
```

- [ ] **Step 3: Manual verify**

Run backend (`AURORA_MODE=preview` for real quotes later; any mode renders review). Seed/have an OPEN public request id, open `http://localhost:5173/pay/<id>`, confirm the request renders. `npm run build` passes.

- [ ] **Step 4: Commit**

```bash
git add apps/pay-web/src
git commit -m "pay-web: review screen renders the public request"
```

---

## Task 8: Connect wallet

**Files:** Modify `apps/pay-web/src/PayPage.tsx`

- [ ] **Step 1: Add connect UI** (below the review block)

```tsx
import { useAccount, useConnect, useChainId } from 'wagmi';
// inside PayPage, after the request is OPEN:
const { address, isConnected } = useAccount();
const { connect, connectors } = useConnect();
const chainId = useChainId();
// render:
{!isConnected
  ? <div className="connect">{connectors.map(c => <button key={c.uid} onClick={() => connect({ connector: c })}>Connect {c.name}</button>)}</div>
  : <p className="addr">Connected {address?.slice(0, 6)}…{address?.slice(-4)} · chain {chainId}</p>}
```

- [ ] **Step 2: Verify** — `npm run build` passes; connecting an injected wallet shows the address.

- [ ] **Step 3: Commit**

```bash
git add apps/pay-web/src/PayPage.tsx
git commit -m "pay-web: wallet connect (injected + WalletConnect)"
```

---

## Task 9: Quote screen

**Files:** Modify `apps/pay-web/src/PayPage.tsx`

**Interfaces:** Consumes `quote(requestId, { payerAddress, sourceChain, sourceAsset })`. Maps the connected `chainId` to Aurora's chain slug.

- [ ] **Step 1: Chain-slug map + quote fetch**

```tsx
import { quote as quoteApi } from './api';
const CHAIN_SLUG: Record<number, string> = { 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 1: 'ethereum' };
// state: const [route, setRoute] = useState<any>(null); const [qErr, setQErr] = useState<string|null>(null);
async function getQuote() {
  setQErr(null);
  try {
    const slug = CHAIN_SLUG[chainId]; if (!slug) { setQErr('Switch to Base, Arbitrum, Optimism, or Ethereum.'); return; }
    const q = await quoteApi(requestId, { payerAddress: address!, sourceChain: slug, sourceAsset: 'USDC' });
    setRoute(q);
  } catch (e) { setQErr((e as Error).message); }
}
// render when connected and no route yet: <button onClick={getQuote}>Get quote</button>
// render when route: pay ~{route.route.amountInFormatted} USDC on {slug} → @{req.requesterHandle} gets {usd(req.amountAtomic)} on Monad
```

- [ ] **Step 2: Render the route + persistent notice**

```tsx
{route && <div className="route">
  <p>Pay ~{route.route.amountInFormatted ?? usd(route.amountAtomic)} USDC on {CHAIN_SLUG[chainId]}</p>
  <p>Aurora routes it → {req.requesterHandle ? `@${req.requesterHandle}` : 'them'} receives {usd(req.amountAtomic)} on Monad</p>
  <p className="notice">Real Aurora route · settlement simulated on testnet (would land on Monad mainnet).</p>
</div>}
```

- [ ] **Step 3: Verify** — with backend reachable and an OPEN request, "Get quote" returns and renders a route. `npm run build` passes.

- [ ] **Step 4: Commit**

```bash
git add apps/pay-web/src/PayPage.tsx
git commit -m "pay-web: quote screen renders the real Aurora route"
```

---

## Task 10: Sign + fulfill + done

**Files:** Modify `apps/pay-web/src/PayPage.tsx`

**Interfaces:** Consumes `useSignMessage` (wagmi) and `fulfill(requestId, { payerAddress, sourceChain, signature })`. The signed message MUST match `crossChainPayService.paymentMessage` byte-for-byte.

- [ ] **Step 1: Build the same canonical message + sign + fulfill**

```tsx
import { useSignMessage } from 'wagmi';
const { signMessageAsync } = useSignMessage();
const [done, setDone] = useState<null | { deliveryTxHash: string }>(null);
async function pay() {
  const slug = CHAIN_SLUG[chainId];
  // MUST equal backend paymentMessage(view, payerAddress) exactly:
  const message = `Prism cross-chain payment\nRequest: ${req.requestId}\nAmount: ${req.amountAtomic} ${req.tokenSymbol ?? 'USDC'}\nTo: ${route.requester.account}\nFrom: ${address}`;
  const signature = await signMessageAsync({ message });
  const res = await fulfill(requestId, { payerAddress: address!, sourceChain: slug, signature });
  setDone(res);
}
// render when route && !done: <button onClick={pay}>Pay {usd(req.amountAtomic)}</button>
// render when done: ✓ Paid — {req.requesterHandle} received {usd(req.amountAtomic)}. <span className="notice">Demo settlement simulated on testnet.</span>
```

> The `To:` address in the message uses `route.requester.account` (returned by `/quote`) so it exactly matches the backend's `getAddress(view.requesterAccount)`. If casing differs, the signature check fails — apply `viem`'s `getAddress` on both sides. The backend applies `getAddress`; the message here must too. Import `getAddress` from `viem` and wrap `route.requester.account` and `address`.

- [ ] **Step 2: Verify end-to-end** — backend in `AURORA_MODE=demo`, an OPEN public request for a real Monad account: connect → quote → Pay → wallet signs → done screen; backend marks the request PAID and the requester's balance/Circle grows on-chain.

- [ ] **Step 3: Commit**

```bash
git add apps/pay-web/src/PayPage.tsx
git commit -m "pay-web: sign-to-pay + fulfill + done screen"
```

---

## Task 11: End-to-end smoke + close-out

**Files:** none (verification) + `apps/pay-web/README.md` (create)

- [ ] **Step 1: Full backend suite green** — `cd backend && node --test` (was 531; now higher, 0 fail).
- [ ] **Step 2: Live smoke** — with a real universal request created in the iOS app (destination = Savings), open the link in `apps/pay-web`, connect MetaMask (Base), get the real Aurora quote, sign, pay. Confirm on-chain: requester's USDC minted, request PAID, Savings position grew (sweep fired). Verify with `cast` + `/v1/me/balance`.
- [ ] **Step 3: Write `apps/pay-web/README.md`** — env vars, `npm run dev`, the `PAY_WEB_ORIGIN` backend requirement, and the honest "real quote / simulated settle / AURORA_MODE=demo" note.
- [ ] **Step 4: Commit + open PR to main** (follow repo flow: `gh auth switch --user cybort360`, push, PR, merge).

---

## Self-Review

**Spec coverage:** review screen (T7) ✓, wallet connect (T8) ✓, real quote (T3/T9) ✓, sign-to-authorize (T4/T10) ✓, fulfill mint+markPaid+sweep (T4) ✓, CORS + routes (T5) ✓, money-truth real mint (T1/T4) ✓, AURORA_MODE gate (T4) ✓, payer-can't-alter (T3/T4 read from stored request) ✓, one-payment-per-request (markPaid OPEN→PAID) ✓, testing (T3/T4/T5 + smoke T11) ✓, apps/pay-web separate app + CORS (T5/T6) ✓.

**Placeholder scan:** the two "mirror the existing harness" notes (T2 fixture, T5 server harness) point at concrete existing files rather than inlining another repo's boilerplate — deliberate, since duplicating those harnesses verbatim would be brittle. Every code step shows real code.

**Type consistency:** `paymentMessage` string is defined identically in T4 (backend) and T10 (web), with the `getAddress` normalization note. `markPaid(id, null, txHash, {payerAddress, sourceChain})` matches T2's new signature. `quote()`/`fulfill()` return shapes used by the web tasks match T3/T4.

## Open items

- Confirm the exact Aurora **source** asset set for the picker at implementation (T9 hardcodes USDC on Base/Arbitrum/Optimism/Ethereum — the demo-friendly subset). Drive from the live token list if broader coverage is wanted.
- `EXACT_OUTPUT`/`EXACT_INPUT` on the inbound quote (T3 uses `EXACT_OUTPUT` so the requester receives the exact request amount) — verify against Aurora's quote API at implementation; fall back to `EXACT_INPUT` + display if `EXACT_OUTPUT` isn't supported for a route.
