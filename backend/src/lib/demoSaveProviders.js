import { getAddress } from 'viem';
import { receiveAuthorizationTypedData } from '../chain/eth.js';
import { randomHex } from './crypto.js';

const QUOTE_WINDOW_SECONDS = 300;

// Drop-in demo implementations behind SaveService's routeProvider seam and SavePositionService's
// vaultReader seam. They run the real MockVault on testnet: real previewDeposit shares, a real
// signable ERC-3009 authorization the user signs, and real on-chain position reads. Honest about
// being demo (demo:true, live:false); invents no APY.

export class DemoVaultSaveRouteProvider {
  constructor(config, vault) { this.config = config; this.vault = vault; }
  get name() { return 'demo-vault'; }

  async quoteSaveRoute({ account, amountAtomic }) {
    const s = this.config.save;
    const vault = getAddress(s.mockVault);
    const owner = getAddress(account);
    const shares = await this.vault.previewDeposit(String(amountAtomic));
    const minShares = (BigInt(shares) - (BigInt(shares) * BigInt(s.maxSlippageBps)) / 10000n).toString();
    const nonce = randomHex(32); // 0x + 64 hex
    const deadline = Math.floor(Date.now() / 1000) + QUOTE_WINDOW_SECONDS;

    // The user signs an ERC-3009 ReceiveWithAuthorization to the vault; the relayer submits
    // depositWithAuthorization. This is the exact money-moving authorization — one signature, one tx.
    const authorization = receiveAuthorizationTypedData({
      from: owner, to: vault, value: String(amountAtomic), validAfter: 0, validBefore: deadline, nonce
    });

    return {
      quoteId: `save_${randomHex(16).slice(2)}`,
      provider: this.name,
      demo: true,
      live: false,
      notLiveReason: 'Demo — simulated yield on testnet, not real earnAUSD',
      expiresAt: new Date(deadline * 1000).toISOString(),
      inputAsset: 'USDC',
      inputAmount: String(amountAtomic),
      vault,
      estimatedShares: String(shares),
      minimumShares: minShares,
      networkFeeSponsored: true,
      rate: { available: false, apyBps: null, reason: 'Demo — realized yield shows in your position value' },
      nonce,
      deadline,
      authorization,
      review: {
        youSaveAtomic: String(amountAtomic),
        estimatedInvestedAtomic: String(amountAtomic),
        estimatedInvestedIllustrative: false,
        conversionCostAtomic: '0',
        conversionCostBps: 0,
        minimumInvestedAtomic: String(amountAtomic),
        apy: { available: false, apyBps: null },
        expiresInSeconds: QUOTE_WINDOW_SECONDS,
        demo: true,
        live: false
      }
    };
  }
}

export class DemoVaultReader {
  constructor(config, vault) { this.config = config; this.vault = vault; }
  available() { return this.vault.available(); }
  async sharesOf(account) { return this.vault.sharesOf(account); }
  async convertToAssets(sharesAtomic) { return this.vault.convertToAssets(sharesAtomic); }
  async apy() { return null; } // no invented APY in demo; realized yield derives from value − principal
}
