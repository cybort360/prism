import test from 'node:test';
import assert from 'node:assert/strict';
import { meraAccount, PK_A, PK_B } from './helpers.js';

// eth.js reads config (incl. PRISM_PAYMENT_ROUTER) at import time; set env before the dynamic import.
// Node's default test isolation runs each file in its own process, so this does not leak.
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.MONAD_CHAIN_ID = '10143';
const { paymentEnvelopeTypedData, transferAuthorizationTypedData, verifyTypedData, resolutionHash } =
  await import('../src/chain/eth.js');

function envFor(payer, recipient, amount, requestId) {
  return {
    paymentId: `0x${'11'.repeat(32)}`,
    payer,
    recipient,
    token: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
    amount,
    requestId,
    resolutionHash: `0x${'22'.repeat(32)}`,
    validBefore: Math.floor(Date.now() / 1000) + 300,
    nonce: `0x${'33'.repeat(32)}`
  };
}

test('payment envelope binds metadata and verifies against the payer', async () => {
  const payer = meraAccount(PK_A);
  const recipient = meraAccount(PK_B).address;
  const env = envFor(payer.address, recipient, 25_000000n, `0x${'ab'.repeat(32)}`);
  const sig = await payer.signTypedData(paymentEnvelopeTypedData(env));

  assert.equal(await verifyTypedData(paymentEnvelopeTypedData(env), payer.address, sig), true, 'honest envelope verifies');
  // Every bound field is covered by the signature.
  assert.equal(await verifyTypedData(paymentEnvelopeTypedData({ ...env, amount: env.amount + 1n }), payer.address, sig), false);
  assert.equal(await verifyTypedData(paymentEnvelopeTypedData({ ...env, recipient: meraAccount(PK_A).address }), payer.address, sig), false);
  assert.equal(await verifyTypedData(paymentEnvelopeTypedData({ ...env, requestId: `0x${'cd'.repeat(32)}` }), payer.address, sig), false);
  assert.equal(await verifyTypedData(paymentEnvelopeTypedData({ ...env, resolutionHash: `0x${'ee'.repeat(32)}` }), payer.address, sig), false);
});

test('envelope signed by another account is rejected', async () => {
  const payer = meraAccount(PK_A);
  const attacker = meraAccount(PK_B);
  const env = envFor(payer.address, attacker.address, 10_000000n, `0x${'00'.repeat(32)}`);
  const forged = await attacker.signTypedData(paymentEnvelopeTypedData(env));
  assert.equal(await verifyTypedData(paymentEnvelopeTypedData(env), payer.address, forged), false);
});

test('AUSD transfer authorization co-binds recipient and amount', async () => {
  const payer = meraAccount(PK_A);
  const to = meraAccount(PK_B).address;
  const params = { from: payer.address, to, value: 25_000000n, validAfter: 0, validBefore: Math.floor(Date.now() / 1000) + 300, nonce: `0x${'33'.repeat(32)}` };
  const sig = await payer.signTypedData(transferAuthorizationTypedData(params));
  assert.equal(await verifyTypedData(transferAuthorizationTypedData(params), payer.address, sig), true);
  assert.equal(await verifyTypedData(transferAuthorizationTypedData({ ...params, value: params.value + 1n }), payer.address, sig), false);
});

test('resolutionHash is derived only from opaque resolver data', () => {
  // Same opaque inputs -> same hash; different identity -> different hash. Never involves a phone.
  const a = resolutionHash({ prismIdentity: 'id-1', recipientAccount: meraAccount(PK_B).address, aliasVersion: 2, resolutionRequestId: 'res_x' });
  const b = resolutionHash({ prismIdentity: 'id-1', recipientAccount: meraAccount(PK_B).address, aliasVersion: 2, resolutionRequestId: 'res_x' });
  const c = resolutionHash({ prismIdentity: 'id-2', recipientAccount: meraAccount(PK_B).address, aliasVersion: 2, resolutionRequestId: 'res_x' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});
