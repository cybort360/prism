import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) { try { const r = await fetch(url); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`server did not become ready: ${url}`);
}
function boot(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-aasa-'));
  return spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, STORE_PATH: path.join(dir, 'store.json'), NODE_ENV: 'development', MONAD_CHAIN_ID: '10143', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('AASA is served with the configured Apple App ID when APPLE_APP_ID is set', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const appId = 'ABCDE12345.com.prism.mobile';
  const child = boot({ PORT: String(port), APPLE_APP_ID: appId });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/health`);
    const res = await fetch(`${base}/.well-known/apple-app-site-association`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json();
    assert.deepEqual(body.webcredentials.apps, [appId]);
    assert.deepEqual(body.applinks.details[0].appIDs, [appId]);
    const components = body.applinks.details[0].components;
    const patterns = components.map((c) => c['/']);
    // Payment links open the app: the opaque /pay/<id> form and the pretty /<handle> form.
    assert.ok(patterns.includes('/pay/*'), 'opaque payment links are covered');
    assert.ok(patterns.includes('/*'), 'pretty @handle links are covered');
    // The API, the AASA, and the bare passkey origin must NOT open the app, and the exclusions must
    // come before the catch-all so first-match-wins keeps them out of the app.
    const excluded = components.filter((c) => c.exclude).map((c) => c['/']);
    assert.ok(excluded.includes('/v1/*'), '/v1/* is excluded');
    assert.ok(excluded.includes('/.well-known/*'), '/.well-known/* is excluded');
    assert.ok(patterns.indexOf('/v1/*') < patterns.indexOf('/*'), 'exclusions precede the catch-all');
  } finally { child.kill(); }
});

test('payment-link web fallback serves HTML for /pay/<id> and /<handle>, 404s junk, and never shadows the API', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const child = boot({ PORT: String(port) });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/health`);

    const pay = await fetch(`${base}/pay/pid_abc123`);
    assert.equal(pay.status, 200);
    assert.match(pay.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await pay.text(), /Get Prism/);

    const handle = await fetch(`${base}/fury`);
    assert.equal(handle.status, 200);
    const handleBody = await handle.text();
    assert.match(handleBody, /@fury/);
    // The fallback must never leak an address or resolve the recipient.
    assert.doesNotMatch(handleBody, /0x[0-9a-fA-F]{40}/);

    // Reserved route words and too-short handles are not handles.
    assert.equal((await fetch(`${base}/claim`)).status, 404);
    assert.equal((await fetch(`${base}/a`)).status, 404);

    // The API still answers JSON — the catch-all handle route must not shadow it.
    const cfg = await fetch(`${base}/v1/config`);
    assert.equal(cfg.status, 200);
    assert.match(cfg.headers.get('content-type') ?? '', /application\/json/);
  } finally { child.kill(); }
});

test('AASA is not served (404) when APPLE_APP_ID is unset', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const child = boot({ PORT: String(port) }); // no APPLE_APP_ID
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/health`);
    const res = await fetch(`${base}/.well-known/apple-app-site-association`);
    assert.equal(res.status, 404);
  } finally { child.kill(); }
});
