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
const { ActivityService } = await import('../src/services/activityService.js');
const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { makeMockChainProvider } = await import('../src/providers/mockChainProvider.js');
const { setEnvioIndexer, resetEnvioIndexer } = await import('../src/indexers/index.js');
const { phoneLookupKey, encryptString } = await import('../src/lib/crypto.js');
const { relayerAccount } = await import('../src/chain/eth.js');

// The one fixture phone the whole audit hunts for.
const PHONE = '+2348031234567';
const DIGITS = PHONE.replace(/\D/g, '');            // 2348031234567
const HASH = phoneLookupKey(PHONE, config.resolverPepper); // deterministic phone-derived key
const HASH_BARE = HASH.replace(/^0x/, '');

const envioOff = { available: () => false, isPaymentIndexed: async () => false, getPayment: async () => null, getRequestSettlement: async () => null, getAccountActivity: async () => [], getClaims: async () => [] };

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-leak-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  const proofService = new ProofService({ paymentService, identityService, config });
  const activityService = new ActivityService({ store, identityService });
  return { store, identityService, resolverService, paymentService, proofService, activityService };
}

// A public/on-chain/evidence surface must contain NEITHER the raw phone NOR its deterministic hash.
function assertClean(label, value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.ok(!s.includes(PHONE), `${label} leaked the raw phone`);
  assert.ok(!s.includes(DIGITS), `${label} leaked the phone digits`);
  assert.ok(!s.toLowerCase().includes(HASH_BARE.toLowerCase()), `${label} leaked the phone-derived hash`);
}

test('phone-leak audit: no public / on-chain / evidence surface contains the fixture phone or its hash', async () => {
  const mock = makeMockChainProvider({ readContract: () => 50000000n });
  setChainProvider(mock); setEnvioIndexer(envioOff);

  // Capture everything the backend logs during the flow.
  const logs = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));

  try {
    const s = stack();
    const sender = meraAccount(PK_A);
    const recipient = meraAccount(PK_B);
    s.store.mutate(d => {
      d.identities.sender = { prismId: 'sender', account: sender.address, accountAddress: sender.address, aliasVersion: 1, handle: 'octane', displayName: 'Octane', phoneDiscoverable: true, handleSearchable: true };
      d.identities.recipient = { prismId: 'recipient', account: recipient.address, accountAddress: recipient.address, aliasVersion: 4, handle: 'tobi', displayName: 'Tobi Bakare', phoneDiscoverable: true, handleSearchable: true, phoneLookupKey: HASH, phoneEncrypted: encryptString(PHONE, config.dataEncryptionKeyHex) };
      d.phoneIndex[HASH] = 'recipient';
      d.handleIndex = d.handleIndex || {}; d.handleIndex.tobi = 'recipient'; d.handleIndex.octane = 'sender';
    });

    // A confirmed direct payment, with realistic event logs (addresses + amount, never a phone).
    const paymentId = `0x${'ab'.repeat(32)}`;
    const txHash = `0x${'cd'.repeat(32)}`;
    const now = new Date().toISOString();
    s.store.mutate(d => {
      d.operations[paymentId] = {
        operationId: paymentId, kind: 'payment', state: 'completed',
        env: { paymentId, payer: sender.address, recipient: recipient.address, amount: '20000000', requestId: `0x${'00'.repeat(32)}`, resolutionHash: `0x${'ef'.repeat(32)}`, validBefore: 9999999999, nonce: `0x${'12'.repeat(32)}` },
        intent: { kind: 'payment', senderPrismId: 'sender', recipientPrismId: 'recipient', amountAtomic: '20000000', token: config.chain.usdc, tokenSymbol: 'USDC', requestId: null, memo: 'Dinner', aliasVersion: 4, entryMethod: 'contacts', resolutionRequestId: 'res_abc' },
        events: [{ state: 'created', source: 'app', title: 'Payment created', occurredAt: now }],
        createdAt: now, submittedAt: now, completedAt: now, blockNumber: '38420119',
        txHash, transactionHash: txHash, indexed: false
      };
    });
    mock.setReceipt(txHash, { status: 'success', transactionHash: txHash, blockNumber: 38420119n, from: relayerAccount().address, logs: [{ topics: [`0x${'00'.repeat(32)}`, `0x000000000000000000000000${sender.address.slice(2)}`, `0x000000000000000000000000${recipient.address.slice(2)}`], data: `0x${(20000000).toString(16).padStart(64, '0')}` }] });

    // Generate every public/evidence surface.
    const proof = await s.proofService.canonical(paymentId, 'sender');
    const canonical = s.paymentService.canonicalFor(paymentId, 'sender');
    const activitySender = s.activityService.list('sender');
    const activityRecipient = s.activityService.list('recipient');
    const publicRecipient = s.identityService.publicView(s.store.read().identities.recipient);
    const resolvedByPhone = s.resolverService.resolvePhone('sender', PHONE);
    const resolvedByHandle = s.resolverService.resolveHandle('sender', 'tobi');
    const opJson = s.store.read().operations[paymentId];
    const receipt = mock.receipts.get(txHash);

    assertClean('proof JSON', proof);
    assertClean('canonical projection', canonical);
    assertClean('activity (sender)', activitySender);
    assertClean('activity (recipient)', activityRecipient);
    assertClean('resolver attestation (phone route)', resolvedByPhone);
    assertClean('resolver attestation (handle route)', resolvedByHandle);
    assertClean('operation JSON', opJson);
    assertClean('contract event fixture', receipt);

    // The public identity view may show a MASKED phone, but never the raw number or the hash.
    const pub = JSON.stringify(publicRecipient);
    assert.ok(!pub.includes(PHONE), 'public identity view leaked the raw phone');
    assert.ok(!pub.includes(DIGITS), 'public identity view leaked the phone digits');
    assert.ok(!pub.toLowerCase().includes(HASH_BARE.toLowerCase()), 'public identity view leaked the phone-derived hash');

    // Nothing the backend logged during the flow contains the phone or its hash.
    assertClean('backend logs', logs.join('\n'));

    // Private authenticated record: the encrypted phone blob is allowed to exist, but must not be
    // the raw phone in the clear; the deterministic key IS allowed here (it is the private index key).
    const rec = s.store.read().identities.recipient;
    const blob = JSON.stringify(rec.phoneEncrypted);
    assert.ok(!blob.includes(PHONE) && !blob.includes(DIGITS), 'encrypted phone must not be stored in the clear');
    assert.equal(rec.phoneLookupKey, HASH, 'the private lookup key is the deterministic hash (allowed privately)');
  } finally {
    console.log = origLog; console.error = origErr;
    resetChainProvider(); resetEnvioIndexer();
  }
});
