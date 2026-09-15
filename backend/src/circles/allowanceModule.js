/**
 * Safe Allowance Module v1.0.0 — encoding, limit periods, and the version floor.
 *
 * Pure: no RPC, no state. Everything here is a deterministic function of its arguments, so the
 * encodings can be checked against the real module's own `generateTransferHash` without a chain.
 *
 * Two facts about this module shape everything below, and both were established by running the
 * security matrix in `contracts/test/AllowanceModuleCompat.t.sol` against Safe's actual deployed
 * bytecode. They are worth stating here because they are the reason the code looks the way it does:
 *
 *  1. **v1.0.0 removed EIP-1271.** A contract delegate can no longer authorize a transfer with a
 *     signature — `recoverSignature` reverts outright on `v == 0`. A contract may only authorize by
 *     *being the caller*. Prism's member authority is an ordinary Mera secp256k1 EOA, so Circles
 *     uses the plain ECDSA path and a relayer submits; the member still holds MON = 0.
 *
 *  2. **A delegate cannot express an arbitrary call.** The module's only outward instruction to the
 *     Safe is a fixed-shape `transfer(address,uint256)` it assembles itself. There is no request
 *     shape in which a delegate supplies calldata, which is why "a delegate cannot change owners /
 *     enable a module / grant an approval" are structural facts rather than validations.
 */
import { encodeFunctionData, getAddress, isAddress, keccak256, encodeAbiParameters, concatHex } from 'viem';
import { badRequest } from './model.js';

/**
 * The floor. v1.0.0 fixed a `uint16` allowance-nonce overflow that let past delegate transfers be
 * replayed; v0.1.0 and v0.1.1 both carry it, and one of them is deployed on Monad.
 */
export const MINIMUM_ALLOWANCE_MODULE_VERSION = '1.0.0';

/** Releases known to carry the replay bug. Listed by VERSION, so a redeploy at a new address is still refused. */
export const VULNERABLE_ALLOWANCE_MODULE_VERSIONS = Object.freeze(['0.1.0', '0.1.1']);

/**
 * The canonical v1.0.0 deployment. `codeHash` is keccak256 of its runtime bytecode, captured
 * byte-identical from Optimism and Gnosis — see contracts/vendor/safe-allowances-v1.0.0/PROVENANCE.md.
 */
export const CANONICAL_ALLOWANCE_MODULE = Object.freeze({
  version: '1.0.0',
  address: '0x691f59471Bfd2B7d639DCF74671a2d648ED1E331',
  codeHash: '0xfafc86ce3000fbdc8ad155875c0b3b5a20d17662e7c2cdbf3e95f15945a46657',
  sourceTag: 'allowances/v1.0.0',
  sourceCommit: 'c95f03900bff99be090dadb9de1c74b162365485'
});

/** The Safe release that introduced `execTransactionFromModuleReturnData`, which v1.0.0 requires. */
export const MINIMUM_SAFE_VERSION_FOR_MODULE = '1.1.1';

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

export function meetsMinimumModuleVersion(version) {
  return compareVersions(version, MINIMUM_ALLOWANCE_MODULE_VERSION) >= 0;
}

// --- limit periods -----------------------------------------------------------

/**
 * The periods a Circle may express. The module stores a reset window in **minutes**, and applies
 * the reset itself on read — which is why "spent today" is always a chain read and never a sum of
 * Prism's activity rows.
 *
 * `TOTAL` is `resetTimeMin: 0`, which the module treats as "never resets": a one-off budget that is
 * gone once spent. That is "David — $500 total".
 */
export const LimitPeriod = Object.freeze({
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
  MONTHLY: 'MONTHLY',
  TOTAL: 'TOTAL'
});

export const PERIOD_MINUTES = Object.freeze({
  DAILY: 1440,
  WEEKLY: 10080,
  MONTHLY: 43200,
  TOTAL: 0
});

export const PERIOD_LABELS = Object.freeze({
  DAILY: 'per day',
  WEEKLY: 'per week',
  MONTHLY: 'per month',
  TOTAL: 'total'
});

/** The same periods as adjectives, for sentences like "above your $100 daily limit". */
export const PERIOD_ADJECTIVES = Object.freeze({
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  TOTAL: 'total'
});

export function assertPeriod(period) {
  if (!Object.values(LimitPeriod).includes(period)) {
    throw badRequest(`unknown spending limit period: ${period}; expected one of ${Object.values(LimitPeriod).join(', ')}`);
  }
  return period;
}

export function periodMinutes(period) { return PERIOD_MINUTES[assertPeriod(period)]; }

