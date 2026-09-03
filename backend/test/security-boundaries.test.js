import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';
import { KeyService } from '../src/services/keyService.js';
import { ClaimService } from '../src/services/claimService.js';
import { ResolverService } from '../src/services/resolverService.js';
import { IdentityService } from '../src/services/identityService.js';
import { transferAuthorizationTypedData, verifyTypedData } from '../src/chain/eth.js';
import { meraAccount, PK_A } from './helpers.js';

const RECIPIENT = '0x00000000000000000000000000000000000000b0';

test('an AUSD authorization fails closed when recipient or amount is mutated', async () => {
  const payer = meraAccount(PK_A);
  const value = 25_000000n;
  const params = { from: payer.address, to: RECIPIENT, value, validAfter: 0, validBefore: Math.floor(Date.now() / 1000) + 300, nonce: `0x${'11'.repeat(32)}` };
  const signature = await payer.signTypedData(transferAuthorizationTypedData(params));

  assert.equal(await verifyTypedData(transferAuthorizationTypedData(params), payer.address, signature), true, 'honest authorization verifies');
  // recipient (`to`) and amount (`value`) are in the signed ERC-3009 digest; mutating either breaks recovery.
  assert.equal(await verifyTypedData(transferAuthorizationTypedData({ ...params, value: value + 1n }), payer.address, signature), false);
  assert.equal(await verifyTypedData(transferAuthorizationTypedData({ ...params, to: '0x00000000000000000000000000000000000000ff' }), payer.address, signature), false);
});

test('pre-user claims use random non-phone-derived public references', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-')), 'store.json');
  const store = new JsonStore(file);
  const config = { limits: { maxClaimAtomic: 1_000_000_000n } };
  const service = new ClaimService({ store, config, identityService: { get: () => null } });
  const phone = '+2348031234567';
  const token = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC';
  const c1 = service.createPending({ senderPrismId: 'sender', recipientPhoneLookupKey: 'opaque-hmac', amountAtomic: '20000000', token });
  const c2 = service.createPending({ senderPrismId: 'sender', recipientPhoneLookupKey: 'opaque-hmac', amountAtomic: '20000000', token });
  assert.match(c1.claimId, /^0x[0-9a-f]{64}$/); assert.match(c1.recipientReference, /^0x[0-9a-f]{64}$/);
  assert.notEqual(c1.claimId, c2.claimId); assert.notEqual(c1.recipientReference, c2.recipientReference);
  assert.equal(JSON.stringify({ claimId: c1.claimId, recipientReference: c1.recipientReference }).includes(phone), false);
});

test('phone rotation invalidates the previous resolution version', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-')), 'store.json');
  const store = new JsonStore(file);
  const config = { resolverPepper: 'pepper', dataEncryptionKeyHex: '11'.repeat(32), serviceKeyEncryptionKeyHex: '22'.repeat(32) };
  const identityService = new IdentityService({ store, config });
  const owner = meraAccount(PK_A);
  const identity = await identityService.upsertVerifiedPhone({ phone: '+2348031234567', account: owner.address, bindingProof: await owner.bindingProof() });
  const resolver = new ResolverService({ store, config, keyService: new KeyService(store, config), identityService });
  const before = resolver.resolvePhone('requester', '+2348031234567');
  assert.equal(before.found, true);
  identityService.bindVerifiedPhone(identity.prismId, '+2348037654321');
  const old = resolver.resolvePhone('requester', '+2348031234567');
  const fresh = resolver.resolvePhone('requester', '+2348037654321');
  assert.equal(old.found, false); assert.equal(fresh.found, true);
  assert.ok(fresh.attestation.aliasVersion > before.attestation.aliasVersion);
});
