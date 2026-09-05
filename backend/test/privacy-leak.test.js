import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';
import { KeyService } from '../src/services/keyService.js';
import { OtpService } from '../src/services/otpService.js';
import { ClaimService } from '../src/services/claimService.js';
import { ResolverService } from '../src/services/resolverService.js';
import { IdentityService } from '../src/services/identityService.js';
import { logger } from '../src/lib/logger.js';
import { meraAccount, PK_A } from './helpers.js';

/**
 * Automated privacy leak checks (FORGE PRIVACY AUDIT).
 *
 * Prism's core claim is that a phone number is a *private* reachability alias: it is never a key,
 * never an on-chain identifier, and never at rest in plaintext. These tests drive the real services
 * and then grep every persisted byte and every emitted log line for the secrets that must never
 * appear. They are deliberately written as scanners, not as assertions about specific call sites,
 * so a future leak anywhere on these paths fails the build.
 */

const PHONE = '+2348031234567';
const OTHER_PHONE = '+447700900123';
const OTP_CODE = '123456';
const PIN = '482913';

// E.164, the OTP, the PIN, and anything shaped like a 32-byte private key.
const E164 = /\+[1-9]\d{7,14}/g;
const PRIVATE_KEY_SHAPED = /\b(?:0x)?[0-9a-f]{64}\b/gi;

function newContext() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-privacy-')), 'store.json');
  const config = {
    resolverPepper: 'pepper-for-privacy-tests',
    dataEncryptionKeyHex: '11'.repeat(32),
    serviceKeyEncryptionKeyHex: '22'.repeat(32),
    devOtpCode: OTP_CODE,
    twilio: { accountSid: '' },
    limits: { maxClaimAtomic: 1_000_000_000n }
  };
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  return { file, store, config, keyService, identityService };
}

