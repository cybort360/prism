import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';

// Wiring test for the cross-chain pay routes: CORS/OPTIONS preflight, route registration, that they
// are UNAUTHENTICATED, and that they reach crossChainPayService (not a match() miss). The service
// logic (quote/fulfill) is covered by crosschain-pay.test.js — this only tests the server plumbing.
// A missing request 404s at the service with 'request not found', distinct from an unregistered
// route's 'not found', which is how we prove the route reaches the service without seeding state.

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) { try { const r = await fetch(url); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`server did not become ready: ${url}`);
}

test('cross-chain pay routes: CORS preflight + unauthenticated + reach the service', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-xchain-'));
  const origin = 'http://localhost:5173';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), STORE_PATH: path.join(dir, 'store.json'), NODE_ENV: 'development', MONAD_CHAIN_ID: '10143', PAY_WEB_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/health`);

    // 1. OPTIONS preflight → 204 with the configured CORS origin.
    const pre = await fetch(`${base}/v1/pay/req_x/quote`, { method: 'OPTIONS', headers: { origin } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET,POST,OPTIONS');

    // 2. The public request route also carries CORS (same allow-list).
    const pub = await fetch(`${base}/v1/requests/req_missing/public`, { headers: { origin } });
    assert.equal(pub.headers.get('access-control-allow-origin'), origin);

    // 3. POST /quote is registered, unauthenticated (no 401), and reaches the service:
    //    a missing request 404s with the SERVICE's message, not match()'s 'not found'.
    const q = await fetch(`${base}/v1/pay/req_missing/quote`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ payerAddress: '0xABC0000000000000000000000000000000000001', sourceChain: 'base', sourceAsset: 'USDC' })
    });
    assert.equal(q.status, 404);
    assert.equal((await q.json()).error, 'request not found'); // reached getPublicView, not a route miss
    assert.equal(q.headers.get('access-control-allow-origin'), origin);

    // 4. POST /fulfill is likewise registered + unauthenticated + reaches the service.
    const f = await fetch(`${base}/v1/pay/req_missing/fulfill`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ payerAddress: '0xABC0000000000000000000000000000000000001', sourceChain: 'base', signature: '0xsig' })
    });
    assert.equal(f.status, 404);
    assert.equal((await f.json()).error, 'request not found');
  } finally {
    child.kill('SIGKILL');
  }
});
