import {
  keccak256, encodeAbiParameters, parseAbiParameters, hexToBytes,
  recoverTypedDataAddress, recoverMessageAddress, isAddress, getAddress
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, usdcToken } from '../config.js';
import { chainProvider } from '../providers/index.js';
// Chain clients live in the Alchemy provider; re-exported here for existing importers.
import { monad, publicClient, relayerAccount, relayerWallet } from '../providers/alchemyProvider.js';

export { monad, publicClient, relayerAccount, relayerWallet };

/**
 * All EVM/Monad interaction for Prism's stablecoin execution layer.
 *
 * Prism never holds a user's key. The payer's Mera passkey-derived account signs (1) a Prism
 * EIP-712 PaymentEnvelope and (2) USDC's ERC-3009 authorization; this module builds those
 * payloads, verifies the returned signatures, and a MON-funded relayer submits so the user holds
 * MON = 0. The isolated claim authorizer (secp256k1) signs pre-user claim eligibility.
 */

const chainId = Number(config.chain.chainId);

let _authorizer = null;
export function claimAuthorizerAccount() {
  if (_authorizer) return _authorizer;
  if (!config.chain.claimAuthorizerPrivateKey) throw httpError(503, 'CLAIM_AUTHORIZER_PRIVATE_KEY not configured');
  _authorizer = privateKeyToAccount(normalizePk(config.chain.claimAuthorizerPrivateKey));
  return _authorizer;
}
export function claimAuthorizerAddress() { return getAddress(claimAuthorizerAccount().address); }

// ---- EIP-712: token domains + ERC-3009 authorizations ----------------------

export function usdcDomain() {
  const definition = usdcToken();
  return {
    name: definition.domain.name,
    version: definition.domain.version,
    chainId,
    verifyingContract: getAddress(definition.address)
  };
}

const ERC3009_FIELDS = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
];

/** USDC `TransferWithAuthorization`, the direct-payment primitive. */
export function transferAuthorizationTypedData({ from, to, value, validAfter, validBefore, nonce }) {
  return {
    domain: usdcDomain(),
    primaryType: 'TransferWithAuthorization',
    types: { TransferWithAuthorization: ERC3009_FIELDS },
    message: { from: getAddress(from), to: getAddress(to), value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce }
  };
}

/** USDC `ReceiveWithAuthorization`, used when a claim vault pulls funding. */
export function receiveAuthorizationTypedData({ from, to, value, validAfter, validBefore, nonce }) {
  return {
    domain: usdcDomain(),
    primaryType: 'ReceiveWithAuthorization',
    types: { ReceiveWithAuthorization: ERC3009_FIELDS },
    message: { from: getAddress(from), to: getAddress(to), value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce }
  };
}

// ---- EIP-712: Prism PaymentEnvelope (PrismPaymentRouter domain) -------------

