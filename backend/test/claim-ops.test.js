import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A, PK_B, PK_C } from './helpers.js';

// Fully-wired backend (config reads env at load).
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
const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { makeMockChainProvider } = await import('../src/providers/mockChainProvider.js');
const { claimIntentTypedData } = await import('../src/chain/eth.js');
const { phoneLookupKey, normalizeE164 } = await import('../src/lib/crypto.js');

function stack(file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-claimops-')), 'store.json')) {
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  return { file, store, claimService, paymentService };
}

// Fund a claim to the 'funded' state and return the pieces the rest of the lifecycle needs.
async function fundedClaim({ senderHandle = 'octane', phone = '+2348100000000', file } = {}) {
  const s = stack(file);
  const sender = meraAccount(PK_A);
  s.store.mutate(d => {
    d.identities.sender = { prismId: 'sender', account: sender.address, accountAddress: sender.address, aliasVersion: 1, handle: senderHandle, displayName: null, phoneDiscoverable: true, handleSearchable: true };
  });
  const prepared = await s.paymentService.prepareClaim({ senderPrismId: 'sender', recipientPhone: phone, amountAtomic: '5000000', expirySeconds: 3600 });
  const claimId = prepared.claimId;
  const signature = await sender.signTypedData(prepared.typedData);
  await s.paymentService.fundClaim({ senderPrismId: 'sender', claimId, signature });
  await s.paymentService.reconcile(`claim-funding#${claimId}`, 'sender');
  return { ...s, sender, claimId, phone };
}

// A recipient who controls the claim's phone alias, joined AFTER the claim was funded.
function addRecipient(store, phone, { handle = 'david' } = {}) {
  const recipient = meraAccount(PK_B);
  const key = phoneLookupKey(normalizeE164(phone), config.resolverPepper);
  store.mutate(d => {
    d.identities.recipient = { prismId: 'recipient', account: recipient.address, accountAddress: recipient.address, aliasVersion: 1, phoneLookupKey: key, phoneDiscoverable: true, handleSearchable: true, handle, displayName: null };
    d.phoneIndex[key] = 'recipient';
  });
  return recipient;
}

async function collect(paymentService, claimId, recipient) {
  const intent = claimIntentTypedData({ claimId, recipient: recipient.address });
  const recipientIntentSignature = await recipient.signTypedData(intent);
  return paymentService.collectClaim({ recipientPrismId: 'recipient', claimId, recipientIntentSignature });
}

// F-03 — funding and refund of the same claim must be distinct operation records so neither the tx
// evidence nor the actor/intent of one action overwrites the other.
test('F-03: claim funding and refund are separate operation records (no aliasing)', async () => {
  const mockChain = makeMockChainProvider();
  setChainProvider(mockChain);
  try {
    const { store, paymentService } = stack();
    const sender = meraAccount(PK_A);
    store.mutate(d => {
      d.identities.sender = { prismId: 'sender', account: sender.address, accountAddress: sender.address, aliasVersion: 1, phoneDiscoverable: true, handleSearchable: true };
    });

    const prepared = await paymentService.prepareClaim({ senderPrismId: 'sender', recipientPhone: '+2348100000000', amountAtomic: '5000000', expirySeconds: 3600 });
    const claimId = prepared.claimId;
    assert.ok(store.read().operations[`claim-funding#${claimId}`], 'funding op is keyed distinctly from the claimId');

    const signature = await sender.signTypedData(prepared.typedData);
    const funded = await paymentService.fundClaim({ senderPrismId: 'sender', claimId, signature });
    assert.equal(funded.state, 'submitted');
    const fundTx = store.read().operations[`claim-funding#${claimId}`].txHash;
    assert.ok(fundTx, 'funding op carries its own tx hash');

    await paymentService.reconcile(`claim-funding#${claimId}`, 'sender');
    assert.equal(store.read().claims[claimId].status, 'funded');

    // Expire the claim and refund it.
    store.mutate(d => { d.claims[claimId].expiry = Math.floor(Date.now() / 1000) - 10; });
    const refunded = await paymentService.refundClaim({ senderPrismId: 'sender', claimId });
    assert.equal(refunded.state, 'submitted');

    const ops = store.read().operations;
    const fundOp = ops[`claim-funding#${claimId}`];
    const refundOp = ops[`claim-refund#${claimId}`];
    assert.ok(fundOp && refundOp, 'funding and refund are separate operation records');
    assert.equal(fundOp.kind, 'claim-funding', 'funding op is not overwritten by the refund');
    assert.equal(refundOp.kind, 'claim-refund');
    assert.notEqual(fundOp.txHash, refundOp.txHash, 'each execution keeps its own tx evidence');
    assert.equal(fundOp.intent.senderPrismId, 'sender');
    assert.equal(refundOp.intent.senderPrismId, 'sender');

    // The claim's own record still preserves both tx hashes independently.
    const claim = store.read().claims[claimId];
    assert.ok(claim.fundingTransactionHash || fundOp.transactionHash, 'funding evidence retained');
  } finally {
    resetChainProvider();
  }
});

