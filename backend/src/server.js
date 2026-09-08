import http from 'node:http';
import { config, assertSafeConfig } from './config.js';
import { JsonStore } from './lib/jsonStore.js';
import { issueSession, verifySession, normalizeE164, sha256, hex } from './lib/crypto.js';

// Request fingerprint: same Idempotency-Key + different request body is rejected, not replayed.
const fingerprint = (...parts) => hex(sha256(Buffer.from(parts.join('|'))));
import { consumeRateLimit } from './lib/rateLimit.js';
import { withIdempotency } from './lib/idempotency.js';
import { logger } from './lib/logger.js';
import { KeyService } from './services/keyService.js';
import { OtpService } from './services/otpService.js';
import { IdentityService } from './services/identityService.js';
import { ResolverService } from './services/resolverService.js';
import { RequestService } from './services/requestService.js';
import { ClaimService } from './services/claimService.js';
import { PaymentService } from './services/paymentService.js';
import { ActivityService } from './services/activityService.js';
import { AuroraService } from './services/auroraService.js';
import { ProofService } from './services/proofService.js';
import { usdcBalanceOf, claimAuthorizerAddress, relayerAccount, verifyChainId, verifyUsdcDomain } from './chain/eth.js';
import { chainProvider } from './providers/index.js';
import { envioIndexer } from './indexers/index.js';
import { auroraClient } from './aurora/index.js';
import { verifyAlchemySignature, extractTxHashes } from './providers/alchemyWebhook.js';
import { snapshot as metricsSnapshot } from './lib/metrics.js';

assertSafeConfig();

const store = new JsonStore(config.storePath);
const keyService = new KeyService(store, config);
const identityService = new IdentityService({ store, config });
const otpService = new OtpService({ config, store });
const resolverService = new ResolverService({ store, config, keyService, identityService });
const requestService = new RequestService({ store, identityService, config });
const claimService = new ClaimService({ store, config, identityService });
const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
const activityService = new ActivityService({ store, identityService });
const auroraService = new AuroraService({ store, config, identityService, paymentService });
const proofService = new ProofService({ paymentService, identityService, config });

// Replay/idempotency guard for webhook event ids.

