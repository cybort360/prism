import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';
import { RequestService } from '../src/services/requestService.js';
import { meraAccount, PK_A, PK_B } from './helpers.js';

const AUSD = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC'; // Monad testnet AUSD
const USDC = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const config = {
  limits: { maxPaymentAtomic: 10_000_000_000n },
  chain: { ausd: AUSD, tokens: { AUSD: { symbol: 'AUSD', address: AUSD }, USDC: { symbol: 'USDC', address: USDC } } }
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
  const draft = service.draft({ requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', token: AUSD, memo: 'Lunch' });
  assert.equal(draft.request.status, 'DRAFT');
  const committed = await service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: await a.signMessage(draft.signable) });
  assert.equal(committed.status, 'OPEN');
});

test('a request forged by another account cannot be committed', async () => {
  const { a, b, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', token: AUSD, memo: 'Lunch' });
  await assert.rejects(
    () => service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: b.signMessage(draft.signable) }),
    /invalid request signature/
  );
});

test('request payment is bound to payer recipient amount and token', async () => {
  const { a, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', token: AUSD, memo: 'Lunch' });
  await service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: await a.signMessage(draft.signable) });
  assert.equal(service.assertPayable({ requestId: draft.request.requestId, payerPrismId: 'b', recipientPrismId: 'a', amountAtomic: '15000000', token: AUSD }).requestId, draft.request.requestId);
  assert.throws(() => service.assertPayable({ requestId: draft.request.requestId, payerPrismId: 'b', recipientPrismId: 'a', amountAtomic: '16000000', token: AUSD }), /amount/);
  assert.throws(() => service.assertPayable({ requestId: draft.request.requestId, payerPrismId: 'a', recipientPrismId: 'a', amountAtomic: '15000000', token: AUSD }), /payer/);
});

test('USDC request is stored with its canonical token and rejects AUSD settlement', async () => {
  const { a, service } = fixture();
  const draft = service.draft({ requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', token: 'USDC', memo: 'Dinner' });
  assert.equal(draft.request.token.toLowerCase(), USDC.toLowerCase());
  assert.equal(draft.request.tokenSymbol, 'USDC');
  await service.commit({ requesterPrismId: 'a', requestId: draft.request.requestId, signature: await a.signMessage(draft.signable) });
  assert.throws(() => service.assertPayable({ requestId: draft.request.requestId, payerPrismId: 'b', recipientPrismId: 'a', amountAtomic: '15000000', token: AUSD }), /token/);
});
