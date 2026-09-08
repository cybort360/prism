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
const { ProofService } = await import('../src/services/proofService.js');
const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { makeMockChainProvider } = await import('../src/providers/mockChainProvider.js');
const { setEnvioIndexer, resetEnvioIndexer } = await import('../src/indexers/index.js');
const { relayerAccount } = await import('../src/chain/eth.js');

const envioOff = { available: () => false, isPaymentIndexed: async () => false, getPayment: async () => null, getRequestSettlement: async () => null };

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-corr-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  const proofService = new ProofService({ paymentService, identityService, config });
  return { store, paymentService, proofService };
}

function seed(store) {
  const sender = meraAccount(PK_A), recipient = meraAccount(PK_B);
  store.mutate(d => {
    d.identities.sender = { prismId: 'sender', account: sender.address, accountAddress: sender.address, aliasVersion: 1, handle: 'octane' };
    d.identities.recipient = { prismId: 'recipient', account: recipient.address, accountAddress: recipient.address, aliasVersion: 4, handle: 'tobi' };
  });
  return { sender, recipient };
}

test('proof correlation: paymentId, operationId, requestId, tx hash and evidence all correlate — no orphans', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, paymentService, proofService } = stack();
    const { sender, recipient } = seed(store);
    const paymentId = `0x${'ab'.repeat(32)}`;
    const txHash = `0x${'cd'.repeat(32)}`;
    const now = new Date().toISOString();
    store.mutate(d => {
      d.operations[paymentId] = {
        operationId: paymentId, kind: 'payment', state: 'completed',
        env: { paymentId, payer: sender.address, recipient: recipient.address, amount: '15000000', requestId: `0x${'99'.repeat(32)}`, resolutionHash: `0x${'ef'.repeat(32)}`, validBefore: 9999999999, nonce: `0x${'12'.repeat(32)}` },
        intent: { kind: 'payment', senderPrismId: 'sender', recipientPrismId: 'recipient', amountAtomic: '15000000', token: config.chain.usdc, tokenSymbol: 'USDC', requestId: 'req_lunch01', memo: 'Lunch', aliasVersion: 4, entryMethod: 'contacts', resolutionRequestId: 'res_abc' },
        events: [], createdAt: now, submittedAt: now, completedAt: now, blockNumber: '38420119',
        txHash, transactionHash: txHash, indexed: false
      };
    });
    mock.setReceipt(txHash, { status: 'success', transactionHash: txHash, blockNumber: 38420119n, from: relayerAccount().address, logs: [] });

    const proof = await proofService.canonical(paymentId, 'sender');
    const canonical = paymentService.canonicalFor(paymentId, 'sender');

    // paymentId == operationId across proof, canonical payment and receipt.
    assert.equal(proof.paymentId, paymentId);
    assert.equal(canonical.payment.paymentId, paymentId);
    assert.equal(canonical.receipt.operationId, paymentId);

    // requestId correlates payment ↔ proof ↔ receipt.
    assert.equal(canonical.payment.requestId, 'req_lunch01');
    assert.equal(proof.request.requestId, 'req_lunch01');
    assert.equal(canonical.receipt.requestId, 'req_lunch01');

    // Transaction hash correlates op ↔ proof ↔ receipt.
    assert.equal(proof.settlement.txHash, txHash);
    assert.equal(canonical.receipt.transactionHash, txHash);

    // Every evidence item is anchored to THIS operation — no orphan evidence.
    for (const e of proof.evidence) {
      assert.ok(e.id.endsWith(paymentId), `evidence ${e.type} is not anchored to the operation`);
    }
    const receiptEvidence = proof.evidence.find(e => e.type === 'transactionReceipt');
    assert.equal(receiptEvidence.reference, txHash, 'receipt evidence references the same tx hash');
    const bindingEvidence = proof.evidence.find(e => e.type === 'requestBinding');
    assert.equal(bindingEvidence.reference, 'req_lunch01', 'request-binding evidence references the same requestId');
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

test('proof correlation: a claim payment correlates claimId across operation, claim record and proof', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, paymentService, proofService } = stack();
    seed(store);
    const claimId = `0x${'c1'.repeat(32)}`;
    const txHash = `0x${'cd'.repeat(32)}`;
    const opId = `claim-collection#${claimId}`;
    const now = new Date().toISOString();
    store.mutate(d => {
      d.claims[claimId] = { claimId, recipientReference: `0x${'r1'.repeat(32)}`, senderPrismId: 'sender', recipientPhoneLookupKey: `0x${'aa'.repeat(32)}`, amountAtomic: '20000000', token: config.chain.usdc, tokenSymbol: 'USDC', memo: 'Dinner', expiry: Math.floor(Date.now() / 1000) + 3600, status: 'claimed', createdAt: now, claimTransactionHash: txHash, claimedAt: now };
      d.operations[opId] = { operationId: opId, kind: 'claim-collection', state: 'completed', intent: { kind: 'claim-collection', recipientPrismId: 'recipient', claimId, amountAtomic: '20000000' }, events: [], createdAt: now, completedAt: now, txHash, transactionHash: txHash, blockNumber: '38420119', indexed: false };
    });
    mock.setReceipt(txHash, { status: 'success', transactionHash: txHash, blockNumber: 38420119n, from: relayerAccount().address, logs: [] });

    const proof = await proofService.canonical(opId, 'recipient');
    const canonical = paymentService.canonicalFor(opId, 'recipient');

    assert.equal(proof.claim.claimId, claimId);
    assert.equal(canonical.payment.claimId, claimId);
    assert.equal(store.read().claims[claimId].claimId, claimId);
    const claimEvidence = proof.evidence.find(e => e.type === 'claimState');
    assert.equal(claimEvidence.reference, claimId, 'claim evidence references the same claimId');
    assert.ok(claimEvidence.id.endsWith(opId), 'claim evidence is anchored to the collection operation');
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});
