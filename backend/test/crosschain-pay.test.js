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
