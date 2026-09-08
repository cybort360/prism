import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import crypto from 'node:crypto';
import { meraAccount, PK_A } from './helpers.js';

/**
 * Aurora is a third party. Prism's core privacy rule — the phone number is a private reachability
 * alias, and no phone-derived value is ever emitted — has to hold across that boundary too. These
 * tests scan every byte Prism sends to Aurora for the phone number and for every hash of it an
 * attacker could precompute, in the same spirit as contracts/test/PrismPrivacy.t.sol.
 */

process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
process.env.AURORA_APP_KEY = 'super-secret-looking-app-key-9f2b';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { IdentityService } = await import('../src/services/identityService.js');
const { AuroraService } = await import('../src/services/auroraService.js');
const { setAuroraClient, resetAuroraClient } = await import('../src/aurora/index.js');
const { makeMockAuroraClient } = await import('../src/aurora/mockAuroraClient.js');
const { phoneLookupKey } = await import('../src/lib/crypto.js');

const PHONE = '+2348100000000';

/** Every representation of the phone an attacker could precompute and then search for. */
function phoneDerivedNeedles() {
  const digits = PHONE.replace(/\D/g, '');
  const forms = [PHONE, digits, PHONE.slice(1), `0${digits.slice(3)}`];
  const needles = new Set(forms);
  for (const form of forms) {
    for (const algo of ['sha256', 'sha1', 'md5']) {
      needles.add(crypto.createHash(algo).update(form).digest('hex'));
    }
    needles.add(Buffer.from(form).toString('base64'));
  }
  needles.add(phoneLookupKey(PHONE, config.resolverPepper));
  return [...needles];
}

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-aurora-priv-')), 'store.json');
  const store = new JsonStore(file);
  const identityService = new IdentityService({ store, config });
  const auroraService = new AuroraService({ store, config, identityService });
  const alice = meraAccount(PK_A);
  store.mutate((d) => {
    // A fully-populated identity: verified phone, handle, display name. If any of it can leak, it
    // leaks from here.
    d.identities.alice = {
      prismId: 'alice',
      account: alice.address,
      accountAddress: alice.address,
      aliasVersion: 1,
      handle: 'alice',
      displayName: 'Alice Example',
      phoneLookupKey: phoneLookupKey(PHONE, config.resolverPepper),
      phoneVerified: true
    };
  });
  return { store, auroraService, alice };
}

test('no phone number or phone-derived value reaches Aurora', async () => {
  const mock = makeMockAuroraClient();
  setAuroraClient(mock);
  try {
    const { auroraService } = stack();
    for (const chain of ['base', 'arb', 'sol', 'btc']) {
      await auroraService.createDepositAddress({ prismId: 'alice', depositChain: chain });
    }

    const sent = JSON.stringify(mock.addressRequests).toLowerCase();
    assert.ok(sent.length > 0, 'the scanner has something to scan');
    for (const needle of phoneDerivedNeedles()) {
      assert.equal(sent.includes(needle.toLowerCase()), false, `phone-derived value leaked to Aurora: ${needle.slice(0, 24)}…`);
    }
  } finally { resetAuroraClient(); }
});

test('the scanner can actually fail — a planted phone value is detected', () => {
  // Guards the guard: without this, a scanner that silently matches nothing would pass forever.
  const planted = JSON.stringify([{ sender: PHONE }]).toLowerCase();
  const hits = phoneDerivedNeedles().filter((n) => planted.includes(n.toLowerCase()));
  assert.ok(hits.length > 0, 'the scanner must detect a phone number when one is present');
});

test('Aurora is told the EVM account address and nothing else identifying', async () => {
  const mock = makeMockAuroraClient();
  setAuroraClient(mock);
  try {
    const { auroraService, alice } = stack();
    await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });

    const [request] = mock.addressRequests;
    assert.equal(request.recipient, alice.address);
    assert.equal(request.sender, alice.address, 'attribution uses the account address, not a Prism identifier');

    // The request carries exactly the fields the API needs — no handle, no display name, no prismId.
    assert.deepEqual(Object.keys(request).sort(), ['depositChain', 'destinationAsset', 'destinationChain', 'recipient', 'sender']);
    const serialized = JSON.stringify(request).toLowerCase();
    for (const identifying of ['alice example', 'prismid', '"alice"']) {
      assert.equal(serialized.includes(identifying), false, `${identifying} leaked to Aurora`);
    }
  } finally { resetAuroraClient(); }
});

test('the Aurora app key never appears in anything returned to a client', async () => {
  const mock = makeMockAuroraClient();
  setAuroraClient(mock);
  try {
    const { auroraService } = stack();
    const responses = [
      await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' }),
      auroraService.listDeposits('alice'),
      await auroraService.chains()
    ];
    for (const response of responses) {
      assert.equal(JSON.stringify(response).includes(config.aurora.appKey), false, 'the app key must stay server-side');
    }
  } finally { resetAuroraClient(); }
});

test('a stored deposit record holds no phone-derived value either', async () => {
  const mock = makeMockAuroraClient();
  setAuroraClient(mock);
  try {
    const { auroraService, store } = stack();
    await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
    const stored = JSON.stringify(store.read().auroraDeposits).toLowerCase();
    for (const needle of phoneDerivedNeedles()) {
      assert.equal(stored.includes(needle.toLowerCase()), false, `phone-derived value stored on the deposit record: ${needle.slice(0, 24)}…`);
    }
  } finally { resetAuroraClient(); }
});