const PAYMENT_ENVELOPE_FIELDS = [
  { name: 'paymentId', type: 'bytes32' }, { name: 'payer', type: 'address' }, { name: 'recipient', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'requestId', type: 'bytes32' },
  { name: 'resolutionHash', type: 'bytes32' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
];

export function paymentEnvelopeTypedData(env) {
  return {
    domain: { name: 'PrismPaymentRouter', version: '1', chainId, verifyingContract: getAddress(config.chain.paymentRouter) },
    primaryType: 'PaymentEnvelope',
    types: { PaymentEnvelope: PAYMENT_ENVELOPE_FIELDS },
    message: {
      paymentId: env.paymentId, payer: getAddress(env.payer), recipient: getAddress(env.recipient),
      amount: BigInt(env.amount), requestId: env.requestId,
      resolutionHash: env.resolutionHash, validBefore: BigInt(env.validBefore), nonce: env.nonce
    }
  };
}

// ---- EIP-712: Prism ClaimEligibility + recipient ClaimIntent (vault domain) -

function vaultDomain() {
  return { name: 'PrismClaimVault', version: '1', chainId, verifyingContract: getAddress(config.chain.claimVault) };
}

/** Isolated backend authorizer vouches that `recipient` controls the alias for this claim. */
export async function signClaimEligibility({ claimId, recipient, aliasVersion, expiry, nonce }) {
  return claimAuthorizerAccount().signTypedData({
    domain: vaultDomain(),
    primaryType: 'ClaimEligibility',
    types: {
      ClaimEligibility: [
        { name: 'claimId', type: 'bytes32' }, { name: 'recipient', type: 'address' },
        { name: 'aliasVersion', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
      ]
    },
    message: { claimId, recipient: getAddress(recipient), aliasVersion: BigInt(aliasVersion), expiry: BigInt(expiry), nonce }
  });
}

export function claimIntentTypedData({ claimId, recipient }) {
  return {
    domain: vaultDomain(),
    primaryType: 'ClaimIntent',
    types: { ClaimIntent: [{ name: 'claimId', type: 'bytes32' }, { name: 'recipient', type: 'address' }] },
    message: { claimId, recipient: getAddress(recipient) }
  };
}

// ---- verification ----------------------------------------------------------

export async function verifyTypedData(typed, expectedSigner, signature) {
  try {
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    return getAddress(recovered) === getAddress(expectedSigner);
  } catch { return false; }
}

export async function verifyAccountMessage(account, message, signature) {
  try { return getAddress(await recoverMessageAddress({ message, signature })) === getAddress(account); }
  catch { return false; }
}

export async function recoverAccountMessageDebug(message, signature) {
  try { return getAddress(await recoverMessageAddress({ message, signature })); }
  catch (e) { return `recover-failed: ${e.message}`; }
}

// ---- deterministic nonces --------------------------------------------------

export function claimFundingNonce(claimId, recipientReference, amount, from) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, uint256, address'),
    [claimId, recipientReference, BigInt(amount), getAddress(from)]
  ));
}

/** resolutionHash: opaque, derived ONLY from Prism resolver data (never a phone number). */
export function resolutionHash({ prismIdentity, recipientAccount, aliasVersion, resolutionRequestId }) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, address, uint256, bytes32'),
    [keccak256(Buffer.from(String(prismIdentity))), getAddress(recipientAccount), BigInt(aliasVersion), keccak256(Buffer.from(String(resolutionRequestId)))]
  ));
}

/**
 * routeHash: the cross-chain sibling of `resolutionHash`, occupying the same opaque envelope slot.
 *
 * A cross-chain send pays an Aurora deposit address on Monad. On its own, the envelope would only
 * bind "send N USDC to this address" — which says nothing about where that money is ultimately
 * going. This hash binds the REST of the promise into the same signature: the destination chain,
 * the destination asset, the recipient on that chain, the guaranteed minimum they receive, and the
 * quote's expiry.
 *
 * So the payer's one approval authorizes the whole deal. If the backend (or anyone who compromised
 * it) rewrote the destination after the user signed, the recomputed hash differs, the envelope
 * signature no longer recovers to the payer, and `settle()` reverts. This is decision #10
 * ("recipient/amount bound in-signature, so a relayer can't redirect or resize") extended across
 * the bridge rather than weakened for it.
 *
 * Every string field is hashed, so no destination address, chain name, or asset id reaches the
 * chain in the clear — the same posture `resolutionHash` takes with Prism identities.
 */
export function routeHash({ routeId, depositAddress, destinationChain, destinationAssetId, destinationRecipient, minAmountOut, quoteDeadline }) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, address, bytes32, bytes32, bytes32, uint256, uint256'),
    [
      keccak256(Buffer.from(String(routeId))),
      getAddress(depositAddress),
      keccak256(Buffer.from(String(destinationChain))),
      keccak256(Buffer.from(String(destinationAssetId))),
      // Lowercased before hashing: a destination address is compared case-insensitively for EVM
      // chains, and the hash must not change with the casing the user happened to paste.
      keccak256(Buffer.from(String(destinationRecipient).toLowerCase())),
      BigInt(minAmountOut),
      BigInt(quoteDeadline)
    ]
  ));
}

