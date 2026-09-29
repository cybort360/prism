import { createConfig, http } from 'wagmi';
import { base, arbitrum, mainnet } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

// The chains a payer can pay from. Aurora routes any of these into USDC on Monad. WalletConnect is
// only wired when a project id is configured; injected (MetaMask etc.) always works.
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

// Source chains a payer can pay from. Limited to those the backend's Aurora catalog can route USDC
// from (base/arb/eth) — Optimism's `op` USDC isn't in the demo catalog, so advertising it would 400
// the quote. Re-add it here AND to the backend demo token list together if the catalog gains it.
export const wagmiConfig = createConfig({
  chains: [base, arbitrum, mainnet],
  connectors: [
    injected(),
    ...(projectId ? [walletConnect({ projectId })] : [])
  ],
  transports: {
    [base.id]: http(),
    [arbitrum.id]: http(),
    [mainnet.id]: http()
  }
});

// Aurora chain slugs keyed by wagmi chain id — the source chain the backend quote expects. These MUST
// match the backend's CHAINS keys in src/aurora/assets.js (eth/arb/base), NOT the long chain names.
export const CHAIN_SLUG: Record<number, string> = {
  [base.id]: 'base',
  [arbitrum.id]: 'arb',
  [mainnet.id]: 'eth'
};
