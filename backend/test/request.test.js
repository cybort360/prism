import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';
import { RequestService } from '../src/services/requestService.js';
import { meraAccount, PK_A, PK_B } from './helpers.js';

const USDC = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const config = {
  limits: { maxPaymentAtomic: 10_000_000_000n },
  chain: { usdc: USDC }
};
function fixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-')), 'store.json');
  const store = new JsonStore(file);
  const a = meraAccount(PK_A), b = meraAccount(PK_B);
  store.mutate(d => {
    d.identities.a = { prismId: 'a', account: a.address, accountAddress: a.address };
    d.identities.b = { prismId: 'b', account: b.address, accountAddress: b.address };
  });
  const identityService = { get: id => store.read().identities[id] ?? null };
  return { store, a, b, service: new RequestService({ store, identityService, config }) };
}

test('payment request requires the requester account signature before OPEN', async () => {
  const { a, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', memo: 'Lunch' });
  assert.equal(draft.request.status, 'DRAFT');
  const committed = await service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: await a.signMessage(draft.signable) });
  assert.equal(committed.status, 'OPEN');
});

test('a request forged by another account cannot be committed', async () => {
  const { a, b, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', memo: 'Lunch' });
  await assert.rejects(
    () => service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: b.signMessage(draft.signable) }),
    /invalid request signature/
  );
});

test('request payment is bound to payer recipient and amount', async () => {
  const { a, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', memo: 'Lunch' });
  await service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: await a.signMessage(draft.signable) });
  assert.equal(service.assertPayable({ requestId: draft.request.requestId, payerPrismId: 'b', recipientPrismId: 'a', amountAtomic: '15000000' }).requestId, draft.request.requestId);
  assert.throws(() => service.assertPayable({ requestId: draft.request.requestId, payerPrismId: 'b', recipientPrismId: 'a', amountAtomic: '16000000' }), /amount/);
  assert.throws(() => service.assertPayable({ requestId: draft.request.requestId, payerPrismId: 'a', recipientPrismId: 'a', amountAtomic: '15000000' }), /payer/);
});

test('request is stored with canonical USDC metadata', async () => {
  const { a, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', memo: 'Dinner' });
  assert.equal(draft.request.token.toLowerCase(), USDC.toLowerCase());
  assert.equal(draft.request.tokenSymbol, 'USDC');
  await service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: await a.signMessage(draft.signable) });
});

test('markPaid records a cross-chain payer when given one', async () => {
  const { a, store, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', amountAtomic: '20000000', destination: 'PRIMARY' });
  await service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: await a.signMessage(draft.signable) });
  service.markPaid(draft.request.requestId, null, '0xdeliver', { payerAddress: '0xAbc0000000000000000000000000000000000001', sourceChain: 'base' });
  const stored = store.read().requests[draft.request.requestId];
  assert.equal(stored.status, 'PAID');
  assert.equal(stored.crossChainPayer.payerAddress, '0xAbc0000000000000000000000000000000000001');
  assert.equal(stored.crossChainPayer.sourceChain, 'base');
  assert.equal(stored.crossChainPayer.viaAurora, true);
});
