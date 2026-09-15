#!/usr/bin/env node
// Holds three independent implementations of the Safe transaction hash to each other:
//
//   1. proof/circles/safe-tx-vectors.json — written from a REAL Safe v1.4.1 on Monad testnet
//      answering getTransactionHash(); the authority.
//   2. @safe-global/protocol-kit — the official JS implementation, re-derived here.
//   3. the Swift calculator on the iPhone — checked by ios/PrismTests/CircleSafeTxHashTests.swift
//      against the same file.
//
// It also re-derives the EIP-1271 contract-signature envelope with protocol-kit's own
// buildSignatureBytes, rather than trusting the hand-rolled encoding in the Solidity test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  calculateSafeTransactionHash,
  preimageSafeTransactionHash,
  buildSignatureBytes,
  EthSafeSignature,
} from '@safe-global/protocol-kit';

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = resolve(here, '../../proof/circles/safe-tx-vectors.json');
const SAFE_VERSION = '1.4.1';

const file = JSON.parse(readFileSync(VECTORS, 'utf8'));
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

let checks = 0;
let failures = 0;
function expect(label, actual, expected) {
  checks++;
  if (eq(actual, expected)) return;
  failures++;
  console.error(`  FAIL ${label}\n       protocol-kit : ${actual}\n       on-chain     : ${expected}`);
}

console.log(`Safe version : ${file.safeVersion}`);
console.log(`Source       : ${file.source}`);
console.log(`Vectors      : ${file.vectors.length}\n`);

if (file.safeVersion !== SAFE_VERSION) {
  console.error(`Vector file reports Safe ${file.safeVersion}, this tool assumes ${SAFE_VERSION}.`);
  process.exit(1);
}

for (const v of file.vectors) {
  console.log(`- ${v.name}  (chainId ${v.chainId}, nonce ${v.nonce})`);
  const safeTx = {
    to: v.to,
    value: String(v.value),
    data: v.data,
    operation: v.operation,
    safeTxGas: String(v.safeTxGas),
    baseGas: String(v.baseGas),
    gasPrice: String(v.gasPrice),
    gasToken: v.gasToken,
    refundReceiver: v.refundReceiver,
    nonce: v.nonce,
  };

  expect(
    `${v.name} safeTxHash`,
    calculateSafeTransactionHash(v.safeAddress, safeTx, SAFE_VERSION, BigInt(v.chainId)),
    v.safeTxHash,
  );
  expect(
    `${v.name} preimage`,
    preimageSafeTransactionHash(v.safeAddress, safeTx, SAFE_VERSION, BigInt(v.chainId)),
    v.preimage,
  );

  // The EIP-1271 envelope, rebuilt by the official helper rather than by hand.
  const owner = '0x' + v.contractSignatureEnvelope.slice(2 + 24, 2 + 64);
  const contractSig = new EthSafeSignature(owner, v.p256Signature, true);
  // buildSignatureBytes already returns a 0x-prefixed string.
  expect(`${v.name} contractSignatureEnvelope`, buildSignatureBytes([contractSig]), v.contractSignatureEnvelope);
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures) {
  console.error(`${failures} MISMATCH(ES) — protocol-kit disagrees with the chain.`);
  process.exit(1);
}
console.log('protocol-kit agrees with the on-chain Safe on every vector.');
