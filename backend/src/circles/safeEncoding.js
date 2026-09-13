/**
 * Pure Safe v1.4.1 encoding. No RPC, no state — every function here is a deterministic function of
 * its arguments, which is what lets the test suite check it against transaction hashes that came
 * out of a real Safe contract on Monad (`proof/circles/safe-tx-vectors.json`).
 *
 * This is the fourth independent implementation of the Safe digest in this repository: the chain
 * itself, the official protocol-kit (tools/circles), Swift on the phone (ios/Prism/Core/Circles),
 * and now the backend. They are held to one another deliberately. The backend's copy is the one a
 * compromised server would have to lie with, so it is the one that must be checkable offline.
 */
import { keccak256, encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, isAddress, concatHex, padHex } from 'viem';
import { badRequest } from './model.js';

/** keccak256("EIP712Domain(uint256 chainId,address verifyingContract)") */
export const DOMAIN_TYPEHASH = '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218';
/** keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)") */
export const SAFE_TX_TYPEHASH = '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Safe's owner linked list is rooted at address(1). `removeOwner` needs the node pointing at the victim. */
export const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001';

export const SafeOperation = Object.freeze({ CALL: 0, DELEGATE_CALL: 1 });

// --- the Safe transaction ----------------------------------------------------

/**
 * Normalize the ten fields that go into a Safe digest. All ten are filled explicitly — Circles never
 * leaves a gas-refund field to a default, because a non-zero `gasPrice` makes the Safe reimburse
 * `refundReceiver` out of Circle funds: a second, unreviewed payment hidden inside the first.
 */
export function safeTransaction({ to, value = 0n, data = '0x', operation = SafeOperation.CALL, safeTxGas = 0n, baseGas = 0n, gasPrice = 0n, gasToken = ZERO_ADDRESS, refundReceiver = ZERO_ADDRESS, nonce }) {
  if (!isAddress(to)) throw badRequest('safe transaction `to` must be an address');
  if (operation !== SafeOperation.CALL) {
    // DelegateCall hands the Circle's entire balance to arbitrary code. Circles has no use for it,
    // so rather than validate it carefully we refuse to construct one at all.
    throw badRequest('Prism Circles only builds Call transactions; delegatecall is never proposed');
  }
  if (nonce === undefined || nonce === null) throw badRequest('safe transaction nonce is required');
  return {
    to: getAddress(to),
    value: BigInt(value),
    data: data ?? '0x',
    operation,
    safeTxGas: BigInt(safeTxGas),
    baseGas: BigInt(baseGas),
    gasPrice: BigInt(gasPrice),
    gasToken: getAddress(gasToken),
    refundReceiver: getAddress(refundReceiver),
    nonce: BigInt(nonce)
  };
}

export function domainSeparator({ chainId, safeAddress }) {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [DOMAIN_TYPEHASH, BigInt(chainId), getAddress(safeAddress)]
  ));
}

export function safeTxStructHash(tx) {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }
    ],
    [
      SAFE_TX_TYPEHASH, tx.to, tx.value, keccak256(tx.data), tx.operation,
      tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce
    ]
  ));
}

/** The EIP-712 pre-image `0x19 0x01 || domainSeparator || structHash` — what an EIP-1271 owner is handed. */
export function encodeTransactionData({ chainId, safeAddress, tx }) {
  return concatHex(['0x1901', domainSeparator({ chainId, safeAddress }), safeTxStructHash(tx)]);
}

/** The 32 bytes an owner signs. Binds this Circle, this chain and this nonce; nothing else can replay it. */
export function safeTxHash({ chainId, safeAddress, tx }) {
  return keccak256(encodeTransactionData({ chainId, safeAddress, tx }));
}

// --- deployment --------------------------------------------------------------

const SETUP_ABI = [{
  name: 'setup', type: 'function', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' }
  ]
}];

/**
 * The `setup` call a new Circle Safe is initialized with.
 *
 * `to`/`data` are zero: Circles installs no module and runs no setup delegatecall, so a Circle Safe
 * at birth is exactly the audited singleton with an owner set — nothing extra in the trusted base.
 * The payment fields are zero because the relayer pays gas from outside the Safe, not out of the
 * Circle's own funds.
 */
export function encodeSetupInitializer({ owners, threshold, fallbackHandler }) {
  const normalized = normalizeOwnerSet(owners);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > normalized.length) {
    throw badRequest('setup threshold must be between 1 and the number of owners');
  }
  return encodeFunctionData({
    abi: SETUP_ABI,
    functionName: 'setup',
    args: [normalized, BigInt(threshold), ZERO_ADDRESS, '0x', getAddress(fallbackHandler), ZERO_ADDRESS, 0n, ZERO_ADDRESS]
  });
}

