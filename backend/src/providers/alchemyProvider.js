import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';

/**
 * Alchemy is Prism's PRIMARY production Monad RPC provider. This module owns the viem clients that
 * back every chain read/write — eth_call, balance/token reads, transaction simulation, gas
 * estimation, transaction submission, and receipt queries — over the configured Alchemy Monad
 * endpoint (`MONAD_RPC_URL`, e.g. https://monad-{mainnet,testnet}.g.alchemy.com/v2/<key>).
 *
 * It implements the `ChainProvider` shape so tests can substitute a mock (see providers/index.js).
 * Alchemy provides REAL-TIME RPC, submission and live confirmation; Envio provides indexed history.
 * Neither is a competing canonical state — the chain is canonical, Alchemy reads it live, Envio
 * indexes it for queries.
 */

const chainId = Number(config.chain.chainId);

export const monad = defineChain({
  id: chainId,
  name: chainId === 143 ? 'Monad' : chainId === 10143 ? 'Monad Testnet' : `Monad ${chainId}`,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [config.chain.rpcUrl] } }
});

export const publicClient = createPublicClient({ chain: monad, transport: http(config.chain.rpcUrl) });

let _relayer = null;
export function relayerAccount() {
  if (_relayer) return _relayer;
  if (!config.chain.relayerPrivateKey) throw httpError(503, 'RELAYER_PRIVATE_KEY not configured');
  _relayer = privateKeyToAccount(normalizePk(config.chain.relayerPrivateKey));
  return _relayer;
}
export function relayerWallet() {
  return createWalletClient({ account: relayerAccount(), chain: monad, transport: http(config.chain.rpcUrl) });
}

function providerHost() {
  try { return new URL(config.chain.rpcUrl).host; } catch { return 'unknown'; }
}

/** The production Alchemy-backed ChainProvider. */
export const alchemyProvider = {
  name: 'alchemy',
  chainId,
  rpcHost: providerHost(),

  async getChainId() { return Number(await publicClient.getChainId()); },

  /** eth_call via a contract read. */
  async readContract(args) { return publicClient.readContract(args); },

  /** Native MON balance (used to prove a user can pay with MON = 0). */
  async getBalance(address) { return publicClient.getBalance({ address }); },

  /** Transaction simulation before submission — reverts surface here, not on-chain. */
  async simulateContract(args) {
    return publicClient.simulateContract({ ...args, account: args.account ?? relayerAccount() });
  },

  /** Gas estimation for the relayer. */
  async estimateContractGas(args) {
    return publicClient.estimateContractGas({ ...args, account: args.account ?? relayerAccount() });
  },

  /** Transaction submission (relayer pays MON). */
  async writeContract(request) { return relayerWallet().writeContract(request); },

  /** Receipt query for live confirmation. */
  async getTransactionReceipt(hash) {
    try { return (await publicClient.getTransactionReceipt({ hash })) ?? null; }
    catch { return null; }
  }
};

function normalizePk(pk) { return pk.startsWith('0x') ? pk : `0x${pk}`; }
function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
