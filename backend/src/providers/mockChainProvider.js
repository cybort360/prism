/**
 * In-memory ChainProvider for tests. Substitutable via `setChainProvider(makeMockChainProvider())`.
 * Records calls so tests can assert the Alchemy provider path is exercised, and lets tests script
 * receipts to simulate live confirmation / delay.
 */
export function makeMockChainProvider(overrides = {}) {
  const calls = { readContract: 0, simulateContract: 0, estimateContractGas: 0, writeContract: 0, getTransactionReceipt: 0, getChainId: 0, getBalance: 0 };
  const receipts = new Map(); // txHash -> receipt (or undefined to simulate "not yet mined")
  let nextTx = 0;

  const provider = {
    name: 'mock',
    chainId: overrides.chainId ?? 10143,
    rpcHost: 'mock',
    calls,
    receipts,
    setReceipt(hash, receipt) { receipts.set(hash, receipt); },

    async getChainId() { calls.getChainId++; return provider.chainId; },
    async readContract(args) { calls.readContract++; return overrides.readContract ? overrides.readContract(args) : 0n; },
    async getBalance() { calls.getBalance++; return overrides.balance ?? 0n; },
    async getCode(address) { return overrides.getCode ? overrides.getCode(address) : '0x'; },
    async simulateContract(args) { calls.simulateContract++; return { request: { ...args } }; },
    async estimateContractGas() { calls.estimateContractGas++; return 120000n; },
    async writeContract() {
      calls.writeContract++;
      const hash = `0x${(++nextTx).toString(16).padStart(64, '0')}`;
      if (!receipts.has(hash)) receipts.set(hash, { status: 'success', transactionHash: hash, blockNumber: 1n });
      return hash;
    },
    async getTransactionReceipt(hash) { calls.getTransactionReceipt++; return receipts.has(hash) ? receipts.get(hash) : null; }
  };
  return provider;
}