/** Recover the period from the module's stored reset window. Unknown windows are reported honestly. */
export function periodFromMinutes(resetTimeMin) {
  const minutes = Number(resetTimeMin);
  const match = Object.entries(PERIOD_MINUTES).find(([, m]) => m === minutes);
  return match ? match[0] : `EVERY_${minutes}_MINUTES`;
}

/**
 * The module packs an allowance amount into a `uint96`. Anything larger silently truncates, so it
 * is refused here rather than written.
 */
export const MAX_ALLOWANCE_ATOMIC = (1n << 96n) - 1n;

export function assertAllowanceAmount(amountAtomic) {
  if (!/^\d+$/.test(String(amountAtomic))) throw badRequest('a spending limit must be a whole number of atomic units');
  const amount = BigInt(amountAtomic);
  if (amount < 0n) throw badRequest('a spending limit cannot be negative');
  if (amount > MAX_ALLOWANCE_ATOMIC) throw badRequest('that spending limit is too large for the Allowance Module to store');
  return amount;
}

// --- ABI ---------------------------------------------------------------------

export const ALLOWANCE_MODULE_ABI = [
  { name: 'NAME', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'VERSION', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'addDelegate', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'delegate', type: 'address' }] },
  {
    name: 'removeDelegate', type: 'function', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'delegate', type: 'address' }, { name: 'removeAllowances', type: 'bool' }]
  },
  {
    name: 'setAllowance', type: 'function', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'delegate', type: 'address' }, { name: 'token', type: 'address' },
      { name: 'allowanceAmount', type: 'uint96' }, { name: 'resetTimeMin', type: 'uint16' },
      { name: 'resetBaseMin', type: 'uint32' }
    ]
  },
  {
    name: 'deleteAllowance', type: 'function', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'delegate', type: 'address' }, { name: 'token', type: 'address' }]
  },
  {
    name: 'getTokenAllowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'safe', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256[5]' }]
  },
  {
    name: 'getDelegates', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'safe', type: 'address' }, { name: 'start', type: 'uint48' }, { name: 'pageSize', type: 'uint8' }],
    outputs: [{ name: 'results', type: 'address[]' }, { name: 'next', type: 'uint48' }]
  },
  {
    name: 'generateTransferHash', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'safe', type: 'address' }, { name: 'token', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint96' }, { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint96' }, { name: 'nonce', type: 'uint16' }
    ],
    outputs: [{ type: 'bytes32' }]
  },
  {
    name: 'executeAllowanceTransfer', type: 'function', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'safe', type: 'address' }, { name: 'token', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint96' }, { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint96' }, { name: 'delegate', type: 'address' }, { name: 'signature', type: 'bytes' }
    ]
  }
];

/** `isModuleEnabled` on the Safe itself, used to check the module is actually installed. */
export const SAFE_MODULE_ABI = [
  { name: 'isModuleEnabled', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'enableModule', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ type: 'address' }] },
  { name: 'disableModule', type: 'function', stateMutability: 'nonpayable', outputs: [], inputs: [{ type: 'address' }, { type: 'address' }] }
];

// --- calldata Circles builds -------------------------------------------------
//
// Every one of these is executed BY THE SAFE, which means every one of them is a threshold-approved
// Circle transaction. There is no path by which a member changes their own limit.

export function encodeEnableModule({ module }) {
  return encodeFunctionData({ abi: SAFE_MODULE_ABI, functionName: 'enableModule', args: [assertAddress(module, 'module')] });
}

export function encodeAddDelegate({ delegate }) {
  return encodeFunctionData({ abi: ALLOWANCE_MODULE_ABI, functionName: 'addDelegate', args: [assertAddress(delegate, 'delegate')] });
}

/**
 * `removeAllowances: true` — revoking a member's spending access zeroes their allowance figures as
 * well as unregistering them, so re-adding the delegate later cannot silently restore an old limit.
 */
export function encodeRemoveDelegate({ delegate, removeAllowances = true }) {
  return encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI, functionName: 'removeDelegate',
    args: [assertAddress(delegate, 'delegate'), Boolean(removeAllowances)]
  });
}

export function encodeSetAllowance({ delegate, token, amountAtomic, period, resetBaseMin = 0 }) {
  const minutes = periodMinutes(period);
  return encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI, functionName: 'setAllowance',
    args: [
      assertAddress(delegate, 'delegate'), assertAddress(token, 'token'),
      assertAllowanceAmount(amountAtomic), minutes, Number(resetBaseMin)
    ]
  });
}

export function encodeDeleteAllowance({ delegate, token }) {
  return encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI, functionName: 'deleteAllowance',
    args: [assertAddress(delegate, 'delegate'), assertAddress(token, 'token')]
  });
}

