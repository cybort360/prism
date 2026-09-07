import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A, PK_B } from './helpers.js';

process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { KeyService } = await import('../src/services/keyService.js');
const { IdentityService } = await import('../src/services/identityService.js');
const { ResolverService } = await import('../src/services/resolverService.js');
const { RequestService } = await import('../src/services/requestService.js');
const { ClaimService } = await import('../src/services/claimService.js');
const { PaymentService } = await import('../src/services/paymentService.js');
const { paymentEnvelopeTypedData, receiveAuthorizationTypedData, checksum } = await import('../src/chain/eth.js');
const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { makeMockChainProvider } = await import('../src/providers/mockChainProvider.js');
const { canonicalPayment, receiptFor, ensureEvents, lifecycleState } = await import('../src/lib/lifecycle.js');

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-canon-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  store.mutate((d) => {
    d.identities.payer = { prismId: 'payer', account: meraAccount(PK_A).address, accountAddress: meraAccount(PK_A).address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
    d.identities.recip = { prismId: 'recip', account: meraAccount(PK_B).address, accountAddress: meraAccount(PK_B).address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
  });
  return { store, resolverService, paymentService, identityService };
}

async function submitDirect(paymentService, resolverService, { requestId = null, entryMethod = null } = {}) {
  const payer = meraAccount(PK_A);
  const resolution = resolverService.resolvePrismId('payer', 'recip');
  const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '25000000', requestId, entryMethod });
  const env = prepared.envelope;
  const prismSignature = await payer.signTypedData(paymentEnvelopeTypedData(env));
  const tokenSignature = await payer.signTypedData(receiveAuthorizationTypedData({ from: env.payer, to: checksum(config.chain.paymentRouter), value: env.amount, validAfter: 0, validBefore: env.validBefore, nonce: env.nonce }));
  const submit = await paymentService.submitPayment({ paymentId: prepared.paymentId, prismSignature, tokenSignature, actorPrismId: 'payer' });
  return { paymentId: prepared.paymentId, submit };
}

test('direct send becomes ONE PrismPayment with ordered lifecycle events', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService, identityService } = stack();
    const { paymentId } = await submitDirect(paymentService, resolverService);
    await paymentService.reconcile(paymentId, 'payer');
    const { payment, events, receipt } = paymentService.canonicalFor(paymentId, 'payer');

    assert.equal(payment.kind, 'direct');
    assert.equal(payment.direction, 'sent');
    assert.equal(payment.entryMethod, 'contact');
    assert.equal(payment.lifecycleState, 'completed');
    assert.ok(payment.transactionHash);
    assert.equal(receipt.finalStatus, 'completed');
    assert.ok(receipt.settledAt);

    const order = events.map((e) => e.state);
    for (const s of ['created', 'authorized', 'submitted', 'confirmed', 'reconciled', 'completed']) assert.ok(order.includes(s), `event ${s} present`);
    const times = events.map((e) => Date.parse(e.occurredAt));
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], 'events are chronologically ordered');
    // exactly one operation for the payment
    assert.equal(payment.operationId, paymentId);
  } finally { resetChainProvider(); }
});

test('paying a request carries requestId and kind=requestPayment', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService, store } = stack();
    // An OPEN request the payer will settle (payer pays 'recip' the exact amount).
    store.mutate((d) => { d.requests['0xreq123'] = { requestId: '0xreq123', requesterPrismId: 'recip', payerPrismId: 'payer', amountAtomic: '25000000', token: config.chain.usdc, tokenSymbol: 'USDC', memo: '', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), status: 'OPEN' }; });
    const { paymentId } = await submitDirect(paymentService, resolverService, { requestId: '0xreq123' });
    const { payment } = paymentService.canonicalFor(paymentId, 'payer');
    assert.equal(payment.kind, 'requestPayment');
    assert.equal(payment.requestId, '0xreq123');
    assert.equal(payment.entryMethod, 'request');
  } finally { resetChainProvider(); }
});

test('QR payment records the qr entry method and kind=qrPayment', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService } = stack();
    const { paymentId } = await submitDirect(paymentService, resolverService, { entryMethod: 'qr' });
    const { payment } = paymentService.canonicalFor(paymentId, 'payer');
    assert.equal(payment.kind, 'qrPayment');
    assert.equal(payment.entryMethod, 'qr');
  } finally { resetChainProvider(); }
});

