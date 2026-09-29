import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CrossChainPayService } from '../src/services/crosschainPayService.js';
import { setAuroraClient, resetAuroraClient } from '../src/aurora/index.js';
import { makeMockAuroraClient } from '../src/aurora/mockAuroraClient.js';

// `resolveAsset`/`knownChain` (used internally by the service to look up assetIds) go through the
// aurora/index.js registry, not the constructor-injected `auroraClient` seam — that seam is only for
// the actual dry-quote call. Seed the registry with a token catalog (base + monad USDC) so asset
// resolution doesn't need a live appKey or network access; this mirrors production, where AURORA_MODE
// =demo swaps the registry to a client with a real catalog before any request is served.
before(() => setAuroraClient(makeMockAuroraClient()));
after(() => resetAuroraClient());

function fixture(overrides = {}) {
  const request = { requestId: 'req_x', requesterPrismId: 'req1', amountAtomic: '20000000', token: 'USDC',
    memo: '', destination: 'PRIMARY', status: 'OPEN', isPublic: true, expiresAt: new Date(Date.now() + 6e5).toISOString(),
    ...overrides.request };
  const store = { _d: { requests: { req_x: request } }, read() { return this._d; }, mutate(fn) { fn(this._d); return this._d.requests.req_x; } };
  const requester = { accountAddress: '0x9226D56F93A3Fe4E78795BBaC1aecfF61E6A28F1', handle: 'tester1' };
  // Stub requestService modelling the REAL single-flight contract: claim is a synchronous OPEN→settling
  // transition (throws 409 if already claimed / not open), markPaid flips to PAID and clears the claim,
  // release clears it. This lets the concurrency test below genuinely exercise the guard.
  const requestService = {
    getPublicView: (id) => { const r = store._d.requests[id]; return { requestId: id, requesterAccount: requester.accountAddress, requesterHandle: requester.handle, amountAtomic: r.amountAtomic, token: 'USDC', destination: r.destination, status: r.status }; },
    claimForCrossChainSettlement: (id) => store.mutate((d) => {
      const r = d.requests[id];
      if (!r || r.status !== 'OPEN') { const e = new Error('this request is not open'); e.statusCode = 409; throw e; }
      if (r.settling) { const e = new Error('this request is already being paid'); e.statusCode = 409; throw e; }
      r.settling = true; return r;
    }),
    releaseCrossChainSettlement: (id) => store.mutate((d) => { const r = d.requests[id]; if (r && r.settling && r.status === 'OPEN') r.settling = false; }),
    markPaid: (...a) => { const r = store._d.requests.req_x; r.status = 'PAID'; r.settling = false; r._markPaidArgs = a; }
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
  const q = await svc.quote({ requestId: 'req_x', payerAddress: '0xABC0000000000000000000000000000000000001', sourceChain: 'base', sourceAsset: 'USDC' });
  assert.equal(q.amountAtomic, '20000000');
  assert.equal(q.requester.handle, 'tester1');
  assert.equal(q.route.amountInFormatted, '20.02');
  assert.equal(q.route.dry, true); // always a dry quote
});

test('quote rejects a request that is not open', async () => {
  const { svc } = fixture({ request: { status: 'PAID' } });
  await assert.rejects(() => svc.quote({ requestId: 'req_x', payerAddress: '0xABC0000000000000000000000000000000000001', sourceChain: 'base', sourceAsset: 'USDC' }), /not open/);
});

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

test('two concurrent fulfillments mint exactly once (single-flight, no double-credit)', async () => {
  const { svc, store } = fixture();
  svc._verify = async () => true;
  let mintCalls = 0;
  // A mint that yields to the event loop, so both fulfillments are in-flight at once if the claim
  // did not guard them. Without the claim, both would pass the OPEN check and both would mint.
  svc.mint = async () => { mintCalls += 1; await new Promise((r) => setTimeout(r, 5)); return '0xdeliver'; };
  const call = () => svc.fulfill({ requestId: 'req_x', payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base', signature: '0xsig' });
  const results = await Promise.allSettled([call(), call()]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(mintCalls, 1, 'the requester is credited exactly once for one request');
  assert.equal(ok.length, 1, 'exactly one fulfillment succeeds');
  assert.equal(rejected.length, 1, 'the concurrent one is rejected');
  assert.equal(rejected[0].reason.statusCode, 409);
  assert.equal(store.read().requests.req_x.status, 'PAID');
});

test('fulfill releases the claim if the mint throws, leaving the request payable', async () => {
  const { svc, store } = fixture();
  svc._verify = async () => true;
  svc.mint = async () => { throw new Error('mint reverted'); };
  await assert.rejects(() => svc.fulfill({ requestId: 'req_x', payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base', signature: '0xsig' }), /mint reverted/);
  assert.equal(store.read().requests.req_x.status, 'OPEN', 'still open — the credit never happened');
  assert.equal(store.read().requests.req_x.settling, false, 'claim released');
});
