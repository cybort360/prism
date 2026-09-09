import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { decodeAbiParameters } from 'viem';

// Deterministic orchestration test for the device-P256 → PrismP256Account adoption path. Uses a MOCK
// chainOps (no live chain) and a REAL software P-256 key to sign the prepared intent, proving: the
// backend builds the correct intent, the device signature is well-formed over it, and submit relays
// exactly that intent + signature. The intent's byte-parity with the on-chain contract is proven
// separately by the live e2e (scripts/verify / PROOF_LEDGER CHAIN-8).

process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { P256AccountService } = await import('../src/services/p256AccountService.js');
const { ActivityService } = await import('../src/services/activityService.js');
const { IdentityService } = await import('../src/services/identityService.js');

const ACCOUNT = '0xacac00000000000000000000000000000000acac';
const RECIPIENT = '0x1234567890abcdef1234567890abcdef12345678';

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-p256-')), 'store.json');
  const store = new JsonStore(file);
  const calls = { deploy: 0, pays: [], receipt: { status: 'success' } };
  const chainOps = {
    async deployAccount({ qx, qy }) { calls.deploy++; calls.lastKey = { qx, qy }; return ACCOUNT; },
    async relayPay(args) { calls.pays.push(args); return `0x${'cd'.repeat(32)}`; },
    async getReceipt() { return calls.receipt; }
  };
  return { store, calls, svc: new P256AccountService({ store, config, chainOps }) };
}

function deviceKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const qx = '0x' + Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0');
  const qy = '0x' + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
  return { privateKey, publicKey, qx, qy };
}

test('p256 account: deploy is idempotent per user', async () => {
  const { svc, calls } = stack();
  const k = deviceKey();
  const a = await svc.ensureAccount({ prismId: 'alice', qx: k.qx, qy: k.qy });
  assert.equal(a.account, ACCOUNT); assert.equal(a.deployed, true);
  const b = await svc.ensureAccount({ prismId: 'alice', qx: k.qx, qy: k.qy });
  assert.equal(b.deployed, false); // no second deploy
  assert.equal(calls.deploy, 1);
});

test('p256 account: prepare builds the exact intent; a real device P-256 signature over it verifies; submit relays it', async () => {
  const { svc, calls } = stack();
  const k = deviceKey();
  await svc.ensureAccount({ prismId: 'alice', qx: k.qx, qy: k.qy });

  const prep = svc.prepare({ prismId: 'alice', recipient: RECIPIENT, amountAtomic: '1000000' });
  assert.equal(prep.account, ACCOUNT);

  // The intent decodes to exactly (chainId, account, token, recipient, amount, nonce, validBefore).
  const decoded = decodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }],
    prep.intentHex
  );
  assert.equal(decoded[0], BigInt(config.chain.chainId));
  assert.equal(decoded[1].toLowerCase(), ACCOUNT.toLowerCase());
  assert.equal(decoded[2].toLowerCase(), config.chain.usdc.toLowerCase());
  assert.equal(decoded[3].toLowerCase(), RECIPIENT.toLowerCase());
  assert.equal(decoded[4], 1000000n);
  assert.equal(decoded[5], prep.nonce);
  assert.equal(decoded[6], BigInt(prep.validBefore));

  // Device signs the intent bytes (Secure Enclave / CryptoKit applies SHA-256, matching the account).
  const intentBytes = Buffer.from(prep.intentHex.slice(2), 'hex');
  const raw = crypto.sign('sha256', intentBytes, { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
  assert.ok(crypto.verify('sha256', intentBytes, { key: k.publicKey, dsaEncoding: 'ieee-p1363' }, raw),
    'the device signature verifies against its own P-256 public key');
  const r = '0x' + raw.subarray(0, 32).toString('hex');
  const s = '0x' + raw.subarray(32, 64).toString('hex');

  const res = await svc.submit({ prismId: 'alice', opId: prep.opId, r, s });
  assert.equal(res.state, 'submitted');
  assert.ok(res.txHash);
  // The relayed call carries exactly the prepared intent + the device signature.
  const relayed = calls.pays[0];
  assert.equal(relayed.account, ACCOUNT);
  assert.equal(relayed.recipient, RECIPIENT);
  assert.equal(relayed.amount, '1000000');
  assert.equal(relayed.nonce, prep.nonce);
  assert.equal(relayed.r, r);
  assert.equal(relayed.s, s);
});

test('p256 account: status only reports completed from a confirmed receipt', async () => {
  const { svc, calls } = stack();
  const k = deviceKey();
  await svc.ensureAccount({ prismId: 'alice', qx: k.qx, qy: k.qy });
  const prep = svc.prepare({ prismId: 'alice', recipient: RECIPIENT, amountAtomic: '1000000' });
  await svc.submit({ prismId: 'alice', opId: prep.opId, r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}` });

  calls.receipt = null; // not mined yet
  assert.equal((await svc.status({ prismId: 'alice', opId: prep.opId })).state, 'confirming');
  calls.receipt = { status: 'success' };
  assert.equal((await svc.status({ prismId: 'alice', opId: prep.opId })).state, 'completed');
});

test('p256 account: a device-key payment appears in the activity feed', async () => {
  const { store, svc } = stack();
  const k = deviceKey();
  await svc.ensureAccount({ prismId: 'alice', qx: k.qx, qy: k.qy });
  const prep = svc.prepare({ prismId: 'alice', recipient: RECIPIENT, amountAtomic: '1000000' });
  await svc.submit({ prismId: 'alice', opId: prep.opId, r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}` });

  const activity = new ActivityService({ store, identityService: new IdentityService({ store, config }) });
  const row = activity.list('alice').find(x => x.kind === 'p256-sent');
  assert.ok(row, 'the device-key payment shows in the activity feed');
  assert.equal(row.direction, 'outgoing');
  assert.equal(row.amountAtomic, '1000000');
  assert.ok(row.transactionHash);
  assert.ok(String(row.counterpartyHandle).includes('…'), 'shows the shortened recipient address');
  assert.equal(activity.list('bob').filter(x => x.kind === 'p256-sent').length, 0, 'not visible to another user');
});

test('p256 account: reconcile flips a stuck-submitted op to completed from its receipt', async () => {
  const { store, calls, svc } = stack();
  const k = deviceKey();
  await svc.ensureAccount({ prismId: 'alice', qx: k.qx, qy: k.qy });
  const prep = svc.prepare({ prismId: 'alice', recipient: RECIPIENT, amountAtomic: '1000000' });
  await svc.submit({ prismId: 'alice', opId: prep.opId, r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}` });
  assert.equal(store.read().p256Ops[prep.opId].state, 'submitted'); // status poll never ran (old bug)

  calls.receipt = { status: 'success' };
  await svc.reconcile('alice');
  assert.equal(store.read().p256Ops[prep.opId].state, 'completed', 'reconcile flips it to completed from the receipt');
});

test('p256 account: prepare without an account and unknown ops fail closed', async () => {
  const { svc } = stack();
  assert.throws(() => svc.prepare({ prismId: 'nobody', recipient: RECIPIENT, amountAtomic: '1' }), /no P256 account/);
  await assert.rejects(() => svc.submit({ prismId: 'nobody', opId: 'p256#deadbeef', r: '0x0', s: '0x0' }), /operation not found/);
});
