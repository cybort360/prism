#!/usr/bin/env node
// P-256 signing oracle for the Prism Circles Safe-owner compatibility experiment.
//
// It reproduces the convention Prism iOS uses for Secure Enclave / CryptoKit signing:
// CryptoKit's `signature(for: Data)` applies SHA-256 to the message bytes before P-256 ECDSA,
// so signing the 32-byte Safe transaction hash means ECDSA_P256(SHA256(safeTxHash)).
// That is exactly what an on-chain verifier must check against Monad's EIP-7951 precompile.
//
// Usage:
//   p256-sign.mjs pubkey <keyIndex>            -> 0x<qx:32><qy:32>
//   p256-sign.mjs sign   <keyIndex> <hash32>   -> 0x<r:32><s:32>   (low-s normalised)
//   p256-sign.mjs sign-highs <keyIndex> <hash32> -> 0x<r:32><s:32> (deliberately high-s)
//   p256-sign.mjs sign-pair <keyIndex> <hash32>  -> 0x<r:32><sLow:32><sHigh:32> from ONE signature,
//                                                   so malleability can be tested on a fixed r.
//
// Keys are fixed so every test vector in docs/ and the Swift suite is reproducible.
import { createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';

const KEYS = [
`-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZiNIP2ReDXRJdklx
qE2HRWR9nQNe8gIYBfhmBdFYK8ahRANCAASHNZJyS2Ppqd4mgno9FLJOsgjX7WiW
N6sYDvl00tgl7cxMn8teZfS/T+scVMvZEsUnv+AGNiYhwnJF0/aqJ2X9
-----END PRIVATE KEY-----`,
`-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYxhoufiqa++CKu9h
fIt1b8KkPFZrxZbelknWn+/B8wihRANCAASRnQeH2ZcnZiMpVhKXsl+MjVywxQDH
bR9V2e8vS7mt8/m4R5N7CbUzVcL6HT48ibLesLlls/bfo8RH2569IVgx
-----END PRIVATE KEY-----`,
];

// secp256r1 group order
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const hex = (b) => Buffer.from(b).toString('hex');
const pad = (v) => v.toString(16).padStart(64, '0');

function keyAt(i) {
  const pem = KEYS[Number(i)];
  if (!pem) throw new Error(`no fixed P-256 key at index ${i} (have ${KEYS.length})`);
  return createPrivateKey(pem);
}

function pubkey(i) {
  // SPKI for P-256 ends with the 65-byte uncompressed point 0x04 || X || Y.
  const spki = createPublicKey(keyAt(i)).export({ type: 'spki', format: 'der' });
  const point = spki.subarray(spki.length - 65);
  if (point[0] !== 0x04) throw new Error('unexpected EC point encoding');
  return { qx: hex(point.subarray(1, 33)), qy: hex(point.subarray(33, 65)) };
}

function signHash(i, hash32, { lowS = true } = {}) {
  const msg = Buffer.from(hash32.replace(/^0x/, ''), 'hex');
  if (msg.length !== 32) throw new Error('hash must be exactly 32 bytes');
  // dsaEncoding 'ieee-p1363' yields raw r||s. 'sha256' reproduces CryptoKit's digest step.
  const raw = nodeSign('sha256', msg, { key: keyAt(i), dsaEncoding: 'ieee-p1363' });
  let r = BigInt('0x' + hex(raw.subarray(0, 32)));
  let s = BigInt('0x' + hex(raw.subarray(32, 64)));
  const isHigh = s > N / 2n;
  if (lowS && isHigh) s = N - s;
  if (!lowS && !isHigh) s = N - s; // force the malleable sibling
  return { r, s };
}

const [cmd, idx, arg] = process.argv.slice(2);
try {
  if (cmd === 'pubkey') {
    const { qx, qy } = pubkey(idx);
    process.stdout.write('0x' + qx + qy);
  } else if (cmd === 'sign' || cmd === 'sign-highs') {
    const { r, s } = signHash(idx, arg, { lowS: cmd === 'sign' });
    process.stdout.write('0x' + pad(r) + pad(s));
  } else if (cmd === 'sign-pair') {
    const { r, s } = signHash(idx, arg, { lowS: true });
    process.stdout.write('0x' + pad(r) + pad(s) + pad(N - s));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} catch (e) {
  process.stderr.write(String(e.message) + '\n');
  process.exit(1);
}
