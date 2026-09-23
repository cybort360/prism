import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';

// Fully-wired backend (config reads env at load).
process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;

function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-sweep-')), 'store.json')); }

test('prepareExternalSend honors an explicit validBefore', async () => {
  const { PaymentService } = await import('../src/services/paymentService.js');
  const store = tmpStore();
  const identityService = { get: () => ({ prismId: 'p1', accountAddress: '0x00000000000000000000000000000000000000A1', account: '0x00000000000000000000000000000000000000A1', aliasVersion: 1 }) };
  const config = (await import('../src/config.js')).config;
  const svc = new PaymentService({ store, config, identityService });
  const far = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const prepared = await svc.prepareExternalSend({
    senderPrismId: 'p1', recipientAddress: '0x000000000000000000000000000000000000dEaD',
    amountAtomic: '1000000', boundHash: '0x' + '00'.repeat(32), kind: 'sweep-test', validBefore: far
  });
  // The prepared authorization must carry the far deadline, not now+AUTH_WINDOW.
  assert.equal(Math.floor(Date.parse(prepared.expiresAt) / 1000), far);
});