/** Capture everything the structured logger emits while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = origLog; console.error = origErr; }
  return lines.join('\n');
}

test('LEAK-01 no raw phone number is ever persisted to the datastore', async () => {
  const { file, store, config, keyService, identityService } = newContext();
  const owner = meraAccount(PK_A);
  const otp = new OtpService({ config, store });
  const resolver = new ResolverService({ store, config, keyService, identityService });
  const claims = new ClaimService({ store, config, identityService });

  // Exercise every path that receives a raw phone number.
  await otp.start(PHONE, '203.0.113.7');
  await otp.check(PHONE, OTP_CODE, '203.0.113.7');
  await otp.start(OTHER_PHONE, '203.0.113.8');           // a number that never becomes a user
  const identity = await identityService.upsertVerifiedPhone({
    phone: PHONE, account: owner.address, bindingProof: await owner.bindingProof()
  });
  resolver.resolvePhone(identity.prismId, PHONE);
  resolver.resolvePhone(identity.prismId, OTHER_PHONE);  // a miss still touches rate-limit state
  claims.createPending({
    senderPrismId: identity.prismId, recipientPhoneLookupKey: 'opaque', amountAtomic: '20000000',
    token: '0x534b2f3A21130d7a60830c2Df862319e593943A3'
  });

  const persisted = fs.readFileSync(file, 'utf8');
  const found = [...new Set(persisted.match(E164) ?? [])];
  assert.deepEqual(found, [], `raw E.164 numbers found at rest in the datastore: ${found.join(', ')}`);
  // The lookup index must be keyed by the peppered HMAC, and hold no phone-derived plaintext.
  const data = JSON.parse(persisted);
  for (const key of Object.keys(data.phoneIndex)) assert.match(key, /^0x[0-9a-f]{64}$/);
  for (const key of Object.keys(data.rateLimits)) {
    assert.equal(E164.test(key), false, `rate-limit key contains a raw phone: ${key}`);
    E164.lastIndex = 0;
  }
});

test('LEAK-02 the stored phone is encrypted, and is not a bare hash of the number', async () => {
  const { file, store, config, identityService } = newContext();
  const owner = meraAccount(PK_A);
  const identity = await identityService.upsertVerifiedPhone({
    phone: PHONE, account: owner.address, bindingProof: await owner.bindingProof()
  });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).identities[identity.prismId];

  // AES-GCM envelope, not plaintext and not a digest.
  assert.ok(stored.phoneEncrypted?.iv && stored.phoneEncrypted?.ciphertext && stored.phoneEncrypted?.tag);
  assert.equal(JSON.stringify(stored).includes(PHONE), false);

  // MUT-02: the lookup key must NOT be an unkeyed digest of the phone — that is enumerable by
  // anyone who can guess a number. It must be a keyed HMAC under the server-held pepper.
  const crypto = await import('node:crypto');
  const bareSha = `0x${crypto.createHash('sha256').update(PHONE).digest('hex')}`;
  const bareKeccakish = `0x${crypto.createHash('sha512-256').update(PHONE).digest('hex')}`;
  assert.notEqual(stored.phoneLookupKey, bareSha, 'phone lookup key is SHA256(phone) — enumerable');
  assert.notEqual(stored.phoneLookupKey, bareKeccakish);
  // Changing only the pepper must change the key (proves it is keyed, not a plain digest).
  const { phoneLookupKey } = await import('../src/lib/crypto.js');
  assert.notEqual(phoneLookupKey(PHONE, 'pepper-a'), phoneLookupKey(PHONE, 'pepper-b'));
});

test('LEAK-03 logs carry no phone, OTP, PIN, or key material', async () => {
  const { store, config, keyService, identityService } = newContext();
  const owner = meraAccount(PK_A);
  const otp = new OtpService({ config, store });
  const resolver = new ResolverService({ store, config, keyService, identityService });

  const output = await captureLogs(async () => {
    await otp.start(PHONE, '203.0.113.7');
    await otp.check(PHONE, OTP_CODE, '203.0.113.7');
    const identity = await identityService.upsertVerifiedPhone({
      phone: PHONE, account: owner.address, bindingProof: await owner.bindingProof()
    });
    const resolution = resolver.resolvePhone(identity.prismId, PHONE);
    // Log the way production does: opaque identifiers only.
    logger.info('payment.prepared', { paymentId: '0xabc', recipientPrismId: identity.prismId });
    logger.error('http', { path: '/v1/resolve/phone', status: 200 });
    assert.equal(resolution.found, true);
  });

  assert.equal(output.includes(PHONE), false, 'raw phone appeared in log output');
  assert.equal(output.includes(OTP_CODE), false, 'OTP code appeared in log output');
  assert.equal(output.includes(PIN), false, 'PIN appeared in log output');
  assert.equal(output.includes(PK_A.slice(2)), false, 'private key material appeared in log output');
});

test('LEAK-04 the resolver attestation exposes no phone-derived value to the requester', async () => {
  const { store, config, keyService, identityService } = newContext();
  const owner = meraAccount(PK_A);
  const resolver = new ResolverService({ store, config, keyService, identityService });
  const identity = await identityService.upsertVerifiedPhone({
    phone: PHONE, account: owner.address, bindingProof: await owner.bindingProof()
  });

  const resolution = resolver.resolvePhone(identity.prismId, PHONE);
  const wire = JSON.stringify(resolution);
  assert.equal(wire.includes(PHONE), false);
  // The requester must not receive the lookup key either — that is an offline-enumeration oracle.
  assert.equal(wire.includes(identity.phoneLookupKey), false, 'resolver leaked the phone lookup key');
});

test('LEAK-05 the private half of every service key stays out of the public view', async () => {
  const { store, config, keyService, identityService } = newContext();
  const resolver = new ResolverService({ store, config, keyService, identityService });
  const pub = JSON.stringify(resolver.publicKey());
  assert.equal(pub.includes('PRIVATE KEY'), false);
  assert.equal(pub.includes('BEGIN'), false);

  const persisted = fs.readFileSync(config.storePath ?? store.filePath, 'utf8');
  // Service keys are encrypted at rest; a PEM private key must never be readable in the store.
  assert.equal(persisted.includes('BEGIN PRIVATE KEY'), false, 'unencrypted private key at rest');
  assert.equal(persisted.includes('BEGIN EC PRIVATE KEY'), false);
});

test('LEAK-06 the identity public view masks the phone rather than returning it', async () => {
  const { store, config, identityService } = newContext();
  const owner = meraAccount(PK_A);
  const identity = await identityService.upsertVerifiedPhone({
    phone: PHONE, account: owner.address, bindingProof: await owner.bindingProof()
  });
  const view = identityService.publicView(identity);
  assert.equal(JSON.stringify(view).includes(PHONE), false, 'public view returned the full phone');
  assert.ok(view.phoneMasked.includes('•'), 'phone should be masked, not omitted silently');
  assert.equal(view.hasVerifiedPhone, true);
  // The masked form must not reveal the full national number.
  const revealed = view.phoneMasked.replace(/\D/g, '');
  assert.ok(revealed.length < PHONE.replace(/\D/g, '').length, 'mask reveals every digit');
});
