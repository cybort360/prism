import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import { meraAccount, PK_A } from './helpers.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`server did not become ready: ${url}`);
}

test('HTTP contract exposes Swift-required routes and rejects unsigned identity mutation', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-http-'));
  const store = path.join(dir, 'store.json');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), STORE_PATH: store, NODE_ENV: 'development', MONAD_CHAIN_ID: '10143' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/health`);
    const cfg = await (await fetch(`${base}/v1/config`)).json();
    assert.equal(cfg.ausd.toLowerCase(), '0xa9012a055bd4e0edff8ce09f960291c09d5322dc');
    assert.equal(cfg.ausdDecimals, 6);
    assert.equal(cfg.usdc.toLowerCase(), '0x534b2f3a21130d7a60830c2df862319e593943a3');
    assert.deepEqual(cfg.tokens.map(token => token.symbol), ['AUSD', 'USDC']);
    assert.equal(cfg.chainId, '10143');

    const owner = meraAccount(PK_A);
    const authResponse = await fetch(`${base}/v1/auth/device`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: owner.address, bindingProof: await owner.bindingProof(), handle: null })
    });
    assert.equal(authResponse.status, 200);
    const auth = await authResponse.json();
    assert.equal(auth.identity.account.toLowerCase(), owner.address.toLowerCase());
    const headers = { 'content-type': 'application/json', 'authorization': `Bearer ${auth.session}` };

    const bad = await fetch(`${base}/v1/me/handle`, {
      method: 'POST', headers, body: JSON.stringify({ handle: 'octane', accountSignature: `0x${'00'.repeat(65)}` })
    });
    assert.equal(bad.status, 401);

    const payload = { action: 'set_handle', aliasVersion: auth.identity.aliasVersion, prismId: auth.identity.prismId, value: 'octane' };
    const good = await fetch(`${base}/v1/me/handle`, {
      method: 'POST', headers, body: JSON.stringify({ handle: 'octane', accountSignature: await owner.mutation(payload) })
    });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).handle, '@octane');

    const privacy = await fetch(`${base}/v1/me/privacy`, {
      method: 'POST', headers, body: JSON.stringify({ phoneDiscoverable: false, handleSearchable: true })
    });
    assert.equal(privacy.status, 200);

    const profile = await fetch(`${base}/v1/me/profile`, {
      method: 'POST', headers, body: JSON.stringify({ displayName: 'Octane Adeyemi' })
    });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).displayName, 'Octane Adeyemi');

    const claims = await fetch(`${base}/v1/claims`, { headers });
    assert.equal(claims.status, 200);
    assert.deepEqual(await claims.json(), []);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 500).unref(); });
    if (stderr && child.exitCode && child.exitCode !== 0) console.error(stderr);
  }
});
