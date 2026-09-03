import {
  keccak256, encodeAbiParameters, parseAbiParameters, hexToBytes,
  recoverTypedDataAddress, recoverMessageAddress, isAddress, getAddress
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, AUSD_DOMAIN } from '../config.js';
import { chainProvider } from '../providers/index.js';
// Chain clients live in the Alchemy provider; re-exported here for existing importers.
import { monad, publicClient, relayerAccount, relayerWallet } from '../providers/alchemyProvider.js';

export { monad, publicClient, relayerAccount, relayerWallet };

/**
 * All EVM/Monad interaction for Prism's AUSD execution layer.
 *
 * Prism never holds a user's key. The payer's Mera passkey-derived account signs (1) a Prism
 * EIP-712 PaymentEnvelope and (2) the AUSD ERC-3009 authorization; this module builds those
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

// ---- EIP-712: AUSD domain + ERC-3009 authorizations ------------------------

export function ausdDomain() {
  return { name: AUSD_DOMAIN.name, version: AUSD_DOMAIN.version, chainId, verifyingContract: getAddress(config.chain.ausd) };
}

const ERC3009_FIELDS = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
];

/** AUSD `TransferWithAuthorization` — the direct-payment primitive (payer -> recipient). */
export function transferAuthorizationTypedData({ from, to, value, validAfter, validBefore, nonce }) {
  return {
    domain: ausdDomain(),
    primaryType: 'TransferWithAuthorization',
    types: { TransferWithAuthorization: ERC3009_FIELDS },
    message: { from: getAddress(from), to: getAddress(to), value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce }
  };
}

/** AUSD `ReceiveWithAuthorization` — claim funding pull (sender -> vault, vault is `to`). */
export function receiveAuthorizationTypedData({ from, to, value, validAfter, validBefore, nonce }) {
  return {
    domain: ausdDomain(),
    primaryType: 'ReceiveWithAuthorization',
    types: { ReceiveWithAuthorization: ERC3009_FIELDS },
    message: { from: getAddress(from), to: getAddress(to), value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce }
  };
}

// ---- EIP-712: Prism PaymentEnvelope (PrismPaymentRouter domain) -------------

const PAYMENT_ENVELOPE_FIELDS = [
  { name: 'paymentId', type: 'bytes32' }, { name: 'payer', type: 'address' }, { name: 'recipient', type: 'address' },
  { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'requestId', type: 'bytes32' },
  { name: 'resolutionHash', type: 'bytes32' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
];

export function paymentEnvelopeTypedData(env) {
  return {
    domain: { name: 'PrismPaymentRouter', version: '1', chainId, verifyingContract: getAddress(config.chain.paymentRouter) },
    primaryType: 'PaymentEnvelope',
    types: { PaymentEnvelope: PAYMENT_ENVELOPE_FIELDS },
    message: {
      paymentId: env.paymentId, payer: getAddress(env.payer), recipient: getAddress(env.recipient),
      token: getAddress(env.token), amount: BigInt(env.amount), requestId: env.requestId,
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

export async function ausdBalanceOf(address) {
  return chainProvider().readContract({
    address: getAddress(config.chain.ausd),
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [getAddress(address)]
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

/** Verify-don't-trust: recompute AUSD's domain separator and compare to the token's own. */
export async function verifyAusdDomain() {
  const onchain = await chainProvider().readContract({
    address: getAddress(config.chain.ausd),
    abi: [{ name: 'DOMAIN_SEPARATOR', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }],
    functionName: 'DOMAIN_SEPARATOR'
  });
  const EIP712_DOMAIN_TYPEHASH = keccak256(Buffer.from('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const local = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
    [EIP712_DOMAIN_TYPEHASH, keccak256(Buffer.from(AUSD_DOMAIN.name)), keccak256(Buffer.from(AUSD_DOMAIN.version)), BigInt(chainId), getAddress(config.chain.ausd)]
  ));
  return { ok: onchain.toLowerCase() === local.toLowerCase(), onchain, local };
}

export function isEvmAddress(value) { return typeof value === 'string' && isAddress(value); }
export function checksum(value) { return getAddress(value); }
export { chainId };

function normalizePk(pk) { return pk.startsWith('0x') ? pk : `0x${pk}`; }
function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
