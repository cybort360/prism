import { createConfig, http } from 'wagmi';
import { base, arbitrum, optimism, mainnet } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

// The chains a payer can pay from. Aurora routes any of these into USDC on Monad. WalletConnect is
// only wired when a project id is configured; injected (MetaMask etc.) always works.
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

export const wagmiConfig = createConfig({
  chains: [base, arbitrum, optimism, mainnet],
  connectors: [
    injected(),
    ...(projectId ? [walletConnect({ projectId })] : [])
  ],
  transports: {
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [mainnet.id]: http()
  }
});

// Aurora chain slugs keyed by wagmi chain id — the source chain the backend quote expects.
export const CHAIN_SLUG: Record<number, string> = {
  [base.id]: 'base',
  [arbitrum.id]: 'arbitrum',
  [optimism.id]: 'optimism',
  [mainnet.id]: 'ethereum'
};
