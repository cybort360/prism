import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { JsonStore } from '../src/lib/jsonStore.js';
import { RequestService } from '../src/services/requestService.js';
import { IntentDispatcherService } from '../src/services/intentDispatcherService.js';
import { meraAccount, PK_A, PK_B, PK_C } from './helpers.js';

const USDC = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const config = {
  limits: { maxPaymentAtomic: 10_000_000_000n },
  chain: { usdc: USDC }
};

function fixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-')), 'store.json');
  const store = new JsonStore(file);
  const a = meraAccount(PK_A), b = meraAccount(PK_B), c = meraAccount(PK_C);
  store.mutate(d => {
    d.identities.a = { prismId: 'a', account: a.address, accountAddress: a.address, handle: 'octane', displayName: 'Octane' };
    d.identities.b = { prismId: 'b', account: b.address, accountAddress: b.address, handle: 'tobi', displayName: 'Tobi' };
    d.identities.c = { prismId: 'c', account: c.address, accountAddress: c.address, handle: 'kemi', displayName: 'Kemi' };
  });
  const identityService = { get: id => store.read().identities[id] ?? null };
  return { store, a, b, c, service: new RequestService({ store, identityService, config }) };
}

function dispatcher(requests) {
  return new IntentDispatcherService({
    circleService: { previewPayment: () => { throw new Error('not under test'); } },
    requestService: requests,
    auroraService: {},
    config
  });
}

// --- universal draft + commit ----------------------------------------------------

test('universal request drafts with null payer and commits to OPEN', async () => {
  const { a, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', amountAtomic: '15000000', memo: 'Coffee fund' });
  assert.equal(draft.request.payerPrismId, null);
  assert.equal(draft.request.isPublic, true);
  // Deterministic canonical commitment: null payer serializes stably.
  assert.equal(JSON.parse(draft.signable).payerPrismId, null);
  const committed = await service.commit({
    requesterPrismId: 'a', requestId: draft.request.requestId, signature: await a.signMessage(draft.signable)
  });
  assert.equal(committed.status, 'OPEN');
});

// --- public view: safe metadata only ----------------------------------------------

test('getPublicView exposes only safe metadata (INV-P1)', async () => {
  const { service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', amountAtomic: '15000000', memo: 'Coffee fund', destination: 'SAVINGS' });
  const view = service.getPublicView(draft.request.requestId);
  assert.deepEqual(
    Object.keys(view).sort(),
    ['requestId', 'requesterHandle', 'requesterDisplayName', 'requesterAccount', 'amountAtomic', 'token', 'tokenSymbol', 'memo', 'destination', 'status', 'expiresAt'].sort()
  );
  assert.equal(view.requesterHandle, 'octane');
  assert.equal(view.destination, 'SAVINGS');
  const blob = JSON.stringify(view).toLowerCase();
  for (const leak of ['phone', 'lookup', 'session', 'prismid']) {
    assert.ok(!blob.includes(leak), `public view leaks '${leak}'`);
  }
  assert.throws(() => service.getPublicView('req_doesnotexist'), /not found/);
});

// --- fulfillment: anyone may pay universal; designated stays bound -----------------

test('any payer fulfills a universal request; designated requests stay bound', async () => {
  const { a, service } = fixture();
  const uni = service.draft({ requesterPrismId: 'a', amountAtomic: '15000000' });
  await service.commit({ requesterPrismId: 'a', requestId: uni.request.requestId, signature: await a.signMessage(uni.signable) });
  // A stranger (c) — never named on the request — is accepted.
  const paid = service.assertPayable({
    requestId: uni.request.requestId, payerPrismId: 'c', recipientPrismId: 'a', amountAtomic: '15000000'
  });
  assert.equal(paid.requestId, uni.request.requestId);
  // ...but amount and recipient still bind.
  assert.throws(() => service.assertPayable({
    requestId: uni.request.requestId, payerPrismId: 'c', recipientPrismId: 'a', amountAtomic: '16000000'
  }), /amount/);
  // Nameless fulfillment is never recorded.
  assert.throws(() => service.assertPayable({
    requestId: uni.request.requestId, payerPrismId: null, recipientPrismId: 'a', amountAtomic: '15000000'
  }), /payer is required/);

  // Designated 1-to-1: payer B cannot pay a request meant exclusively for payer C.
  const one = service.draft({ requesterPrismId: 'a', payerPrismId: 'c', amountAtomic: '15000000' });
  await service.commit({ requesterPrismId: 'a', requestId: one.request.requestId, signature: await a.signMessage(one.signable) });
  assert.equal(one.request.isPublic, false);
  assert.throws(() => service.assertPayable({
    requestId: one.request.requestId, payerPrismId: 'b', recipientPrismId: 'a', amountAtomic: '15000000'
  }), /another payer/);
  assert.equal(service.assertPayable({
    requestId: one.request.requestId, payerPrismId: 'c', recipientPrismId: 'a', amountAtomic: '15000000'
  }).requestId, one.request.requestId);
});

// --- dispatcher: universal receive --------------------------------------------------

test('dispatcher RECEIVE with null payer returns isPublic and shareableUrl', async () => {
  const { service } = fixture();
  const out = await dispatcher(service).prepareIntent({
    kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: null,
    amountAtomic: '15000000', memo: 'Open fund', destination: 'PRIMARY'
  });
  assert.equal(out.isPublic, true);
  assert.equal(out.shareableUrl, `/pay/${out.request.requestId}`);
  assert.equal(out.request.payerPrismId, null);

  const designated = await dispatcher(service).prepareIntent({
    kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000'
  });
  assert.equal(designated.isPublic ?? false, false);
  assert.equal(designated.shareableUrl, null);
});

// --- HTTP: unauthenticated public fetch ------------------------------------------------

test('HTTP GET /v1/requests/:id/public needs no auth and leaks nothing', { timeout: 30_000 }, async () => {
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-univ-http-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), STORE_PATH: path.join(dir, 'store.json'), NODE_ENV: 'development', MONAD_CHAIN_ID: '10143' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 50));
      if (i === 59) throw new Error('server did not become ready');
    }
    const owner = meraAccount(PK_A);
    const { nonce } = await (await fetch(`${base}/v1/auth/challenge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })).json();
    const authed = await (await fetch(`${base}/v1/auth/device`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: owner.address, bindingProof: await owner.bindingProof(nonce), challenge: nonce, handle: 'octane' })
    })).json();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${authed.session}` };

    // Draft a universal request (no payerPrismId) as the authed requester.
    const drafted = await (await fetch(`${base}/v1/requests/draft`, {
      method: 'POST', headers,
      body: JSON.stringify({ amountAtomic: '15000000', memo: 'Open coffee fund', destination: 'PRIMARY' })
    })).json();
    assert.ok(drafted.request?.requestId);
    const requestId = drafted.request.requestId;

    // Unauthenticated fetch: safe metadata, zero leaks.
    const pub = await fetch(`${base}/v1/requests/${requestId}/public`);
    assert.equal(pub.status, 200);
    const view = await pub.json();
    assert.equal(view.amountAtomic, '15000000');
    assert.equal(view.memo, 'Open coffee fund');
    assert.equal(view.requesterHandle, 'octane');
    const blob = JSON.stringify(view).toLowerCase();
    for (const leak of ['phone', 'lookup', 'session']) assert.ok(!blob.includes(leak), `HTTP public view leaks '${leak}'`);

    const missing = await fetch(`${base}/v1/requests/req_nope/public`);
    assert.equal(missing.status, 404);
  } finally {
    child.kill('SIGTERM');
  }
});
