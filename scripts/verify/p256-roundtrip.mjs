// R2 (strengthened): a FULL P-256 (secp256r1) sign -> verify round-trip against Monad's on-chain
// RIP-7212 / EIP-7951 precompile at 0x0100. Generates a fresh keypair here, signs a fresh message,
// verifies it live, and runs a NEGATIVE control (tampered digest must fail) so the precompile is shown
// to actually verify — not just echo 1. Read-only (eth_call); broadcasts nothing.
//
// Usage:  node scripts/verify/p256-roundtrip.mjs   [MONAD_RPC_URL]
import crypto from 'node:crypto';

const RPC = process.argv[2] || process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz/';
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n; // secp256r1 order
const PRECOMPILE = '0x0000000000000000000000000000000000000100';
const hex32 = (b) => Buffer.from(b).toString('hex').padStart(64, '0');
const b64uHex = (s) => Buffer.from(s, 'base64url').toString('hex').padStart(64, '0');

async function ethCall(data) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: PRECOMPILE, data }, 'latest'] })
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result; // 0x...01 when valid, 0x / 0x..00 when invalid
}
const isOne = (r) => { try { return BigInt(r || '0x0') === 1n; } catch { return false; } };

// Fresh device-style P-256 credential + a fresh signed message.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const message = crypto.randomBytes(48);
const digest = crypto.createHash('sha256').update(message).digest();          // the 32-byte hash the precompile checks
const raw = crypto.sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' }); // 64-byte r||s
const r = raw.subarray(0, 32);
let s = BigInt('0x' + raw.subarray(32, 64).toString('hex'));
if (s > P256_N / 2n) s = P256_N - s;                                           // normalize to low-s (always valid)
const jwk = publicKey.export({ format: 'jwk' });
const qx = b64uHex(jwk.x), qy = b64uHex(jwk.y);

const input = '0x' + hex32(digest) + hex32(r) + s.toString(16).padStart(64, '0') + qx + qy;

console.log('rpc        :', RPC);
console.log('curve      : secp256r1 (P-256, the WebAuthn/passkey curve)');
console.log('pubkey qx  : 0x' + qx);
console.log('pubkey qy  : 0x' + qy);
console.log('digest     : 0x' + hex32(digest));

const valid = await ethCall(input);
const validOk = isOne(valid);
console.log('\nvalid signature  → precompile:', valid, validOk ? 'PASS (verified on Monad)' : 'FAIL');

// Negative control: flip one bit of the digest — the SAME (r,s,q) must now FAIL to verify.
const bad = Buffer.from(digest); bad[0] ^= 0x01;
const badInput = '0x' + hex32(bad) + hex32(r) + s.toString(16).padStart(64, '0') + qx + qy;
const invalid = await ethCall(badInput);
const negOk = !isOne(invalid);
console.log('tampered digest  → precompile:', invalid || '0x', negOk ? 'PASS (rejected)' : 'FAIL (accepted a bad sig!)');

const ok = validOk && negOk;
console.log('\nRESULT:', ok ? 'PASS — Monad verifies a fresh P-256 signature on-chain, and rejects a tampered one' : 'FAIL');
process.exit(ok ? 0 : 1);