/**
 * contributionHash: the Circles sibling of `resolutionHash` and `routeHash`, in the same opaque
 * envelope slot.
 *
 * A contribution is an ordinary Prism payment whose recipient happens to be a Circle's Safe. On its
 * own the envelope would bind only "send N USDC to 0xabc…" — true, but it says nothing about *why*,
 * and a backend that later re-labels which Circle that address belongs to would be unfalsifiable.
 * Folding the Circle id, its Safe, the contributor and the amount into the signed hash means the
 * contributor's one signature covers the claim "this is my contribution to THIS Circle", and
 * reconciliation can check the settled payment against it rather than against a mutable row.
 */
export function contributionHash({ contributionId, circleId, safeAddress, contributorPrismId, amountAtomic }) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, address, bytes32, uint256'),
    [
      keccak256(Buffer.from(String(contributionId))),
      keccak256(Buffer.from(String(circleId))),
      getAddress(safeAddress),
      keccak256(Buffer.from(String(contributorPrismId))),
      BigInt(amountAtomic)
    ]
  ));
}

// ---- signature splitting ---------------------------------------------------

export function splitSignature(signature) {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 65) throw httpError(400, 'signature must be 65 bytes (r||s||v)');
  const r = `0x${Buffer.from(bytes.slice(0, 32)).toString('hex')}`;
  const s = `0x${Buffer.from(bytes.slice(32, 64)).toString('hex')}`;
  let v = bytes[64];
  if (v < 27) v += 27;
  return { r, s, v };
}

// ---- chain reads / integrity checks ----------------------------------------

export async function usdcBalanceOf(address) {
  const definition = usdcToken();
  return chainProvider().readContract({
    address: getAddress(definition.address),
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [getAddress(address)]
  });
}

/**
 * Has this ERC-3009 authorization already been consumed on-chain?
 *
 * This is the authoritative answer to "did my broadcast actually land?" when a relayer response is
 * lost in flight. USDC marks `(authorizer, nonce)` used inside the same transaction that moves the
 * money, so a `true` here means the payment settled (or the nonce was cancelled) and the submission
 * must be reconciled from the chain rather than blindly re-broadcast.
 */
export async function usdcAuthorizationUsed(authorizer, nonce) {
  const definition = usdcToken();
  return chainProvider().readContract({
    address: getAddress(definition.address),
    abi: [{
      name: 'authorizationState', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }],
      outputs: [{ type: 'bool' }]
    }],
    functionName: 'authorizationState',
    args: [getAddress(authorizer), nonce]
  });
}

/** Native MON balance — used by the proof surface to show a payer can pay with MON = 0. */
export async function monBalanceOf(address) { return chainProvider().getBalance(getAddress(address)); }

export async function getChainId() { return chainProvider().getChainId(); }

/** Fail closed if the RPC's chainId does not match configuration. */
export async function verifyChainId() {
  const onchain = await getChainId();
  return { ok: onchain === chainId, onchain, configured: chainId };
}

/** Recompute USDC's domain separator and compare it to the token's own value. */
export async function verifyUsdcDomain() {
  const definition = usdcToken();
  const onchain = await chainProvider().readContract({
    address: getAddress(definition.address),
    abi: [{ name: 'DOMAIN_SEPARATOR', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }],
    functionName: 'DOMAIN_SEPARATOR'
  });
  const EIP712_DOMAIN_TYPEHASH = keccak256(Buffer.from('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const local = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
    [
      EIP712_DOMAIN_TYPEHASH,
      keccak256(Buffer.from(definition.domain.name)),
      keccak256(Buffer.from(definition.domain.version)),
      BigInt(chainId),
      getAddress(definition.address)
    ]
  ));
  return { ok: onchain.toLowerCase() === local.toLowerCase(), onchain, local };
}

export function isEvmAddress(value) { return typeof value === 'string' && isAddress(value); }
export function checksum(value) { return getAddress(value); }
export { chainId };

function normalizePk(pk) { return pk.startsWith('0x') ? pk : `0x${pk}`; }
function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
