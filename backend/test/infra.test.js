import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import crypto from 'node:crypto';
import { meraAccount, PK_A, PK_B } from './helpers.js';

// Configure a fully-wired backend before importing (config reads env at load).
process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
process.env.ALCHEMY_WEBHOOK_SIGNING_KEY = 'whsec_test_key';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { KeyService } = await import('../src/services/keyService.js');
const { IdentityService } = await import('../src/services/identityService.js');
const { ResolverService } = await import('../src/services/resolverService.js');
const { RequestService } = await import('../src/services/requestService.js');
const { ClaimService } = await import('../src/services/claimService.js');
const { PaymentService } = await import('../src/services/paymentService.js');
const { paymentEnvelopeTypedData, transferAuthorizationTypedData } = await import('../src/chain/eth.js');
const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { makeMockChainProvider } = await import('../src/providers/mockChainProvider.js');
const { setEnvioIndexer, resetEnvioIndexer } = await import('../src/indexers/index.js');
const { makeMockEnvioIndexer } = await import('../src/indexers/mockEnvioIndexer.js');
const { verifyAlchemySignature, extractTxHashes } = await import('../src/providers/alchemyWebhook.js');
const metrics = await import('../src/lib/metrics.js');

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-infra-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  return { store, resolverService, paymentService };
}

test('Alchemy webhook signature verification (good / bad / malformed)', () => {
  const raw = JSON.stringify({ id: 'evt_1', event: {} });
  const good = crypto.createHmac('sha256', 'whsec_test_key').update(raw, 'utf8').digest('hex');
  assert.equal(verifyAlchemySignature(raw, good), true);
  assert.equal(verifyAlchemySignature(raw, 'deadbeef'), false);
  assert.equal(verifyAlchemySignature(raw, undefined), false);
  assert.deepEqual(extractTxHashes({ event: { activity: [{ hash: `0x${'ab'.repeat(32)}` }] } }), [`0x${'ab'.repeat(32)}`]);
  assert.deepEqual(extractTxHashes({ garbage: true }), []);
});

test('payment path uses the Alchemy provider AND the Envio consumer, and records metrics', async () => {
  metrics.reset();
  const mockChain = makeMockChainProvider();
  const mockEnvio = makeMockEnvioIndexer();
  setChainProvider(mockChain);
  setEnvioIndexer(mockEnvio);
  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A);
    const recipient = meraAccount(PK_B);
    store.mutate(d => {
      d.identities.payer = { prismId: 'payer', account: payer.address, accountAddress: payer.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
      d.identities.recip = { prismId: 'recip', account: recipient.address, accountAddress: recipient.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
    });

    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '25000000' });

    const env = prepared.envelope;
    const prismSignature = await payer.signTypedData(paymentEnvelopeTypedData(env));
    const ausdSignature = await payer.signTypedData(transferAuthorizationTypedData({ from: env.payer, to: env.recipient, value: env.amount, validAfter: 0, validBefore: env.validBefore, nonce: env.nonce }));

    const submit = await paymentService.submitPayment({ paymentId: prepared.paymentId, prismSignature, ausdSignature, actorPrismId: 'payer' });
    assert.equal(submit.state, 'submitted');
    // Alchemy provider path exercised: simulate + submit.
    assert.ok(mockChain.calls.simulateContract >= 1, 'simulateContract used');
    assert.ok(mockChain.calls.writeContract >= 1, 'writeContract used');

    // Envio has now indexed the on-chain PaymentSettled.
    mockEnvio.indexPayment({ id: prepared.paymentId, payer: env.payer, recipient: env.recipient, amount: env.amount });

    const reconciled = await paymentService.reconcile(prepared.paymentId, 'payer');
    assert.equal(reconciled.state, 'completed'); // chain (Alchemy receipt) is canonical
    assert.ok(mockChain.calls.getTransactionReceipt >= 1, 'Alchemy receipt read used');
    assert.equal(reconciled.indexed, true, 'Envio indexing detected');
    assert.ok(mockEnvio.calls.isPaymentIndexed >= 1, 'Envio consumer used');

    const snap = metrics.snapshot();
    for (const m of ['payment_prepare_ms', 'relay_submit_ms', 'chain_confirmation_ms', 'end_to_end_payment_ms', 'envio_index_ms']) {
      assert.ok(snap.latencies[m]?.count >= 1, `metric recorded: ${m}`);
    }
    assert.equal(snap.operations.payment.success, 1);
    assert.equal(snap.operations.payment.failureRate, 0);
  } finally {
    resetChainProvider();
    resetEnvioIndexer();
  }
});

test('completed payment stays "not indexed" until Envio catches up (no fake completion)', async () => {
  const mockChain = makeMockChainProvider();
  const mockEnvio = makeMockEnvioIndexer(); // nothing indexed
  setChainProvider(mockChain);
  setEnvioIndexer(mockEnvio);
  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
    store.mutate(d => {
      d.identities.payer = { prismId: 'payer', account: payer.address, accountAddress: payer.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
      d.identities.recip = { prismId: 'recip', account: recipient.address, accountAddress: recipient.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
    });
    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '10000000' });
    const env = prepared.envelope;
    const prismSignature = await payer.signTypedData(paymentEnvelopeTypedData(env));
    const ausdSignature = await payer.signTypedData(transferAuthorizationTypedData({ from: env.payer, to: env.recipient, value: env.amount, validAfter: 0, validBefore: env.validBefore, nonce: env.nonce }));
    await paymentService.submitPayment({ paymentId: prepared.paymentId, prismSignature, ausdSignature, actorPrismId: 'payer' });
    const reconciled = await paymentService.reconcile(prepared.paymentId, 'payer');
    assert.equal(reconciled.state, 'completed');   // chain confirmed
    assert.equal(reconciled.indexed, false);        // Envio lagging → honest indexing state, not faked
  } finally {
    resetChainProvider();
    resetEnvioIndexer();
  }
});