// --- router with :param support (exact routes win over param routes) ---------
const exact = new Map();
const params = [];
function route(method, path, handler, auth = false) {
  if (path.includes(':')) {
    const names = [];
    const rx = new RegExp('^' + path.replace(/:([A-Za-z0-9_]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    params.push({ method, rx, names, handler, auth });
  } else {
    exact.set(`${method} ${path}`, { handler, auth });
  }
}
function match(method, pathname) {
  const e = exact.get(`${method} ${pathname}`);
  if (e) return { ...e, params: {} };
  for (const p of params) {
    if (p.method !== method) continue;
    const m = pathname.match(p.rx);
    if (m) { const bag = {}; p.names.forEach((n, i) => (bag[n] = decodeURIComponent(m[i + 1]))); return { handler: p.handler, auth: p.auth, params: bag }; }
  }
  return null;
}

// --- health + config ---------------------------------------------------------
route('GET', '/health', async () => ({ ok: true, chainId: config.chain.chainId.toString() }));
route('GET', '/v1/config', async () => ({
  chainId: config.chain.chainId.toString(),
  usdc: config.chain.usdc,
  usdcDecimals: config.chain.usdcDecimals,
  asset: { symbol: 'USDC', name: 'USD Coin', address: config.chain.usdc, decimals: config.chain.usdcDecimals },
  paymentRouter: config.chain.paymentRouter || null,
  claimVault: config.chain.claimVault || null,
  resolverPublicKey: resolverService.publicKey(),
  claimAuthorizerAddress: safe(() => claimAuthorizerAddress()),
  relayerAddress: safe(() => relayerAccount().address)
}));

// --- onboarding --------------------------------------------------------------
// A single-use, short-lived challenge the app signs with its Mera account so the binding proof can
// never be replayed (F-07). No auth: proving control of the account is the whole point.
route('POST', '/v1/auth/challenge', async () => identityService.issueBindingChallenge());
route('POST', '/v1/auth/otp/start', async ({ body, ip }) => otpService.start(body.phone, ip));
route('POST', '/v1/auth/device', async ({ body }) => {
  const identity = await identityService.createDeviceIdentity({ account: body.account, bindingProof: body.bindingProof, requestedHandle: body.handle, challengeNonce: body.challenge });
  return { session: issueSession({ prismId: identity.prismId }, config.sessionSecret), identity: identityService.publicView(identity) };
});
route('POST', '/v1/auth/otp/check', async ({ body, ip }) => {
  const checked = await otpService.check(body.phone, body.code, ip);
  if (!checked.approved) throw httpError(401, 'invalid verification code');
  const identity = await identityService.upsertVerifiedPhone({ phone: body.phone, account: body.account, bindingProof: body.bindingProof, requestedHandle: body.handle, challengeNonce: body.challenge });
  return { session: issueSession({ prismId: identity.prismId }, config.sessionSecret), identity: identityService.publicView(identity) };
});

route('GET', '/v1/me', async ({ user }) => identityService.publicView(identityService.get(user.prismId)), true);
route('GET', '/v1/me/balance', async ({ user }) => {
  const identity = identityService.get(user.prismId);
  if (!identity?.accountAddress) return { token: config.chain.usdc, symbol: 'USDC', amountAtomic: '0', decimals: config.chain.usdcDecimals };
  const amount = await usdcBalanceOf(identity.accountAddress);
  return { token: config.chain.usdc, symbol: 'USDC', amountAtomic: amount.toString(), decimals: config.chain.usdcDecimals };
}, true);
route('POST', '/v1/me/handle', async ({ user, body }) => identityService.publicView(await identityService.setHandleAuthorized(user.prismId, body.handle, body.accountSignature)), true);
route('POST', '/v1/me/phone/start', async ({ user, body, ip }) => otpService.start(body.phone, `${user.prismId}:${ip}`), true);
route('POST', '/v1/me/phone/check', async ({ user, body, ip }) => {
  const phone = normalizeE164(body.phone);
  const checked = await otpService.check(phone, body.code, `${user.prismId}:${ip}`);
  if (!checked.approved) throw httpError(401, 'invalid verification code');
  return identityService.publicView(await identityService.bindVerifiedPhoneAuthorized(user.prismId, phone, body.accountSignature));
}, true);
route('POST', '/v1/me/privacy', async ({ user, body }) => identityService.publicView(identityService.setPrivacy(user.prismId, body)), true);
route('POST', '/v1/me/profile', async ({ user, body }) => identityService.publicView(identityService.setProfile(user.prismId, body)), true);

// --- protected alias resolution ---------------------------------------------
route('POST', '/v1/resolve/phone', async ({ user, body }) => resolverService.resolvePhone(user.prismId, body.phone), true);
route('POST', '/v1/resolve/handle', async ({ user, body }) => resolverService.resolveHandle(user.prismId, body.handle), true);
route('POST', '/v1/resolve/prism', async ({ user, body }) => resolverService.resolvePrismId(user.prismId, body.prismId), true);

// --- off-chain payment requests ---------------------------------------------
route('POST', '/v1/requests/draft', async ({ user, body }) => requestService.draft({ ...body, requesterPrismId: user.prismId }), true);
route('POST', '/v1/requests/commit', async ({ user, body }) => requestService.commit({ ...body, requesterPrismId: user.prismId }), true);
route('GET', '/v1/requests', async ({ user }) => requestService.listFor(user.prismId), true);
route('POST', '/v1/requests/status', async ({ user, body }) => requestService.setStatus(body.requestId, body.status, user.prismId), true);

// --- direct payments (Prism envelope + USDC ERC-3009 authorization) ---------
route('POST', '/v1/payments/prepare', async ({ user, body }) => {
  rateLimit(`pay-prepare:${user.prismId}`, 60);
  return paymentService.preparePayment({ senderPrismId: user.prismId, resolution: body.resolution, amountAtomic: body.amountAtomic, requestId: body.requestId ?? null, memo: body.memo ?? '', entryMethod: body.entryMethod ?? null });
}, true);
route('POST', '/v1/payments/submit', async ({ user, body, idempotencyKey }) => {
  rateLimit(`pay-submit:${user.prismId}`, 60);
  const tokenSignature = body.tokenSignature;
  requireHex(body.paymentId, 'paymentId'); requireSig(body.prismSignature, 'prismSignature'); requireSig(tokenSignature, 'tokenSignature');
  return withIdempotency(store, { scope: 'pay-submit', key: idempotencyKey, actor: user.prismId, fingerprint: fingerprint(body.paymentId, body.prismSignature, tokenSignature) }, () =>
    paymentService.submitPayment({ paymentId: body.paymentId, prismSignature: body.prismSignature, tokenSignature, actorPrismId: user.prismId }));
}, true);
route('GET', '/v1/payments/:id', async ({ user, params }) => paymentService.reconcile(params.id, user.prismId), true);
// Canonical projection of any operation: { payment, events, receipt }. Reconciles first so the
// canonical view reflects live chain state, then returns the durable projection.
route('GET', '/v1/payments/:id/canonical', async ({ user, params }) => {
  await paymentService.reconcile(params.id, user.prismId).catch(() => {});
  return paymentService.canonicalFor(params.id, user.prismId);
}, true);

// Canonical Payment Proof: typed, evidence-backed inspectability for one operation the caller owns.
// The paymentId must map to a Prism operation visible to the authenticated user (never a raw,
// user-supplied tx hash) — ProofService assembles evidence, the endpoint never trusts client input.
route('GET', '/v1/payments/:id/proof', async ({ user, params }) => proofService.canonical(params.id, user.prismId), true);

// --- claims (send before signup) --------------------------------------------
route('POST', '/v1/claims/prepare', async ({ user, body }) => {
  rateLimit(`claim-prepare:${user.prismId}`, 30);
  return paymentService.prepareClaim({ senderPrismId: user.prismId, recipientPhone: body.recipientPhone, amountAtomic: body.amountAtomic, expirySeconds: body.expirySeconds ?? undefined, memo: body.memo ?? '' });
}, true);
route('GET', '/v1/claims', async ({ user }) => claimService.listFor(identityService.get(user.prismId)), true);
route('GET', '/v1/claims/eligible', async ({ user }) => claimService.eligibleClaimsFor(identityService.get(user.prismId)), true);
route('POST', '/v1/claims/:id/fund', async ({ user, params, body, idempotencyKey }) => {
  requireSig(body.signature, 'signature');
  return withIdempotency(store, { scope: 'claim-fund', key: idempotencyKey, actor: user.prismId, fingerprint: fingerprint(params.id, body.signature) }, () =>
    paymentService.fundClaim({ senderPrismId: user.prismId, claimId: params.id, signature: body.signature }));
}, true);
route('POST', '/v1/claims/:id/claim', async ({ user, params, body, idempotencyKey }) => {
  requireSig(body.recipientIntentSignature, 'recipientIntentSignature');
  return withIdempotency(store, { scope: 'claim-collect', key: idempotencyKey, actor: user.prismId, fingerprint: fingerprint(params.id, body.recipientIntentSignature) }, () =>
    paymentService.collectClaim({ recipientPrismId: user.prismId, claimId: params.id, recipientIntentSignature: body.recipientIntentSignature }));
}, true);
route('POST', '/v1/claims/:id/refund', async ({ user, params, idempotencyKey }) =>
  withIdempotency(store, { scope: 'claim-refund', key: idempotencyKey, actor: user.prismId, fingerprint: fingerprint('refund', params.id) }, () =>
    paymentService.refundClaim({ senderPrismId: user.prismId, claimId: params.id })), true);
route('GET', '/v1/claims/:id', async ({ user, params }) => paymentService.reconcileClaim(params.id, user.prismId), true);

route('GET', '/v1/activity', async ({ user }) => activityService.list(user.prismId), true);

// --- Aurora Intents: receive from any chain ----------------------------------
// Aurora routes a deposit on any supported chain into USDC on Monad at the caller's own account.
// Prism never takes custody and signs nothing here: the deposit address is derived from the user's
// account, so the inbound leg needs no authorization from us.
route('GET', '/v1/aurora/chains', async () => auroraService.chains(), true);
route('POST', '/v1/aurora/deposits/address', async ({ user, body }) => {
  rateLimit(`aurora-address:${user.prismId}`, 30);
  return auroraService.createDepositAddress({ prismId: user.prismId, depositChain: body.depositChain });
}, true);
route('GET', '/v1/aurora/deposits', async ({ user }) => auroraService.listDeposits(user.prismId), true);
route('GET', '/v1/aurora/arrivals', async ({ user }) => auroraService.arrivals(user.prismId), true);
route('GET', '/v1/aurora/deposits/:address', async ({ user, params }) =>
  auroraService.refreshDeposit({ prismId: user.prismId, depositAddress: params.address }), true);

// --- Aurora Intents: send / spend to any chain -------------------------------
// USDC on Monad out to any asset on any chain. The Monad leg is an ordinary router settlement whose
// recipient is Aurora's deposit address; the whole route is bound into the envelope's opaque hash,
// so the payer's one signature authorizes the destination and not merely the address in between.
route('POST', '/v1/aurora/quote', async ({ user, body }) => {
  rateLimit(`aurora-quote:${user.prismId}`, 120);
  return auroraService.quoteSend({
    prismId: user.prismId,
    destinationChain: body.destinationChain,
    destinationAsset: body.destinationAsset,
    destinationAddress: body.destinationAddress,
    amountAtomic: body.amountAtomic,
    contractAddress: body.contractAddress ?? null
  });
}, true);
route('POST', '/v1/aurora/send/prepare', async ({ user, body }) => {
  rateLimit(`aurora-prepare:${user.prismId}`, 60);
  return auroraService.prepareSend({ prismId: user.prismId, routeId: body.routeId });
}, true);
route('POST', '/v1/aurora/send/submit', async ({ user, body, idempotencyKey }) => {
  rateLimit(`aurora-submit:${user.prismId}`, 60);
  requireSig(body.prismSignature, 'prismSignature'); requireSig(body.tokenSignature, 'tokenSignature');
  return withIdempotency(store, { scope: 'aurora-send-submit', key: idempotencyKey, actor: user.prismId, fingerprint: fingerprint(body.routeId, body.prismSignature, body.tokenSignature) }, () =>
    auroraService.submitSend({ prismId: user.prismId, routeId: body.routeId, prismSignature: body.prismSignature, tokenSignature: body.tokenSignature }));
}, true);
route('GET', '/v1/aurora/routes', async ({ user }) => auroraService.listRoutes(user.prismId), true);
route('GET', '/v1/aurora/routes/:id', async ({ user, params }) =>
  auroraService.reconcileRoute({ prismId: user.prismId, routeId: params.id }), true);

// --- infrastructure: Alchemy webhook, dev proof surface, observability -------

// Alchemy webhook (fast live confirmation). Verified by HMAC; deduped; only ever triggers a chain
// readback — a forged/stale webhook can never change state on its own.
route('POST', '/v1/webhooks/alchemy', async ({ body, rawBody, headers }) => {
  if (!verifyAlchemySignature(rawBody, headers['x-alchemy-signature'])) throw httpError(401, 'invalid webhook signature');
  if (body === undefined || typeof body !== 'object') throw httpError(400, 'malformed webhook body');
  const eventId = typeof body.id === 'string' ? body.id : null;
  if (eventId) {
    // Persist the dedupe set so replay protection survives a restart, and reserve the id atomically
    // inside one synchronous mutate so concurrent deliveries can't both pass (F-06 durability).
    let fresh = false;
    store.mutate((d) => {
      d.webhookEvents ??= {};
      if (!d.webhookEvents[eventId]) { d.webhookEvents[eventId] = new Date().toISOString(); fresh = true; }
      const keys = Object.keys(d.webhookEvents);
      if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete d.webhookEvents[k];
    });
    if (!fresh) return { ok: true, deduped: true }; // replay/idempotent
  }
  const hashes = extractTxHashes(body);
  const reconciled = [];
  for (const hash of hashes) {
    const result = await paymentService.reconcileByTxHash(hash); // chain readback, never trust webhook alone
    if (result) reconciled.push({ operationId: result.operationId, state: result.state });
  }
  return { ok: true, reconciled };
});

// Developer/judge proof surface (not for normal consumers). Enabled outside production.
route('GET', '/v1/proof/:paymentId', async ({ user, params }) => {
  if (!config.proofEnabled) throw httpError(404, 'not found');
  return proofService.build(params.paymentId, user.prismId);
}, true);

// Observability snapshot (dev-only): P50/P95 latencies + failure rates.
route('GET', '/v1/metrics', async () => {
  if (!config.proofEnabled) throw httpError(404, 'not found');
  return { chain: { provider: chainProvider().name, rpcHost: chainProvider().rpcHost }, envio: { available: envioIndexer().available() }, aurora: { available: auroraClient().available(), mode: config.aurora.mode }, ...metricsSnapshot() };
});

// --- HTTP server -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let status = 200;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const found = match(req.method, url.pathname);
    if (!found) { status = 404; return send(res, 404, { error: 'not found' }); }

    const parsed = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : { json: {}, raw: '' };
    // Reject malformed JSON everywhere except the webhook, which validates its own raw body.
    if (parsed.json === undefined && parsed.raw && url.pathname !== '/v1/webhooks/alchemy') {
      status = 400; return send(res, 400, { error: 'invalid JSON body' });
    }
    let user = null;
    if (found.auth) {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      user = verifySession(token, config.sessionSecret);
    }
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, 200) : null;
    const result = await found.handler({ body: parsed.json ?? {}, rawBody: parsed.raw, headers: req.headers, user, ip: req.socket.remoteAddress, url, params: found.params, idempotencyKey });
    send(res, 200, result);
    logger.info('http', { method: req.method, path: url.pathname, status: 200, ms: Date.now() - started, prismId: user?.prismId });
  } catch (error) {
    status = error.statusCode || 400;
    send(res, status, { error: error.message });
    logger.error('http', { method: req.method, path: req.url, status, ms: Date.now() - started, error: error.message });
  }
});

