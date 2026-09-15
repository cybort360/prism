import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import { meraAccount, PK_A } from './helpers.js';

/**
 * ROUTE AUDIT — the Circles HTTP surface.
 *
 * Two questions, asked of the surface itself rather than of the service behind it:
 *
 *  1. **Can an unauthenticated caller reach anything?** Every Circle route must be declared with
 *     authentication on, and the running server must actually refuse without a session.
 *  2. **Can a caller aim a Circle operation somewhere of their choosing?** No route may accept a
 *     Safe address, a transaction target, calldata, an operation type or a token from the request.
 *     The Safe always comes from the Circle record the caller belongs to, and the only Safe call
 *     Prism will build is one of the eight Circle intents. That is what makes "the backend cannot
 *     redirect a Circle's money" a property of the request shape rather than a validation rule
 *     somebody has to remember.
 */

const SERVER = new URL('../src/server.js', import.meta.url);
const source = readFileSync(SERVER, 'utf8');

/** Every `route(METHOD, PATH, handler, auth)` declaration, with the handler body it was given. */
function routeTable(src) {
  const routes = [];
  const rx = /route\(\s*'(GET|POST|PUT|DELETE)'\s*,\s*'([^']+)'\s*,/g;
  let match;
  while ((match = rx.exec(src)) !== null) {
    // The declaration runs to the closing `, true);` / `, false);` of this call. Find it by walking
    // parentheses from the opening one, so a handler containing parentheses is handled correctly.
    let depth = 0;
    let i = src.indexOf('(', match.index);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    const declaration = src.slice(start, i + 1);
    const tail = declaration.slice(-12);
    routes.push({
      method: match[1],
      path: match[2],
      declaration,
      authenticated: /,\s*true\s*\)$/.test(declaration) || /true\s*\)$/.test(tail)
    });
  }
  return routes;
}

const ROUTES = routeTable(source);
const CIRCLE_ROUTES = ROUTES.filter((r) => r.path.startsWith('/v1/circles'));

test('route audit: the parser found the Circle surface it is supposed to be auditing', () => {
  assert.ok(ROUTES.length > 30, `expected a full route table, parsed ${ROUTES.length}`);
  assert.ok(CIRCLE_ROUTES.length >= 25, `expected the Circle surface, parsed ${CIRCLE_ROUTES.length}`);
  // A few that must exist, so a silent rename cannot empty this audit.
  for (const path of [
    '/v1/circles', '/v1/circles/:id', '/v1/circles/:id/activity', '/v1/circles/:id/contributions/prepare',
    '/v1/circles/:id/payments/propose', '/v1/circles/:id/payments/:proposalId/approve',
    '/v1/circles/:id/payments/:proposalId/execute', '/v1/circles/:id/spend/prepare',
    '/v1/circles/:id/close/finalize'
  ]) {
    assert.ok(CIRCLE_ROUTES.some((r) => r.path === path), `missing route ${path}`);
  }
});

test('route audit: every Circle route requires an authenticated caller', () => {
  const open = CIRCLE_ROUTES.filter((r) => !r.authenticated);
  assert.deepEqual(open.map((r) => `${r.method} ${r.path}`), [],
    'a Circle route declared without authentication');
});

test('route audit: no Circle route accepts a Safe address, a target, calldata or a token', () => {
  // The request fields a caller could use to aim a Circle operation somewhere else. `body.token`
  // included: a Circle is USDC-only, and the token is taken from configuration in every path.
  const forbidden = [
    'body.safeAddress', 'body.safe', 'body.to', 'body.data', 'body.calldata', 'body.target',
    'body.operation', 'body.token', 'body.recipientAddress', 'body.module'
  ];
  const offences = [];
  for (const route of CIRCLE_ROUTES) {
    for (const field of forbidden) {
      // Whole-field matching: `body.tokenSignature` is a signature over a payload the backend built,
      // not a token the caller chose, and must not read as an offence.
      const rx = new RegExp(`${field.replace('.', '\\.')}(?![A-Za-z0-9_])`);
      if (rx.test(route.declaration)) offences.push(`${route.method} ${route.path} reads ${field}`);
    }
  }
  assert.deepEqual(offences, [], 'a Circle route took a chain-level parameter from the caller');

  // The recipient of a Circle payment arrives as a signed resolver attestation, never as an address.
  const pay = CIRCLE_ROUTES.find((r) => r.path === '/v1/circles/:id/payments/propose');
  assert.match(pay.declaration, /resolution: body\.resolution/);
  const spend = CIRCLE_ROUTES.find((r) => r.path === '/v1/circles/:id/spend/prepare');
  assert.match(spend.declaration, /resolution: body\.resolution/);
});

test('route audit: every money-moving Circle route is idempotency-guarded', () => {
  // Submitting money twice because a response was lost must not move it twice.
  const mustBeGuarded = [
    '/v1/circles',                                      // creation deploys a Safe
    '/v1/circles/:id/contributions/:contributionId/submit',
    '/v1/circles/:id/payments/:proposalId/approve',
    '/v1/circles/:id/payments/:proposalId/execute',
    '/v1/circles/:id/spend/:spendId/submit',
    '/v1/circles/:id/governance/:proposalId/approve',
    '/v1/circles/:id/governance/:proposalId/execute'
  ];
  for (const path of mustBeGuarded) {
    const route = CIRCLE_ROUTES.find((r) => r.path === path);
    assert.ok(route, `missing route ${path}`);
    assert.match(route.declaration, /withIdempotency/, `${path} is not idempotency-guarded`);
  }
});

test('route audit: the running server refuses an unauthenticated caller on every Circle route', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-route-audit-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, PORT: String(port), STORE_PATH: path.join(dir, 'store.json'),
      NODE_ENV: 'development', MONAD_CHAIN_ID: '10143'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/health`);

    // 1. No session: every Circle route answers 401, whatever it is.
    const unauthorized = [];
    for (const route of CIRCLE_ROUTES) {
      const url = base + route.path.replace(/:[A-Za-z0-9_]+/g, 'cir_probe');
      const response = await fetch(url, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        body: route.method === 'GET' ? undefined : '{}'
      });
      if (response.status !== 401) unauthorized.push(`${route.method} ${route.path} → ${response.status}`);
    }
    assert.deepEqual(unauthorized, [], 'a Circle route answered an unauthenticated caller');

    // 2. With a real session, a Circle you are not a member of is not found — not forbidden, which
    //    would confirm it exists.
    const owner = meraAccount(PK_A);
    const { nonce } = await (await fetch(`${base}/v1/auth/challenge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })).json();
    const auth = await (await fetch(`${base}/v1/auth/device`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: owner.address, bindingProof: await owner.bindingProof(nonce), challenge: nonce, handle: null })
    })).json();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${auth.session}` };

    for (const url of [
      `${base}/v1/circles/cir_someoneelses`,
      `${base}/v1/circles/cir_someoneelses/activity`,
      `${base}/v1/circles/cir_someoneelses/members`,
      `${base}/v1/circles/cir_someoneelses/payments`,
      `${base}/v1/circles/cir_someoneelses/close`
    ]) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 404, `${url} leaked the existence of a Circle`);
    }

    // 3. And an authenticated caller's own list is simply empty, not an error.
    const mine = await fetch(`${base}/v1/circles`, { headers });
    assert.equal(mine.status, 200);
    assert.deepEqual((await mine.json()).circles, []);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 500).unref(); });
    if (stderr && child.exitCode && child.exitCode !== 0) console.error(stderr);
  }
});

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

async function waitFor(url, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not become ready: ${url}`);
}
