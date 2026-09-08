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
const { phoneLookupKey, encryptString } = await import('../src/lib/crypto.js');
const { relayerAccount } = await import('../src/chain/eth.js');

const ZERO32 = `0x${'00'.repeat(32)}`;
const PHONE = '+2348100000000';

const envioOff = { available: () => false, isPaymentIndexed: async () => false, getPayment: async () => null, getRequestSettlement: async () => null, getAccountActivity: async () => [], getClaims: async () => [] };
const envioPending = { ...envioOff, available: () => true };

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-proof-')), 'store.json');
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

function seedIdentities(store) {
  const sender = meraAccount(PK_A);
  const recipient = meraAccount(PK_B);
  const key = phoneLookupKey(PHONE, config.resolverPepper);
  store.mutate(d => {
    d.identities.sender = { prismId: 'sender', account: sender.address, accountAddress: sender.address, aliasVersion: 1, handle: 'octane', displayName: 'Octane' };
    d.identities.recipient = { prismId: 'recipient', account: recipient.address, accountAddress: recipient.address, aliasVersion: 4, handle: 'tobi', displayName: 'Tobi Bakare', phoneLookupKey: key, phoneEncrypted: encryptString(PHONE, config.dataEncryptionKeyHex) };
  });
  return { sender, recipient, key };
}

function paymentOp(store, { state = 'completed', txHash = `0x${'ab'.repeat(32)}`, resolutionHash = `0x${'cd'.repeat(32)}`, requestId = ZERO32, nonce = `0x${'ef'.repeat(32)}`, senderPrismId = 'sender', recipientPrismId = 'recipient', amount = '20000000' } = {}) {
  const id = store.paymentSeq = (store.paymentSeq || 0) + 1;
  const paymentId = `0x${id.toString(16).padStart(64, '0')}`;
  const s = store.read().identities[senderPrismId];
  const r = store.read().identities[recipientPrismId];
  const now = new Date().toISOString();
  const op = {
    operationId: paymentId, kind: 'payment', state,
    env: { paymentId, payer: s.accountAddress, recipient: r.accountAddress, amount, requestId, resolutionHash, validBefore: 9999999999, nonce },
    intent: { kind: 'payment', senderPrismId, recipientPrismId, amountAtomic: amount, token: config.chain.usdc, tokenSymbol: 'USDC', requestId: requestId !== ZERO32 ? 'req_lunch' : null, memo: 'Lunch', aliasVersion: 4, entryMethod: 'contacts', resolutionRequestId: 'res_abc123' },
    events: [{ state: 'created', source: 'app', title: 'Payment created', occurredAt: now }],
    createdAt: now, submittedAt: now, broadcastAt: now,
    completedAt: state === 'completed' ? now : null,
    completedAtMs: state === 'completed' ? Date.now() : null,
    blockNumber: state === 'completed' ? '38420119' : null,
    txHash, transactionHash: state === 'completed' ? txHash : null, indexed: false
  };
  store.mutate(d => { d.operations[paymentId] = op; });
  return paymentId;
}

function confirmedReceipt({ logs = [] } = {}) {
  return { status: 'success', transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: 38420119n, from: relayerAccount().address, logs };
}

