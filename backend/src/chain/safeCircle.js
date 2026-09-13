/**
 * The live wiring for SafeCircleAdapter: Prism's production chain provider, plus an optional Safe
 * Transaction Service client.
 *
 * The adapter is deliberately constructed lazily. A deployment that never creates a Circle should
 * never need `RELAYER_PRIVATE_KEY` resolved at import time, and tests that inject their own adapter
 * should never touch a chain client at all.
 */
import { config } from '../config.js';
import { chainProvider } from '../providers/index.js';
import { SafeCircleAdapter } from '../circles/safeCircleAdapter.js';
import { logger } from '../lib/logger.js';

/** The RPC seam the adapter uses. Everything routes through Prism's existing chain provider. */
const chainOps = {
  getChainId: () => chainProvider().getChainId(),
  readContract: (args) => chainProvider().readContract(args),
  writeContract: (args) => chainProvider().writeContract(args),
  getReceipt: (hash) => chainProvider().getTransactionReceipt(hash)
};

/**
 * Safe Transaction Service client — shared proposal storage so a co-admin on another device can see
 * a pending approval. Correctness never depends on it: the adapter re-verifies every confirmation
 * it returns against the digest and the live owner set (see SafeCircleAdapter.getPendingTransactions).
 * When no base URL is configured, Circles runs proposal storage locally and loses only that sharing.
 */
function txServiceClient() {
  const base = config.circles.txServiceUrl;
  if (!base) return null;
  const url = (path) => `${base.replace(/\/$/, '')}${path}`;
  const call = async (path, init) => {
    const response = await fetch(url(path), { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!response.ok) throw new Error(`safe tx service ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  return {
    async propose({ safeAddress, tx, safeTxHash, proposerAddress, signature }) {
      return call(`/api/v1/safes/${safeAddress}/multisig-transactions/`, {
        method: 'POST',
        body: JSON.stringify({
          to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation,
          safeTxGas: tx.safeTxGas.toString(), baseGas: tx.baseGas.toString(), gasPrice: tx.gasPrice.toString(),
          gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.nonce.toString(),
          contractTransactionHash: safeTxHash, sender: proposerAddress, signature
        })
      });
    },
    async confirm({ safeTxHash, signature }) {
      return call(`/api/v1/multisig-transactions/${safeTxHash}/confirmations/`, {
        method: 'POST', body: JSON.stringify({ signature })
      });
    },
    async pending(safeAddress) {
      const body = await call(`/api/v1/safes/${safeAddress}/multisig-transactions/?executed=false&limit=50`);
      return (body?.results ?? []).map((r) => ({
        safeTxHash: r.safeTxHash,
        nonce: Number(r.nonce),
        // Passed through unverified on purpose — the adapter verifies each one cryptographically.
        confirmations: (r.confirmations ?? []).map((c) => ({ signature: c.signature }))
      }));
    }
  };
}

let _adapter = null;
export function safeCircleAdapter() {
  if (_adapter) return _adapter;
  const txService = txServiceClient();
  logger.info('circles.adapter.ready', {
    singleton: config.circles.safeSingleton,
    proxyFactory: config.circles.safeProxyFactory,
    txService: txService ? 'configured' : 'local-only'
  });
  _adapter = new SafeCircleAdapter({ config, chain: chainOps, txService });
  return _adapter;
}

/** Test seam: drop the memoized adapter so a different chain provider takes effect. */
export function resetSafeCircleAdapter() { _adapter = null; }
