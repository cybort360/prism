import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A, PK_B } from './helpers.js';

// A fully-wired backend (config reads env at import time).
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
const { paymentEnvelopeTypedData, transferAuthorizationTypedData } = await import('../src/chain/eth.js');
const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { makeMockChainProvider } = await import('../src/providers/mockChainProvider.js');

/**
 * FORGE hostile mutation audit — the backend half.
 *
 * Each test names the mutation it performs and asserts the system refuses it. The contract half
 * lives in contracts/test/ (envelope tampering, replay, double-claim, refund ordering); these cover
 * the mutations that only exist above the chain: stale resolver responses, alias enumeration,
 * a chain revert the backend must not paper over, and a lost relayer response.
 */

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-mut-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  return { store, keyService, identityService, resolverService, claimService, paymentService };
}

function seedPair(store, payer, recipient) {
  store.mutate(d => {
    d.identities.payer = { prismId: 'payer', account: payer.address, accountAddress: payer.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
    d.identities.recip = { prismId: 'recip', account: recipient.address, accountAddress: recipient.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
  });
}

async function signBoth(payer, env) {
  return {
    prismSignature: await payer.signTypedData(paymentEnvelopeTypedData(env)),
    tokenSignature: await payer.signTypedData(transferAuthorizationTypedData({
      from: env.payer, to: env.recipient, value: env.amount, validAfter: 0, validBefore: env.validBefore, nonce: env.nonce
    }))
  };
}

// --- MUT-04: reuse a revoked / stale resolver response -----------------------

test('MUT-04 a resolver response is rejected once the recipient identity moves on', async () => {
  const { store, resolverService, paymentService } = stack();
  const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
  seedPair(store, payer, recipient);

  const resolution = resolverService.resolvePrismId('payer', 'recip');
  // The recipient rotates their alias (or their account is repointed) after the response was issued.
  store.mutate(d => { d.identities.recip.aliasVersion = 2; });

  await assert.rejects(
    () => paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' }),
    /stale or changed recipient identity/,
    'a stale alias version must not be payable'
  );

  // And an account swap under a still-current version is refused too.
  store.mutate(d => { d.identities.recip.aliasVersion = 1; d.identities.recip.accountAddress = '0x000000000000000000000000000000000000dEaD'; });
  await assert.rejects(
    () => paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' }),
    /stale or changed recipient identity/,
    'a repointed account must not be payable on an old resolution'
  );
});

test('MUT-04 a resolver response issued for someone else cannot be replayed', async () => {
  const { store, resolverService } = stack();
  const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
  seedPair(store, payer, recipient);
  const resolution = resolverService.resolvePrismId('payer', 'recip');

  assert.throws(() => resolverService.verifyResolution(resolution, 'someone-else'), /another requester/);
  // Tampering with the attested account breaks the resolver signature.
  const tampered = { ...resolution, attestation: { ...resolution.attestation, recipientAccount: '0x000000000000000000000000000000000000dEaD' } };
  assert.throws(() => resolverService.verifyResolution(tampered, 'payer'), /invalid resolver signature/);
});

// --- MUT-13: bulk unauthenticated / enumerating alias lookup -----------------

test('MUT-13 bulk alias lookup is rate limited, and lookups require an authenticated requester', async () => {
  const { store, resolverService, identityService } = stack();
  const owner = meraAccount(PK_A);
  await identityService.upsertVerifiedPhone({ phone: '+2348031234567', account: owner.address, bindingProof: await owner.bindingProof() });

  // Every resolver entry point is requester-scoped: there is no anonymous lookup to call.
  for (const fn of ['resolvePhone', 'resolveHandle', 'resolvePrismId']) {
    assert.equal(resolverService[fn].length >= 2, true, `${fn} must take a requester identity`);
  }

  // An attacker sweeping the phone space is cut off well before covering any meaningful range.
  let allowed = 0;
  let limited = false;
  for (let i = 0; i < 200; i++) {
    try { resolverService.resolvePhone('attacker', `+234803100${String(i).padStart(4, '0')}`); allowed++; }
    catch (e) { assert.equal(e.statusCode, 429); limited = true; break; }
  }
  assert.equal(limited, true, 'enumeration was never rate limited');
  assert.ok(allowed <= 60, `rate limit allowed ${allowed} lookups before tripping`);

  // The throttle is durable: it lives in the store, so a process restart does not reset it.
  const persisted = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.ok(Object.keys(persisted.rateLimits).some(k => k.startsWith('resolve:attacker')), 'rate limit state is not persisted');
});

// --- MUT-15: the chain reverted, the backend must not report success ---------

test('MUT-15 a reverted transaction is reported failed, never completed', async () => {
  const mock = makeMockChainProvider();
  setChainProvider(mock);
  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
    seedPair(store, payer, recipient);

    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });
    const sigs = await signBoth(payer, prepared.envelope);
    const submitted = await paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' });
    assert.equal(submitted.state, 'submitted', 'submission is not success');

    // Monad mined it, and it reverted.
    mock.setReceipt(submitted.txHash, { status: 'reverted', transactionHash: submitted.txHash, blockNumber: 42n });

    const reconciled = await paymentService.reconcile(prepared.paymentId, 'payer');
    assert.equal(reconciled.state, 'failed', 'a reverted payment must never read as completed');
    assert.notEqual(reconciled.state, 'completed');

    // And it stays failed on re-read — no later state can launder it into a success.
    assert.equal((await paymentService.reconcile(prepared.paymentId, 'payer')).state, 'failed');
  } finally { resetChainProvider(); }
});