test('completed cannot occur before the chain confirms', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService, store } = stack();
    const { paymentId } = await submitDirect(paymentService, resolverService);
    // Simulate "submitted but not yet mined": the tx has no receipt.
    const op = store.read().operations[paymentId];
    mock.setReceipt(op.txHash, undefined);
    await paymentService.reconcile(paymentId, 'payer');
    const { payment, receipt } = paymentService.canonicalFor(paymentId, 'payer');
    assert.notEqual(payment.lifecycleState, 'completed');
    assert.equal(payment.completedAt, null);
    assert.notEqual(receipt.finalStatus, 'completed');
    assert.equal(receipt.settledAt, null);
  } finally { resetChainProvider(); }
});

test('a failed operation preserves failure metadata', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService, store } = stack();
    const { paymentId } = await submitDirect(paymentService, resolverService);
    const op = store.read().operations[paymentId];
    mock.setReceipt(op.txHash, { status: 'reverted', transactionHash: op.txHash, blockNumber: 2n });
    await paymentService.reconcile(paymentId, 'payer');
    const { payment, events } = paymentService.canonicalFor(paymentId, 'payer');
    assert.equal(payment.lifecycleState, 'reverted');
    assert.equal(payment.failureCode, 'TRANSACTION_REVERTED');
    assert.equal(payment.retryable, false);
    assert.ok(events.some((e) => e.state === 'reverted' || e.state === 'failedTerminal'));
  } finally { resetChainProvider(); }
});

test('a receipt survives reconstruction from persisted (legacy, event-less) payment data', () => {
  const { paymentService, store } = stack();
  // A legacy operation record with no events[] — only a mutable state + timestamps.
  const legacy = {
    operationId: '0xlegacy', kind: 'payment', state: 'completed',
    intent: { kind: 'payment', senderPrismId: 'payer', recipientPrismId: 'recip', amountAtomic: '7000000', tokenSymbol: 'USDC', memo: 'legacy' },
    createdAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z',
    transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: '123', indexed: true, indexedAt: '2026-09-01T00:02:00.000Z'
  };
  store.mutate((d) => { d.operations['0xlegacy'] = legacy; });
  const { payment, events, receipt } = paymentService.canonicalFor('0xlegacy', 'payer');
  assert.equal(payment.amountAtomic, '7000000');
  assert.equal(receipt.finalStatus, 'completed');
  assert.ok(receipt.settledAt);
  assert.ok(events.length >= 2, 'events synthesized from timestamps');
  assert.equal(events[0].state, 'created');
});

test('claim funding normalizes to kind=claimFunding and records claimId', () => {
  const { paymentService, store } = stack();
  store.mutate((d) => { d.operations['claim-funding#0xC1'] = { operationId: 'claim-funding#0xC1', kind: 'claim-funding', state: 'completed', intent: { kind: 'claim-funding', senderPrismId: 'payer', claimId: '0xC1', amountAtomic: '5000000', tokenSymbol: 'USDC' }, createdAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z', transactionHash: `0x${'11'.repeat(32)}` }; });
  const { payment } = paymentService.canonicalFor('claim-funding#0xC1', 'payer');
  assert.equal(payment.kind, 'claimFunding');
  assert.equal(payment.entryMethod, 'claim');
  assert.equal(payment.claimId, '0xC1');
  assert.equal(payment.direction, 'sent');
});

test('claim refund normalizes to kind=refund', () => {
  const { paymentService, store } = stack();
  store.mutate((d) => { d.operations['claim-refund#0xC1'] = { operationId: 'claim-refund#0xC1', kind: 'claim-refund', state: 'completed', intent: { kind: 'claim-refund', senderPrismId: 'payer', claimId: '0xC1', amountAtomic: '5000000', tokenSymbol: 'USDC' }, createdAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z', transactionHash: `0x${'22'.repeat(32)}` }; });
  const { payment } = paymentService.canonicalFor('claim-refund#0xC1', 'payer');
  assert.equal(payment.kind, 'refund');
  assert.equal(payment.claimId, '0xC1');
});

test('unknown evidence stays unknown — no synthesized indexed event when never indexed', () => {
  const { paymentService, store } = stack();
  const op = {
    operationId: '0xnoidx', kind: 'payment', state: 'completed',
    intent: { kind: 'payment', senderPrismId: 'payer', recipientPrismId: 'recip', amountAtomic: '1000000', tokenSymbol: 'USDC' },
    createdAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z', transactionHash: `0x${'cd'.repeat(32)}`
    // note: no `indexed` field at all -> unknown, must not become an 'indexed' event
  };
  store.mutate((d) => { d.operations['0xnoidx'] = op; });
  const { payment, events } = paymentService.canonicalFor('0xnoidx', 'payer');
  assert.equal(payment.indexedAt, null);
  assert.ok(!events.some((e) => e.state === 'indexed'), 'indexed evidence is unknown, never fabricated');
});
