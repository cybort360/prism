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
// The two signing keys are DERIVED FROM FIXED SEEDS rather than checked in as PEM blobs. They are
// test fixtures — they exist so every vector in docs/, proof/ and the Swift suite reproduces exactly
// — and they guard nothing: P-256 is not secp256k1, so they can never be an Ethereum account, and no
// deployed contract is bound to them. Deriving them keeps that reproducibility while keeping
// key-shaped material out of the repository, where a secret scanner is right to object to it and
// where somebody could copy one into a context that does matter.
//
// Adding a seed adds a key. Changing a seed changes the Safe addresses the vectors are built from,
// so `proof/circles/safe-tx-vectors.json` and the generated Swift fixture must be regenerated:
//   WRITE_CIRCLE_VECTORS=1 FOUNDRY_PROFILE=circles forge test \
//     --match-path 'test/circles/CircleSafeTxVectors.t.sol' --network monad
//   cd tools/circles && npm run fixture && npm run verify
import { createPrivateKey, createPublicKey, createHash, sign as nodeSign } from 'node:crypto';

const SEEDS = ['prism-circles-p256-fixture-0', 'prism-circles-p256-fixture-1'];

// secp256r1 group order
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const hex = (b) => Buffer.from(b).toString('hex');
const pad = (v) => v.toString(16).padStart(64, '0');

/**
 * PKCS#8 carrying only the private scalar; OpenSSL derives the public point on import, so the
 * fixture needs no stored public key. The scalar is the seed's SHA-256 reduced into [1, n-1], which
 * is what makes any seed a valid key rather than one that happens to be in range.
 */
function pkcs8(scalar) {
  const d = Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex');
  const ecPrivateKey = Buffer.concat([Buffer.from([0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20]), d]);
  return Buffer.concat([
    Buffer.from([
      0x30, 0x41, 0x02, 0x01, 0x00,
      0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
      0x04, 0x27
    ]),
    ecPrivateKey
  ]);
}

function keyAt(i) {
  const seed = SEEDS[Number(i)];
  if (!seed) throw new Error(`no fixed P-256 key at index ${i} (have ${SEEDS.length})`);
  const scalar = (BigInt('0x' + createHash('sha256').update(seed).digest('hex')) % (N - 1n)) + 1n;
  return createPrivateKey({ key: pkcs8(scalar), format: 'der', type: 'pkcs8' });
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