test('MUT-15 a submitted-but-unmined payment reports confirming, not completed', async () => {
  const mock = makeMockChainProvider();
  setChainProvider(mock);
  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
    seedPair(store, payer, recipient);
    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });
    const sigs = await signBoth(payer, prepared.envelope);
    const submitted = await paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' });

    mock.receipts.delete(submitted.txHash); // not yet mined
    const reconciled = await paymentService.reconcile(prepared.paymentId, 'payer');
    assert.equal(reconciled.state, 'confirming');
  } finally { resetChainProvider(); }
});

// --- MUT-16: the relayer response is lost after broadcast --------------------

test('MUT-16 a lost relayer response reconciles against the chain and never re-broadcasts', async () => {
  let broadcasts = 0;
  let authorizationUsed = true; // the lost transaction DID reach the chain
  const mock = makeMockChainProvider({
    readContract: () => authorizationUsed
  });
  // The transaction is broadcast, then the response is lost in flight.
  mock.writeContract = async () => { broadcasts++; throw Object.assign(new Error('socket hang up'), { name: 'HttpRequestError' }); };
  setChainProvider(mock);

  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
    seedPair(store, payer, recipient);
    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });
    const sigs = await signBoth(payer, prepared.envelope);

    await assert.rejects(() => paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' }), /socket hang up/);
    assert.equal(broadcasts, 1);
    // The operation must remember that a broadcast was attempted.
    assert.equal(store.read().operations[prepared.paymentId].state, 'broadcasting');

    // The client retries. The backend must ask the chain, not re-send.
    const retry = await paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' });
    assert.equal(broadcasts, 1, 'the payment was re-broadcast after an ambiguous submission');
    assert.equal(retry.state, 'confirming', 'an ambiguous submission must resolve to a polling state');
    assert.notEqual(retry.state, 'completed');
  } finally { resetChainProvider(); }
});

test('MUT-16 an authorization that never landed is safe to retry', async () => {
  let broadcasts = 0;
  const mock = makeMockChainProvider({ readContract: () => false }); // nonce never consumed
  const realWrite = mock.writeContract;
  mock.writeContract = async (...args) => {
    broadcasts++;
    if (broadcasts === 1) throw Object.assign(new Error('socket hang up'), { name: 'HttpRequestError' });
    return realWrite(...args);
  };
  setChainProvider(mock);

  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
    seedPair(store, payer, recipient);
    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });
    const sigs = await signBoth(payer, prepared.envelope);

    await assert.rejects(() => paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' }));
    // Chain says the authorization was never used, so the retry is re-armed...
    const rearmed = await paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' });
    assert.equal(rearmed.state, 'prepared');
    // ...and only then does a genuine second broadcast happen.
    const sent = await paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' });
    assert.equal(sent.state, 'submitted');
    assert.equal(broadcasts, 2);
  } finally { resetChainProvider(); }
});

test('MUT-16 a simulation revert is a clean failure and does not strand the payment', async () => {
  const mock = makeMockChainProvider();
  mock.simulateContract = async () => { throw Object.assign(new Error('execution reverted: PaymentAlreadyUsed'), { name: 'ContractFunctionRevertedError' }); };
  setChainProvider(mock);
  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
    seedPair(store, payer, recipient);
    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });
    const sigs = await signBoth(payer, prepared.envelope);

    await assert.rejects(() => paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' }), /PaymentAlreadyUsed/);
    // Nothing was broadcast, so the record must be retryable rather than stuck 'broadcasting'.
    assert.equal(store.read().operations[prepared.paymentId].state, 'prepared');
  } finally { resetChainProvider(); }
});

// --- MUT-08/09: the backend never re-signs or re-uses an envelope ------------

test('MUT-08 a submitted payment is not re-submittable, and its nonce is single-use', async () => {
  const mock = makeMockChainProvider();
  setChainProvider(mock);
  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
    seedPair(store, payer, recipient);
    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });
    const sigs = await signBoth(payer, prepared.envelope);

    const first = await paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' });
    const writes = mock.calls.writeContract;
    const second = await paymentService.submitPayment({ paymentId: prepared.paymentId, ...sigs, actorPrismId: 'payer' });
    assert.equal(mock.calls.writeContract, writes, 'a settled payment was broadcast twice');
    assert.equal(second.txHash, first.txHash);

    // Each prepare mints a fresh single-use ERC-3009 nonce and paymentId.
    const other = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });
    assert.notEqual(other.envelope.nonce, prepared.envelope.nonce);
    assert.notEqual(other.paymentId, prepared.paymentId);
  } finally { resetChainProvider(); }
});

test('MUT-06 a payment prepared for one recipient cannot be submitted with another payer signature', async () => {
  const mock = makeMockChainProvider();
  setChainProvider(mock);
  try {
    const { store, resolverService, paymentService } = stack();
    const payer = meraAccount(PK_A), recipient = meraAccount(PK_B);
    seedPair(store, payer, recipient);
    const resolution = resolverService.resolvePrismId('payer', 'recip');
    const prepared = await paymentService.preparePayment({ senderPrismId: 'payer', resolution, amountAtomic: '20000000' });

    // Signatures produced by anyone other than the payer are refused before any broadcast.
    const impostor = meraAccount(`0x${'44'.repeat(32)}`);
    const bad = await signBoth(impostor, prepared.envelope);
    await assert.rejects(
      () => paymentService.submitPayment({ paymentId: prepared.paymentId, ...bad, actorPrismId: 'payer' }),
      /does not match the payer/
    );
    assert.equal(mock.calls.writeContract, 0, 'a forged signature reached the relayer');

    // And a payment cannot be submitted by a different Prism account.
    const good = await signBoth(payer, prepared.envelope);
    await assert.rejects(
      () => paymentService.submitPayment({ paymentId: prepared.paymentId, ...good, actorPrismId: 'recip' }),
      /belongs to another caller/
    );
  } finally { resetChainProvider(); }
});
