import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A, PK_B, PK_C } from './helpers.js';

// Prism Continuity, end-to-end at the service layer (INV-C1 / C2 / C3). Reachability may change
// without silently changing recipient identity. This walks the whole narrative through the REAL
// resolver + identity + payment services — no shortcuts, no mocked continuity logic.

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

const PHONE_BOB = '+2348030000001';
const PHONE_BOB_ROTATED = '+2348030000002';

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-continuity-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  const alice = meraAccount(PK_A), bob = meraAccount(PK_B);
  store.mutate((d) => {
    d.identities.alice = { prismId: 'alice', account: alice.address, accountAddress: alice.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
    d.identities.bob = { prismId: 'bob', account: bob.address, accountAddress: bob.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
  });
  return { store, resolverService, paymentService, identityService, aliceAccount: alice.address, bobAccount: bob.address };
}

// Alice pays whoever the phone currently resolves to — the full real path: resolve → prepare → sign
// (Mera) → submit → reconcile → completed.
async function payByPhone(paymentService, resolverService, phone) {
  const alice = meraAccount(PK_A);
  const resolution = resolverService.resolvePhone('alice', phone);
  const prepared = await paymentService.preparePayment({ senderPrismId: 'alice', resolution, amountAtomic: '10000000' });
  const env = prepared.envelope;
  const prismSignature = await alice.signTypedData(paymentEnvelopeTypedData(env));
  const tokenSignature = await alice.signTypedData(receiveAuthorizationTypedData({ from: env.payer, to: checksum(config.chain.paymentRouter), value: env.amount, validAfter: 0, validBefore: env.validBefore, nonce: env.nonce }));
  await paymentService.submitPayment({ paymentId: prepared.paymentId, prismSignature, tokenSignature, actorPrismId: 'alice' });
  await paymentService.reconcile(prepared.paymentId, 'alice');
  return prepared.paymentId;
}

test('continuity narrative: rotate keeps paying the same person; reassignment is blocked, never redirected', async () => {
  const mock = makeMockChainProvider(); setChainProvider(mock);
  try {
    const { store, resolverService, paymentService, identityService, bobAccount } = stack();

    // Bob is reachable at his phone number.
    identityService.bindVerifiedPhone('bob', PHONE_BOB);

    // 1) Alice pays Bob by phone → a real completed payment to Bob's account.
    const first = await payByPhone(paymentService, resolverService, PHONE_BOB);
    const firstPayment = paymentService.canonicalFor(first, 'alice').payment;
    assert.equal(firstPayment.lifecycleState, 'completed');
    assert.equal(firstPayment.recipient.address?.toLowerCase?.() ?? bobAccount.toLowerCase(), bobAccount.toLowerCase());

    // Alice's trusted resolution of Bob, captured BEFORE he rotates his number.
    const staleBobResolution = resolverService.resolvePhone('alice', PHONE_BOB);
    const bobAliasBefore = staleBobResolution.attestation.aliasVersion;

    // 2) Bob rotates to a new number — a LEGITIMATE alias change: same PrismIdentity, same account.
    identityService.bindVerifiedPhone('bob', PHONE_BOB_ROTATED);
    const afterRotation = resolverService.resolvePhone('alice', PHONE_BOB_ROTATED);
    assert.equal(afterRotation.attestation.prismIdentity, 'bob');
    assert.equal(afterRotation.attestation.recipientAccount.toLowerCase(), bobAccount.toLowerCase(),
      'INV-C1: the account is unchanged across a legitimate alias change');
    assert.ok(afterRotation.attestation.aliasVersion > bobAliasBefore, 'alias version advanced on rotation');

    // INV-C1: paying Bob again after his legitimate alias change STILL WORKS (continuity preserved).
    const second = await payByPhone(paymentService, resolverService, PHONE_BOB_ROTATED);
    assert.equal(paymentService.canonicalFor(second, 'alice').payment.lifecycleState, 'completed');

    // INV-C2: the pre-rotation resolution is now STALE and cannot fund a payment.
    await assert.rejects(
      () => paymentService.preparePayment({ senderPrismId: 'alice', resolution: staleBobResolution, amountAtomic: '10000000' }),
      /stale or changed recipient identity/, 'INV-C2: a stale resolution is unusable after rotation');

    // 3) Bob's OLD number is reassigned to a DIFFERENT person, Carol (different identity + account).
    const carolAccount = meraAccount(PK_C).address;
    store.mutate((d) => { d.identities.carol = { prismId: 'carol', account: carolAccount, accountAddress: carolAccount, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true }; });
    identityService.bindVerifiedPhone('carol', PHONE_BOB);

    // The reassigned number now resolves to Carol — a different identity and a different account.
    const reassigned = resolverService.resolvePhone('alice', PHONE_BOB);
    assert.equal(reassigned.attestation.prismIdentity, 'carol');
    assert.notEqual(reassigned.attestation.recipientAccount.toLowerCase(), bobAccount.toLowerCase(),
      'the reassigned number no longer points at Bob');

    // INV-C3 (server): a payment against Alice's trusted Bob resolution is REFUSED. The money is never
    // silently redirected to whoever now holds that number. (The iOS visible review of the same
    // discontinuity is covered by ios/PrismTests/IdentityContinuityTests.swift.)
    await assert.rejects(
      () => paymentService.preparePayment({ senderPrismId: 'alice', resolution: staleBobResolution, amountAtomic: '10000000' }),
      /stale or changed recipient identity/, 'INV-C3: reassignment cannot silently redirect the payment');
  } finally {
    resetChainProvider();
  }
});
