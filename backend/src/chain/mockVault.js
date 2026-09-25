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

// A vault read with a few backoff retries. Monad's public RPC rate-limits (15 req/sec) and
// intermittently stalls; the Save screens fire a burst (position + state + withdrawals + quote), so a
// single 429 must not sink the whole flow ("Couldn't load withdrawal options"). Backoff also spreads
// the burst out under the limit. Reads are pure, so retrying is always safe.
async function readVault(functionName, args, { tries = 4, baseMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const out = await chainProvider().readContract({ address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName, args });
      return out.toString();
    } catch (err) {
      lastErr = err;
      if (attempt < tries - 1) await new Promise((r) => setTimeout(r, baseMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

export const mockVault = {
  available() { return config.save.mode === 'demo' && Boolean(config.save.mockVault); },

  async previewDeposit(amountAtomic) {
    if (BigInt(amountAtomic) === 0n) return '0'; // 0 in → 0 shares; never spend a rate-limited read on it
    return readVault('previewDeposit', [BigInt(amountAtomic)]);
  },
  async convertToAssets(sharesAtomic) {
    if (BigInt(sharesAtomic) === 0n) return '0'; // 0 shares are worth 0 assets — no chain call needed
    return readVault('convertToAssets', [BigInt(sharesAtomic)]);
  },
  async sharesOf(account) {
    return readVault('balanceOf', [getAddress(account)]);
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
