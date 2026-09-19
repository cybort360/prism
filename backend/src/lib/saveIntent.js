import { getAddress } from 'viem';
import { verifyTypedData } from '../chain/eth.js';

// SaveIntent — the EXPLICIT thing the user authorizes. Not "arbitrary DeFi calls": "move exactly up to X
// USDC from my Prism balance into the approved Prism Save strategy, subject to minimum output and a
// deadline." Every protected field is bound into an EIP-712 signature, so changing ANY of them after
// authorization invalidates execution (the recovered signer no longer matches the owner).
//
// This is the same posture as the payment envelope (chain/eth.js): the signature — not the backend — is
// the source of truth for what was authorized.

const SAVE_INTENT_FIELDS = [
  { name: 'owner', type: 'address' },
  { name: 'inputToken', type: 'address' },        // USDC
  { name: 'maxInputUSDC', type: 'uint256' },      // upper bound the user agreed to move
  { name: 'intermediateToken', type: 'address' }, // AUSD
  { name: 'vault', type: 'address' },              // verified earnAUSD vault
  { name: 'shareToken', type: 'address' },         // verified earnAUSD share token
  { name: 'minAUSDOut', type: 'uint256' },         // slippage floor for the swap
  { name: 'minSharesOut', type: 'uint256' },       // floor for shares minted
  { name: 'receiver', type: 'address' },           // MUST be the owner
  { name: 'quoteId', type: 'bytes32' },            // binds the exact quote
  { name: 'deadline', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },              // single-use
  { name: 'chainId', type: 'uint256' }
];

export function saveIntentTypedData(intent, { verifyingContract }) {
  return {
    domain: { name: 'PrismSave', version: '1', chainId: Number(intent.chainId), verifyingContract: getAddress(verifyingContract) },
    primaryType: 'SaveIntent',
    types: { SaveIntent: SAVE_INTENT_FIELDS },
    message: {
      owner: getAddress(intent.owner), inputToken: getAddress(intent.inputToken), maxInputUSDC: BigInt(intent.maxInputUSDC),
      intermediateToken: getAddress(intent.intermediateToken), vault: getAddress(intent.vault), shareToken: getAddress(intent.shareToken),
      minAUSDOut: BigInt(intent.minAUSDOut), minSharesOut: BigInt(intent.minSharesOut), receiver: getAddress(intent.receiver),
      quoteId: intent.quoteId, deadline: BigInt(intent.deadline), nonce: intent.nonce, chainId: BigInt(intent.chainId)
    }
  };
}

/** True only if `signature` recovers to `intent.owner` over the exact intent. Any mutated protected field
 *  changes the hash → recovery differs → false. Pure crypto; no chain provider. */
export async function verifySaveIntentSignature(intent, signature, { verifyingContract }) {
  try {
    return await verifyTypedData(saveIntentTypedData(intent, { verifyingContract }), intent.owner, signature);
  } catch { return false; }
}

/**
 * Structural validation of a SaveIntent against the app's own trusted config + the amount/owner the user
 * reviewed. This is the backend twin of the client signing guard: it rejects a foreign vault, a non-owner
 * receiver, a wrong chain, a stale deadline, or a raised amount — independent of the signature.
 */
export function validateSaveIntent(intent, { save, expectedOwner, maxInputUSDC, now = Math.floor(Date.now() / 1000) }) {
  const v = [];
  const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  if (!eq(intent.owner, expectedOwner)) v.push('owner_mismatch');
  if (!eq(intent.receiver, expectedOwner)) v.push('receiver_not_owner');          // shares must land with the user
  if (!eq(intent.inputToken, save.substrateUsdc)) v.push('input_not_usdc');
  if (!eq(intent.intermediateToken, save.ausd)) v.push('intermediate_not_ausd');
  if (!eq(intent.vault, save.earnAusdVault)) v.push('vault_not_verified_earnausd');
  if (Number(intent.chainId) !== Number(save.substrateChainId)) v.push('wrong_chain');
  if (BigInt(intent.maxInputUSDC || 0) <= 0n || BigInt(intent.maxInputUSDC) > BigInt(maxInputUSDC)) v.push('input_amount_out_of_bounds');
  if (BigInt(intent.minAUSDOut || 0) <= 0n) v.push('missing_min_ausd');
  if (BigInt(intent.minSharesOut || 0) <= 0n) v.push('missing_min_shares');
  if (!(Number(intent.deadline) > now)) v.push('expired_intent');
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(intent.nonce))) v.push('bad_nonce');
  return { ok: v.length === 0, violations: v };
}

/** Single-use nonce: reject a replayed authorization. Backed by the store's `saveNonces` set. */
export function consumeSaveNonce(store, owner, nonce) {
  let ok = false;
  store.mutate((d) => {
    d.saveNonces ||= {};
    const key = `${String(owner).toLowerCase()}:${nonce}`;
    if (!d.saveNonces[key]) { d.saveNonces[key] = new Date().toISOString(); ok = true; }
  });
  return ok; // false ⇒ already used (replay)
}