// The recipient must see who sent the money ("from Octane") but never any phone or account address.
test('claim: recipient sees the sender public display, never a phone or address', async () => {
  setChainProvider(makeMockChainProvider());
  try {
    const { store, claimService, sender, claimId, phone } = await fundedClaim({ senderHandle: 'octane' });
    addRecipient(store, phone);
    const eligible = claimService.eligibleClaimsFor(store.read().identities.recipient);
    assert.equal(eligible.length, 1, 'the funded claim is eligible for the matching alias');
    assert.equal(eligible[0].senderDisplay, '@octane', 'recipient sees the sender public handle');
    assert.equal(eligible[0].claimId, claimId);

    const blob = JSON.stringify(eligible).toLowerCase();
    assert.ok(!blob.includes(sender.address.toLowerCase()), 'no sender address in the recipient view');
    assert.ok(!blob.includes('2348100000000'), 'no raw phone in the recipient view');
    assert.ok(!blob.includes('phonelookupkey'), 'no phone-derived key in the recipient view');
  } finally {
    resetChainProvider();
  }
});

// The full network-effect story: fund → protected → recipient verified → claimed, each a real state.
test('claim lifecycle: fund → protected → claimed is fully represented in the canonical model', async () => {
  setChainProvider(makeMockChainProvider());
  try {
    const { store, paymentService, claimId, phone } = await fundedClaim();
    assert.equal(store.read().claims[claimId].status, 'funded', 'money is protected before anyone claims');

    const recipient = addRecipient(store, phone);
    const collected = await collect(paymentService, claimId, recipient);
    assert.equal(collected.state, 'submitted');

    const collectOpId = `claim-collection#${claimId}`;
    await paymentService.reconcile(collectOpId, 'recipient');
    assert.equal(store.read().claims[claimId].status, 'claimed', 'claim reaches the terminal claimed state');

    const { payment, events } = paymentService.canonicalFor(collectOpId, 'recipient');
    assert.equal(payment.kind, 'claimSettlement');
    assert.equal(payment.direction, 'received');
    // The lifecycle is a real ordered history, not a single mutable flag.
    const states = events.map(e => e.state);
    assert.ok(states.includes('created'), 'has a created event');
    assert.ok(states.includes('submitted'), 'has a submitted event');
    assert.ok(states.includes('confirmed') || states.includes('completed'), 'has a confirmation event');
  } finally {
    resetChainProvider();
  }
});

// Precise terminal copy depends on precise backend errors: already received vs. wrong alias.
test('claim: a wrong alias and an already-claimed payment fail with distinct, precise reasons', async () => {
  setChainProvider(makeMockChainProvider());
  try {
    const { store, paymentService, claimId, phone } = await fundedClaim();
    const recipient = addRecipient(store, phone);

    // A different alias (no matching phone key) is not eligible for this claim.
    const stranger = meraAccount(PK_C);
    store.mutate(d => { d.identities.stranger = { prismId: 'stranger', account: stranger.address, accountAddress: stranger.address, aliasVersion: 1, phoneLookupKey: 'unrelated-key', handle: 'stranger' }; });
    const strangerIntent = await stranger.signTypedData(claimIntentTypedData({ claimId, recipient: stranger.address }));
    await assert.rejects(
      () => paymentService.collectClaim({ recipientPrismId: 'stranger', claimId, recipientIntentSignature: strangerIntent }),
      /not eligible/, 'wrong alias → not eligible');

    // The rightful recipient claims it.
    await collect(paymentService, claimId, recipient);
    await paymentService.reconcile(`claim-collection#${claimId}`, 'recipient');

    // A second attempt is rejected as already received (never double-spent).
    await assert.rejects(() => collect(paymentService, claimId, recipient), /already received/, 'double claim → already received');
  } finally {
    resetChainProvider();
  }
});

// A funded claim survives an app/process restart: state lives in the store + event log, not memory.
test('claim: a waiting claim is reconstructed after a restart', async () => {
  setChainProvider(makeMockChainProvider());
  try {
    const { file, claimId } = await fundedClaim();

    // Simulate a cold restart: brand-new service graph over the same persisted store file.
    const restarted = stack(file);
    const claim = restarted.store.read().claims[claimId];
    assert.equal(claim.status, 'funded', 'the protected claim is still waiting after restart');

    const recipient = addRecipient(restarted.store, '+2348100000000');
    const collected = await collect(restarted.paymentService, claimId, recipient);
    assert.equal(collected.state, 'submitted', 'the reconstructed claim can still be collected');
    await restarted.paymentService.reconcile(`claim-collection#${claimId}`, 'recipient');
    assert.equal(restarted.store.read().claims[claimId].status, 'claimed');
  } finally {
    resetChainProvider();
  }
});