server.listen(config.port, async () => {
  logger.info('server.listening', { port: config.port, chainId: config.chain.chainId.toString() });
  await startupIntegrityChecks();
});

// Fail closed in production if the RPC chainId or token domains drift from configuration.
async function startupIntegrityChecks() {
  try {
    const cid = await verifyChainId();
    if (!cid.ok) throw new Error(`chainId mismatch: RPC ${cid.onchain} != configured ${cid.configured}`);
    logger.info('integrity.chainId', cid);
    const domain = await verifyUsdcDomain();
    logger.info('integrity.usdcDomain', { ok: domain.ok });
    if (!domain.ok) throw new Error('USDC EIP-712 domain does not match on-chain DOMAIN_SEPARATOR');
  } catch (e) {
    logger.error('integrity.failed', { error: e.message });
    if (config.nodeEnv === 'production') { console.error('fatal: integrity check failed'); process.exit(1); }
  }
}

function rateLimit(key, limit) { consumeRateLimit(store, key, { limit, windowMs: 60 * 60_000 }); }
function requireSig(v, name) { if (!/^0x[0-9a-fA-F]{130}$/.test(v ?? '')) throw httpError(400, `${name} must be a 65-byte hex signature`); }
function requireHex(v, name) { if (!/^0x[0-9a-fA-F]{64}$/.test(v ?? '')) throw httpError(400, `${name} must be a 32-byte hex value`); }
function safe(fn) { try { return fn(); } catch { return null; } }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function send(res, status, object) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(object));
}
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw httpError(413, 'body too large'); }
  // Lenient parse so raw bytes survive for webhook HMAC verification; handlers validate `json`.
  let json;
  try { json = raw ? JSON.parse(raw) : {}; } catch { json = undefined; }
  return { json, raw };
}