/**
 * The CREATE2 address `createProxyWithNonce` will produce.
 *
 * `proxyCreationCode` is a required argument rather than a hardcoded constant on purpose: it is read
 * from the factory contract itself, so a factory that does not produce the bytecode we assumed
 * yields a different predicted address and the deployment fails verification instead of silently
 * landing somewhere unexpected.
 */
export function predictSafeAddress({ proxyFactory, singleton, initializer, saltNonce, proxyCreationCode }) {
  if (!isAddress(proxyFactory)) throw badRequest('proxy factory must be an address');
  if (!/^0x[0-9a-fA-F]*$/.test(proxyCreationCode ?? '')) throw badRequest('proxyCreationCode must be read from the factory');
  // salt = keccak256(keccak256(initializer) ++ saltNonce), exactly as SafeProxyFactory computes it
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), BigInt(saltNonce)]));
  const initCode = concatHex([proxyCreationCode, padHex(getAddress(singleton).toLowerCase(), { size: 32 })]);
  const hash = keccak256(concatHex(['0xff', getAddress(proxyFactory), salt, keccak256(initCode)]));
  return getAddress(`0x${hash.slice(-40)}`);
}

// --- calldata Circles builds -------------------------------------------------

const ERC20_ABI = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }];

export function encodeUsdcTransfer({ recipient, amountAtomic }) {
  if (!isAddress(recipient)) throw badRequest('recipient must be an address');
  const amount = BigInt(amountAtomic);
  if (amount <= 0n) throw badRequest('amount must be positive');
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [getAddress(recipient), amount] });
}

const OWNER_ABI = [
  { name: 'addOwnerWithThreshold', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'owner', type: 'address' }, { name: '_threshold', type: 'uint256' }] },
  { name: 'removeOwner', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'prevOwner', type: 'address' }, { name: 'owner', type: 'address' }, { name: '_threshold', type: 'uint256' }] },
  { name: 'changeThreshold', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: '_threshold', type: 'uint256' }] }
];

export function encodeAddOwnerWithThreshold({ owner, threshold }) {
  return encodeFunctionData({ abi: OWNER_ABI, functionName: 'addOwnerWithThreshold', args: [getAddress(owner), BigInt(threshold)] });
}
export function encodeRemoveOwner({ prevOwner, owner, threshold }) {
  return encodeFunctionData({ abi: OWNER_ABI, functionName: 'removeOwner', args: [getAddress(prevOwner), getAddress(owner), BigInt(threshold)] });
}
export function encodeChangeThreshold({ threshold }) {
  return encodeFunctionData({ abi: OWNER_ABI, functionName: 'changeThreshold', args: [BigInt(threshold)] });
}

/**
 * Safe stores owners as a linked list, so removing one requires the node that points at it. The
 * predecessor must be derived from the *live* on-chain owner order — deriving it from a remembered
 * copy is how a removal proposal silently targets the wrong owner after an intervening change.
 */
export function prevOwnerFor(owners, owner) {
  const list = owners.map((o) => getAddress(o));
  const target = getAddress(owner);
  const index = list.indexOf(target);
  if (index === -1) throw badRequest('address is not an owner of this Circle');
  return index === 0 ? SENTINEL_OWNERS : list[index - 1];
}

/**
 * Safe's signature envelope: fixed 65-byte words concatenated in ascending owner-address order.
 * Safe walks the owner list while verifying, so out-of-order signatures are rejected on-chain — the
 * sort is part of the format, not a nicety.
 */
export function buildSignatureBytes(approvals) {
  const sorted = [...approvals].sort((a, b) =>
    getAddress(a.authorityAddress).toLowerCase() < getAddress(b.authorityAddress).toLowerCase() ? -1 : 1);
  return concatHex(sorted.map((a) => a.signature));
}

/** Case-insensitive set comparison for owner sets. Address casing is never a difference that matters. */
export function sameOwnerSet(a, b) {
  const norm = (list) => [...new Set(list.map((x) => getAddress(x)))].sort();
  const left = norm(a); const right = norm(b);
  return left.length === right.length && left.every((x, i) => x === right[i]);
}

/** Reject duplicates and non-addresses up front; Safe would revert on either, with a worse message. */
export function normalizeOwnerSet(owners) {
  if (!Array.isArray(owners) || owners.length === 0) throw badRequest('a Circle needs at least one admin authority');
  const seen = new Set();
  const out = [];
  for (const owner of owners) {
    if (!isAddress(owner)) throw badRequest(`admin authority is not a valid address: ${owner}`);
    const checksummed = getAddress(owner);
    if (seen.has(checksummed.toLowerCase())) throw badRequest('the same admin authority was selected twice');
    seen.add(checksummed.toLowerCase());
    out.push(checksummed);
  }
  return out;
}
