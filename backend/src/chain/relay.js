import { getAddress } from 'viem';
import { config } from '../config.js';
import { relayerAccount, splitSignature } from './eth.js';
import { chainProvider } from '../providers/index.js';

/**
 * Relayer write path. A MON-funded relayer submits the user-authorized settlement/claim/refund,
 * pays gas, and returns the transaction hash. The relayer can ONLY call the specific functions of
 * the configured router/vault with validated arguments — never arbitrary calldata, never an
 * arbitrary destination. Every write is simulated first and reverts are surfaced before broadcast.
 */

const PAYMENT_ENVELOPE_TUPLE = {
  name: 'env', type: 'tuple', components: [
    { name: 'paymentId', type: 'bytes32' }, { name: 'payer', type: 'address' }, { name: 'recipient', type: 'address' },
    { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'requestId', type: 'bytes32' },
    { name: 'resolutionHash', type: 'bytes32' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
  ]
};

const ROUTER_ABI = [{
  type: 'function', name: 'settle', stateMutability: 'nonpayable', outputs: [],
  inputs: [PAYMENT_ENVELOPE_TUPLE, { name: 'prismSignature', type: 'bytes' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }]
}];

const VAULT_ABI = [
  {
    type: 'function', name: 'fundClaim', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'claimId', type: 'bytes32' }, { name: 'recipientReference', type: 'bytes32' }, { name: 'sender', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }
    ]
  },
  {
    type: 'function', name: 'claim', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'claimId', type: 'bytes32' }, { name: 'recipient', type: 'address' }, { name: 'aliasVersion', type: 'uint256' },
      { name: 'eligibilityExpiry', type: 'uint256' }, { name: 'eligibilityNonce', type: 'bytes32' },
      { name: 'authorizerSig', type: 'bytes' }, { name: 'recipientSig', type: 'bytes' }
    ]
  },
  { type: 'function', name: 'refund', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'claimId', type: 'bytes32' }] }
];

function assertAllowedContract(address) {
  if (!config.chain.contractAllowlist.includes(String(address).toLowerCase())) {
    throw httpError(400, 'destination is not an allowlisted Prism contract');
  }
}
function assertAllowedToken(address) {
  if (!config.chain.tokenAllowlist.includes(String(address).toLowerCase())) {
    throw httpError(400, 'token is not allowlisted');
  }
}

/** Simulate then submit a single, fixed-shape call to an allowlisted contract (via Alchemy). */
async function simulateAndWrite({ address, abi, functionName, args }) {
  assertAllowedContract(address);
  const account = relayerAccount();
  // Simulation reverts here (before any broadcast) if the on-chain checks would fail.
  const { request } = await chainProvider().simulateContract({ address: getAddress(address), abi, functionName, args, account });
  return chainProvider().writeContract(request);
}

export async function relaySettle({ env, prismSignature, tokenSignature }) {
  assertAllowedToken(env.token);
  const { v, r, s } = splitSignature(tokenSignature);
  const tuple = {
    paymentId: env.paymentId, payer: getAddress(env.payer), recipient: getAddress(env.recipient),
    token: getAddress(env.token), amount: BigInt(env.amount), requestId: env.requestId,
    resolutionHash: env.resolutionHash, validBefore: BigInt(env.validBefore), nonce: env.nonce
  };
  return simulateAndWrite({ address: config.chain.paymentRouter, abi: ROUTER_ABI, functionName: 'settle', args: [tuple, prismSignature, v, r, s] });
}

export async function relayFundClaim({ claimId, recipientReference, sender, token, amount, expiry, validAfter, validBefore, nonce, signature }) {
  assertAllowedToken(token);
  const { v, r, s } = splitSignature(signature);
  return simulateAndWrite({
    address: config.chain.claimVault, abi: VAULT_ABI, functionName: 'fundClaim',
    args: [claimId, recipientReference, getAddress(sender), getAddress(token), BigInt(amount), BigInt(expiry), BigInt(validAfter), BigInt(validBefore), nonce, v, r, s]
  });
}

export async function relayClaim({ claimId, recipient, aliasVersion, eligibilityExpiry, eligibilityNonce, authorizerSig, recipientSig }) {
  return simulateAndWrite({
    address: config.chain.claimVault, abi: VAULT_ABI, functionName: 'claim',
    args: [claimId, getAddress(recipient), BigInt(aliasVersion), BigInt(eligibilityExpiry), eligibilityNonce, authorizerSig, recipientSig]
  });
}

export async function relayRefund({ claimId }) {
  return simulateAndWrite({ address: config.chain.claimVault, abi: VAULT_ABI, functionName: 'refund', args: [claimId] });
}

export async function getReceipt(txHash) {
  return chainProvider().getTransactionReceipt(txHash);
}

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
