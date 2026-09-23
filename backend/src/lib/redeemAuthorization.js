import { getAddress } from 'viem';
import { verifyTypedData } from '../chain/eth.js';

const REDEEM_FIELDS = [
  { name: 'owner', type: 'address' },
  { name: 'shares', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' }
];

// Typed data for MockVault.redeemWithAuthorization. MUST match the contract's EIP-712 domain
// (name "Prism Save Demo Vault", version "1", verifyingContract = the vault) and typehash exactly.
export function redeemAuthorizationTypedData({ owner, shares, validAfter, validBefore, nonce, vault, chainId }) {
  return {
    domain: { name: 'Prism Save Demo Vault', version: '1', chainId: Number(chainId), verifyingContract: getAddress(vault) },
    primaryType: 'RedeemWithAuthorization',
    types: { RedeemWithAuthorization: REDEEM_FIELDS },
    message: {
      owner: getAddress(owner), shares: BigInt(shares),
      validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce
    }
  };
}

export async function verifyRedeemAuthorization(params, signature) {
  try { return await verifyTypedData(redeemAuthorizationTypedData(params), params.owner, signature); }
  catch { return false; }
}
