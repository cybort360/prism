import test from 'node:test';
import assert from 'node:assert/strict';
import { generateP256KeyPair, p256SignData, p256VerifyData, encryptString, decryptString, issueSession, verifySession } from '../src/lib/crypto.js';

test('P256 raw signatures round-trip', () => {
  const pair=generateP256KeyPair(); const data=Buffer.from('prism');
  const sig=p256SignData(pair.privateKeyPem,data);
  assert.equal(sig.length,64); assert.equal(p256VerifyData(pair.publicKeyPem,data,sig),true);
});

test('encrypted PII round-trip', () => {
  const key='22'.repeat(32); const blob=encryptString('+2348031234567',key);
  assert.equal(decryptString(blob,key),'+2348031234567');
  assert.equal(JSON.stringify(blob).includes('+2348031234567'),false);
});

test('session MAC detects tampering', () => {
  const token=issueSession({prismId:'p1'},'secret',60);
  assert.equal(verifySession(token,'secret').prismId,'p1');
  assert.throws(()=>verifySession(`${token}x`,'secret'));
});
