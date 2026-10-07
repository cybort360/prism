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
    assert.equal(body.applinks.details[0].components[0]['/'], '/pay/*');
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