/**
 * The allowance transfer itself, submitted by the relayer.
 *
 * `paymentToken`/`payment` are always zero. The module can reimburse whoever submits the
 * transaction out of the SAME member allowance and send it to `tx.origin` — so a non-zero payment
 * is a second, unreviewed spend from the member's budget. Prism sponsors gas from the relayer
 * instead, and `AllowanceModuleCompat.t.sol::testRelayerPaymentWouldBeChargedToTheMembersAllowance`
 * pins what the alternative would have cost.
 */
export function encodeExecuteAllowanceTransfer({ safeAddress, token, recipient, amountAtomic, delegate, signature }) {
  return encodeFunctionData({
    abi: ALLOWANCE_MODULE_ABI, functionName: 'executeAllowanceTransfer',
    args: [
      assertAddress(safeAddress, 'safe'), assertAddress(token, 'token'), assertAddress(recipient, 'recipient'),
      assertAllowanceAmount(amountAtomic), ZERO, 0n, assertAddress(delegate, 'delegate'), signature ?? '0x'
    ]
  });
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** keccak256("EIP712Domain(uint256 chainId,address verifyingContract)") — the module's own domain. */
const DOMAIN_TYPEHASH = '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218';
/** keccak256("AllowanceTransfer(address safe,address token,address to,uint96 amount,address paymentToken,uint96 payment,uint16 nonce)") */
const ALLOWANCE_TRANSFER_TYPEHASH = '0x97c7ed08d51f4a077f71428543a8a2454799e5f6df78c03ef278be094511eda4';

/**
 * The 32 bytes a delegate signs, recomputed locally.
 *
 * Mirrors the module's `generateTransferHash`. Prism computes this itself AND cross-checks it
 * against the deployed module's own answer before asking anyone to sign — the same discipline the
 * Safe digest gets, and for the same reason: this is the value a compromised backend would lie with.
 *
 * Note what it binds and what it does not. The Safe, token, recipient, amount and the delegate's
 * per-token nonce are all inside it; the **delegate is not**. That is safe only because the module
 * separately requires the recovered signer to equal the `delegate` argument — never rely on the
 * hash alone to identify who authorized a transfer.
 */
export function allowanceTransferHash({ chainId, moduleAddress, safeAddress, token, recipient, amountAtomic, nonce }) {
  const domainSeparator = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [DOMAIN_TYPEHASH, BigInt(chainId), assertAddress(moduleAddress, 'module')]
  ));
  const transferHash = keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
      { type: 'uint96' }, { type: 'address' }, { type: 'uint96' }, { type: 'uint16' }
    ],
    [
      ALLOWANCE_TRANSFER_TYPEHASH, assertAddress(safeAddress, 'safe'), assertAddress(token, 'token'),
      assertAddress(recipient, 'recipient'), assertAllowanceAmount(amountAtomic), ZERO, 0n, Number(nonce)
    ]
  ));
  return keccak256(concatHex(['0x1901', domainSeparator, transferHash]));
}

/**
 * Turn the module's `getTokenAllowance` tuple into the three numbers a person reads.
 *
 * `[amount, spent, resetTimeMin, lastResetMin, nonce]`, already reset-adjusted by the contract —
 * `getTokenAllowance` calls the same internal `getAllowance` that a transfer does, so the `spent`
 * it reports is the one the next transfer will be checked against. This is the only honest source
 * for "available": deriving it from Prism's activity would drift the moment a transfer happened
 * that Prism did not originate, or the moment a period rolled over.
 */
export function readAllowance(tuple, { token, decimals }) {
  const [amount, spent, resetTimeMin, lastResetMin, nonce] = tuple.map((v) => BigInt(v));
  const available = amount > spent ? amount - spent : 0n;
  return {
    amountAtomic: amount.toString(),
    spentAtomic: spent.toString(),
    availableAtomic: available.toString(),
    period: periodFromMinutes(resetTimeMin),
    resetTimeMin: Number(resetTimeMin),
    // `lastResetMin` is in minutes since the epoch; null when the allowance never resets.
    windowStartedAt: Number(resetTimeMin) > 0 && lastResetMin > 0n
      ? new Date(Number(lastResetMin) * 60_000).toISOString()
      : null,
    resetsAt: Number(resetTimeMin) > 0 && lastResetMin > 0n
      ? new Date((Number(lastResetMin) + Number(resetTimeMin)) * 60_000).toISOString()
      : null,
    nonce: Number(nonce),
    // A configured allowance always has nonce >= 1: the module sets it to 1 the first time a token
    // is allowed, so nonce 0 means "never configured" rather than "configured and unused".
    configured: nonce > 0n && amount > 0n,
    token,
    decimals,
    source: 'chain'
  };
}

function assertAddress(value, what) {
  if (!isAddress(value ?? '')) throw badRequest(`${what} must be an address`);
  return getAddress(value);
}
