import { createHash } from 'node:crypto';

// Demo Aurora client for AURORA_MODE=demo. Same interface as auroraApiClient, but it makes no network
// calls and issues no real routes: it returns the real source-chain token catalog so the picker works,
// a deterministic per-user demo deposit address (display only), and an inert status (the service
// tracks demo delivery in its own store and credits real testnet USDC via simulateInboundDeposit).
const DEMO_TOKENS = [
  // Destination-side Monad USDC — every receive route resolves against this. Without it,
  // resolveAsset('monad', 'USDC') fails closed and createDepositAddress throws 503 for every call.
  // Verbatim copy of mockAuroraClient.js DEFAULT_TOKENS' Monad USDC entry.
  { assetId: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx', decimals: 6, blockchain: 'monad', symbol: 'USDC', price: 0.9998, contractAddress: '0x754704bc059f8c67012fed69bc8a327a5aafb603' },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 0.9998 },
  { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', decimals: 6, blockchain: 'arb', symbol: 'USDC', price: 0.9998 },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDC', price: 0.9998 },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', price: 0.9998 }
];

function demoAddress(...parts) {
  return `0x${createHash('sha256').update(['prism-demo-aurora', ...parts].join('|')).digest('hex').slice(0, 40)}`;
}

export function makeDemoAuroraClient() {
  return {
    name: 'aurora-demo',
    available() { return true; },
    async listTokens() { return DEMO_TOKENS; },
    async persistentAddress({ recipient, depositChain, destinationChain, destinationAsset }) {
      return {
        depositAddress: demoAddress(recipient, depositChain, destinationChain, destinationAsset),
        memo: null, correlationId: null, alreadyExists: false
      };
    },
    async status() { return { status: null }; }, // demo delivery is tracked by the service, not here
    async quote() { return null; },
    async submitDeposit() { return null; }
  };
}