// --- verified fixture ------------------------------------------------------
test('proof: a confirmed testnet payment is VERIFIED with E3 and honest sub-checks', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n, balance: 0n });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const id = paymentOp(store);
    const proof = await proofService.canonical(id, 'sender');
    assert.equal(proof.proofStatus, 'verified');
    assert.equal(proof.evidenceLevel, 'E3');
    assert.equal(proof.privacy.calldataCheck, 'pass');
    assert.equal(proof.privacy.sensitiveOnchain, 'no');
    assert.equal(proof.verification.monadReceipt, 'pass');
    assert.equal(proof.gas.sponsored, 'pass');
    assert.equal(proof.settlement.status, 'confirmed');
    assert.equal(proof.settlement.blockNumber, '38420119');
    assert.ok(proof.settlement.explorerUrl.includes(`/tx/0x${'ab'.repeat(32)}`));
    assert.equal(proof.recipient.handle, '@tobi');
    assert.equal(proof.recipient.resolutionVersion, 4);
    assert.ok(proof.evidence.some(e => e.type === 'privacyCalldataCheck' && e.status === 'pass'));
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- pending / unknown -----------------------------------------------------
test('proof: a submitted-but-unmined payment is PENDING, never verified', async () => {
  const mock = makeMockChainProvider({ readContract: () => 0n });
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const id = paymentOp(store, { state: 'submitted', txHash: `0x${'12'.repeat(32)}` }); // no receipt scripted
    const proof = await proofService.canonical(id, 'sender');
    assert.equal(proof.proofStatus, 'pending');
    assert.equal(proof.verification.monadReceipt, 'pending');
    assert.notEqual(proof.evidenceLevel, 'E3');
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- Alchemy unavailable ---------------------------------------------------
test('proof: when the chain read fails, alchemy readback is unavailable (not faked)', async () => {
  const mock = makeMockChainProvider({ readContract: () => { throw new Error('rpc down'); } });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const id = paymentOp(store);
    const proof = await proofService.canonical(id, 'sender');
    assert.equal(proof.verification.alchemyReadback, 'unavailable');
    assert.equal(proof.verification.balanceDelta, 'unavailable');
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- Envio pending ---------------------------------------------------------
test('proof: Envio pending and not-configured are distinct states', async () => {
  try {
    const mock = makeMockChainProvider({ readContract: () => 50000000n });
    mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
    setChainProvider(mock);

    setEnvioIndexer(envioPending);
    let s = stack(); seedIdentities(s.store);
    let proof = await s.proofService.canonical(paymentOp(s.store), 'sender');
    assert.equal(proof.verification.envioIndex, 'pending');

    setEnvioIndexer(envioOff);
    s = stack(); seedIdentities(s.store);
    proof = await s.proofService.canonical(paymentOp(s.store), 'sender');
    assert.equal(proof.verification.envioIndex, 'not_configured');
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- privacy: phone-derived hash on-chain MUST FAIL ------------------------
test('proof: a phone-derived value in calldata FAILS the privacy check', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    const { key } = seedIdentities(store);
    // Regression: resolutionHash accidentally derived from the phone lookup key.
    const id = paymentOp(store, { resolutionHash: key });
    const proof = await proofService.canonical(id, 'sender');
    assert.equal(proof.privacy.calldataCheck, 'fail');
    assert.equal(proof.privacy.sensitiveOnchain, 'yes');
    assert.notEqual(proof.proofStatus, 'verified');
    assert.ok(proof.privacy.detail.matches.some(m => m.field === 'resolutionHash'));
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- privacy: raw phone verbatim in calldata MUST FAIL ---------------------
test('proof: a raw phone number verbatim in a calldata field FAILS', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const id = paymentOp(store, { nonce: '2348100000000' }); // raw phone digits leaked into a field
    const proof = await proofService.canonical(id, 'sender');
    assert.equal(proof.privacy.calldataCheck, 'fail');
    assert.ok(proof.privacy.detail.matches.some(m => m.field === 'nonce'));
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- privacy: event-log scan catches a leaked identifier -------------------
test('proof: a prohibited identifier in an event log FAILS the event check', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    const seeded = seedIdentities(store);
    mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt({ logs: [{ topics: [`0x${'00'.repeat(32)}`, seeded.key], data: '0x' }] }));
    const id = paymentOp(store);
    const proof = await proofService.canonical(id, 'sender');
    assert.equal(proof.privacy.eventCheck, 'fail');
    assert.equal(proof.privacy.sensitiveOnchain, 'yes');
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- request binding -------------------------------------------------------
test('proof: a request-bound payment proves the binding from the signed envelope', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const id = paymentOp(store, { requestId: `0x${'99'.repeat(32)}` });
    const proof = await proofService.canonical(id, 'sender');
    assert.ok(proof.request);
    assert.equal(proof.request.boundToPayment, 'yes');
    assert.ok(proof.evidence.some(e => e.type === 'requestBinding' && e.status === 'pass'));
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- claim proof & refund proof --------------------------------------------
function seedClaim(store, status, { expiry = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  const key = phoneLookupKey(PHONE, config.resolverPepper);
  const claimId = `0x${'c1'.repeat(32)}`;
  store.mutate(d => {
    d.claims[claimId] = { claimId, recipientReference: `0x${'r1'.repeat(32)}`, senderPrismId: 'sender', recipientPhoneLookupKey: key, amountAtomic: '20000000', token: config.chain.usdc, tokenSymbol: 'USDC', memo: 'Dinner', expiry, status, createdAt: new Date().toISOString(), claimTransactionHash: `0x${'ab'.repeat(32)}`, refundTransactionHash: `0x${'ab'.repeat(32)}`, claimedAt: new Date().toISOString() };
  });
  return claimId;
}

test('proof: a collected claim proves protection, dual-signature eligibility, and delivery', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const claimId = seedClaim(store, 'claimed');
    const opId = `claim-collection#${claimId}`;
    store.mutate(d => {
      d.operations[opId] = { operationId: opId, kind: 'claim-collection', state: 'completed', intent: { kind: 'claim-collection', recipientPrismId: 'recipient', claimId, amountAtomic: '20000000' }, events: [], createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), txHash: `0x${'ab'.repeat(32)}`, transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: '38420119', indexed: false };
    });
    const proof = await proofService.canonical(opId, 'recipient');
    assert.ok(proof.claim);
    assert.equal(proof.claim.fundsProtected, 'yes');
    assert.equal(proof.claim.recipientEligibility, 'verified');
    assert.equal(proof.direction, 'received');
    assert.ok(proof.evidence.some(e => e.type === 'claimState'));
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

test('proof: a refunded claim proves expiry and restoration to the original sender', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const claimId = seedClaim(store, 'refunded', { expiry: Math.floor(Date.now() / 1000) - 10 });
    const opId = `claim-refund#${claimId}`;
    store.mutate(d => {
      d.operations[opId] = { operationId: opId, kind: 'claim-refund', state: 'completed', intent: { kind: 'claim-refund', senderPrismId: 'sender', claimId, amountAtomic: '20000000' }, events: [], createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), txHash: `0x${'ab'.repeat(32)}`, transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: '38420119', indexed: false };
    });
    const proof = await proofService.canonical(opId, 'sender');
    assert.equal(proof.claim.refund, 'confirmed');
    assert.equal(proof.claim.senderRestored, 'verified');
    assert.ok(proof.claim.expiredAt);
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- authorization boundary ------------------------------------------------
test('proof: another user cannot read a payment proof they do not own', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const id = paymentOp(store);
    await assert.rejects(() => proofService.canonical(id, 'intruder'), /belongs to another caller/);
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});

// --- authorization / OTP never a spending authority ------------------------
test('proof: spending authority is the Mera passkey, OTP is never used for spending', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  mock.setReceipt(`0x${'ab'.repeat(32)}`, confirmedReceipt());
  setChainProvider(mock); setEnvioIndexer(envioOff);
  try {
    const { store, proofService } = stack();
    seedIdentities(store);
    const proof = await proofService.canonical(paymentOp(store), 'sender');
    assert.equal(proof.authorization.method, 'Mera passkey');
    assert.equal(proof.authorization.otpForSpending, 'no');
  } finally {
    resetChainProvider(); resetEnvioIndexer();
  }
});
