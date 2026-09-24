import { getAddress } from 'viem';
import { chainProvider } from '../providers/index.js';
import { config } from '../config.js';

// The demo Save vault (contracts/src/mocks/MockVault.sol). Real testnet reads/writes; the relayer
// submits deposits/redeems over the user's signature. Only used when config.save.mode === 'demo'.
export const MOCK_VAULT_ABI = [
  { type: 'function', name: 'previewDeposit', stateMutability: 'view', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'depositWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }
    ], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'redeemWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' }, { name: 'shares', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }
    ], outputs: [{ type: 'uint256' }] }
];

function vaultAddress() {
  if (!config.save.mockVault) { const e = new Error('SAVE_MOCK_VAULT is not configured'); e.statusCode = 503; throw e; }
  return getAddress(config.save.mockVault);
}

export const mockVault = {
  available() { return config.save.mode === 'demo' && Boolean(config.save.mockVault); },

  async previewDeposit(amountAtomic) {
    const out = await chainProvider().readContract({ address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'previewDeposit', args: [BigInt(amountAtomic)] });
    return out.toString();
  },
  async convertToAssets(sharesAtomic) {
    const out = await chainProvider().readContract({ address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'convertToAssets', args: [BigInt(sharesAtomic)] });
    return out.toString();
  },
  async sharesOf(account) {
    const out = await chainProvider().readContract({ address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'balanceOf', args: [getAddress(account)] });
    return out.toString();
  },
  async submitDeposit({ from, amount, validAfter, validBefore, nonce, v, r, s }) {
    return chainProvider().writeContract({
      address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'depositWithAuthorization',
      args: [getAddress(from), BigInt(amount), BigInt(validAfter), BigInt(validBefore), nonce, Number(v), r, s]
    });
  },
  async submitRedeem({ owner, shares, validAfter, validBefore, nonce, v, r, s }) {
    return chainProvider().writeContract({
      address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'redeemWithAuthorization',
      args: [getAddress(owner), BigInt(shares), BigInt(validAfter), BigInt(validBefore), nonce, Number(v), r, s]
    });
  }
};
