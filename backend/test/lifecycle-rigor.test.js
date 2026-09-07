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
const { withIdempotency } = await import('../src/lib/idempotency.js');
const lc = await import('../src/lib/lifecycle.js');

function newStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-lc-')), 'store.json')); }
function stack(store = newStore()) {
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
  return { store, resolverService, paymentService };
}
async function submit(paymentService, resolverService) {
  const payer = meraAccount(PK_A);
  const resolution = resolverService.resolvePrismId('payer', 'recip');
  const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });
  const env = prepared.envelope;
  const prismSignature = await payer.signTypedData(paymentEnvelopeTypedData(env));
  const tokenSignature = await payer.signTypedData(receiveAuthorizationTypedData({ from: env.payer, to: checksum(config.chain.paymentRouter), value: env.amount, validAfter: 0, validBefore: env.validBefore, nonce: env.nonce }));
  await paymentService.submitPayment({ paymentId: prepared.paymentId, prismSignature, tokenSignature, actorPrismId: 'payer' });
  return prepared.paymentId;
}

// --- guarded transitions ----------------------------------------------------
test('illegal transitions are rejected; legal ones allowed', () => {
  assert.throws(() => lc.assertTransition('prepared', 'completed'), /illegal/);   // no jumping to completed
  assert.throws(() => lc.assertTransition('completed', 'confirming'), /illegal/); // completed is immutable
  assert.throws(() => lc.assertTransition('completed', 'processing'), /illegal/);
  assert.throws(() => lc.assertTransition('failed', 'completed'), /illegal/);
  assert.equal(lc.canTransition('submitted', 'completed'), true);                 // with a receipt
  assert.equal(lc.canTransition('broadcasting', 'requires_attention'), true);
  assert.equal(lc.canTransition('completed', 'completed'), true);                 // idempotent re-read
});

test('the failure taxonomy maps codes to consumer states and retryability', () => {
  assert.equal(lc.failureCanonical('SUBMISSION_AMBIGUOUS'), 'requiresAttention');
  assert.equal(lc.failureCanonical('TRANSACTION_REVERTED'), 'reverted');
  assert.equal(lc.isRetryable('SUBMISSION_FAILED'), true);
  assert.equal(lc.isRetryable('TRANSACTION_REVERTED'), false);
  assert.equal(lc.FAILURE_TAXONOMY.INDEXING_DELAYED.canonical, 'completed');      // not a failure
});

// --- idempotency fingerprint ------------------------------------------------
test('same key + same fingerprint runs once; same key + different fingerprint is rejected', async () => {
  const store = newStore();
  let runs = 0;
  const producer = async () => { runs += 1; return { ok: runs }; };
  const a = await withIdempotency(store, { scope: 'pay', actor: 'x', key: 'k', fingerprint: 'fp1' }, producer);
  const b = await withIdempotency(store, { scope: 'pay', actor: 'x', key: 'k', fingerprint: 'fp1' }, producer);
  assert.equal(runs, 1);
  assert.deepEqual(a, b);
  await assert.rejects(() => withIdempotency(store, { scope: 'pay', actor: 'x', key: 'k', fingerprint: 'DIFFERENT' }, producer), /already used for a different request/);
});

// --- source-of-truth --------------------------------------------------------
test('a submitted payment is never completed before the chain confirms', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService, store } = stack();
    const id = await submit(paymentService, resolverService);
    const op = store.read().operations[id];
    mock.setReceipt(op.txHash, undefined);                 // not yet mined
    await paymentService.reconcile(id, 'payer');
    const { payment } = paymentService.canonicalFor(id, 'payer');
    assert.notEqual(payment.lifecycleState, 'completed');
    assert.equal(payment.completedAt, null);
  } finally { resetChainProvider(); }
});

test('a reverted transaction never reads as Sent/completed', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService, store } = stack();
    const id = await submit(paymentService, resolverService);
    mock.setReceipt(store.read().operations[id].txHash, { status: 'reverted', transactionHash: '0x', blockNumber: 2n });
    await paymentService.reconcile(id, 'payer');
    const { payment } = paymentService.canonicalFor(id, 'payer');
    assert.equal(payment.lifecycleState, 'reverted');
    assert.notEqual(payment.lifecycleState, 'completed');
  } finally { resetChainProvider(); }
});

test('an indeterminate receipt enters reconciliation_required, not a guessed result', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService, store } = stack();
    const id = await submit(paymentService, resolverService);
    mock.setReceipt(store.read().operations[id].txHash, { status: 'pending', transactionHash: '0x', blockNumber: null });
    await paymentService.reconcile(id, 'payer');
    assert.equal(store.read().operations[id].state, 'reconciliation_required');
    const { payment } = paymentService.canonicalFor(id, 'payer');
    assert.equal(payment.lifecycleState, 'requiresAttention');
    assert.equal(payment.failureCode, 'PROVIDER_DISAGREEMENT');
  } finally { resetChainProvider(); }
});

test('indexing delay does not turn a delivered payment into a failure', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService, store } = stack();
    const id = await submit(paymentService, resolverService);
    await paymentService.reconcile(id, 'payer');                 // completes; Envio not running -> indexed false
    const { payment } = paymentService.canonicalFor(id, 'payer');
    assert.equal(payment.lifecycleState, 'completed');           // delivered stays delivered
    assert.equal(store.read().operations[id].indexed ?? false, false);
  } finally { resetChainProvider(); }
});

test('a completed payment is immutable', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { paymentService, resolverService } = stack();
    const id = await submit(paymentService, resolverService);
    await paymentService.reconcile(id, 'payer');
    assert.throws(() => paymentService._transitionPayment(id, 'completed', 'processing', {}), /illegal|state changed/);
    // A second reconcile is a safe no-op, still completed.
    const again = await paymentService.reconcile(id, 'payer');
    assert.equal(again.state, 'completed');
  } finally { resetChainProvider(); }
});

test('a pending lifecycle is reconstructed from persistence after a restart', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const store = newStore();
    const first = stack(store);
    const id = await submit(first.paymentService, first.resolverService); // state 'submitted', persisted
    // Simulate a relaunch: a brand-new service reading the same store file.
    const second = stack(store);
    const { payment, events } = second.paymentService.canonicalFor(id, 'payer');
    assert.equal(payment.lifecycleState, 'submitted');
    assert.ok(events.some((e) => e.state === 'submitted'));      // history survived
    const reconciled = await second.paymentService.reconcile(id, 'payer'); // resumes to completion
    assert.equal(reconciled.state, 'completed');
  } finally { resetChainProvider(); }
});
