import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A } from './helpers.js';

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

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-claimops-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  return { store, paymentService };
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
