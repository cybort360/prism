/**
 * In-memory Envio indexer for tests. Substitutable via `setEnvioIndexer(makeMockEnvioIndexer())`.
 * Lets tests seed indexed payments/claims and assert the Envio consumer path is exercised.
 */
export function makeMockEnvioIndexer(seed = {}) {
  const payments = new Map(Object.entries(seed.payments ?? {}));
  const activity = seed.activity ?? {};
  const claims = seed.claims ?? {};
  const requests = new Map(Object.entries(seed.requests ?? {}));
  const incoming = seed.incoming ?? {};
  const calls = { getPayment: 0, isPaymentIndexed: 0, getAccountActivity: 0, getClaims: 0, getRequestSettlement: 0, getIncomingTransfers: 0 };

  return {
    name: 'mock-envio',
    calls,
    available() { return true; },
    indexPayment(payment) { payments.set(payment.id, payment); },
    async getPayment(id) { calls.getPayment++; return payments.get(id) ?? null; },
    async isPaymentIndexed(id) { calls.isPaymentIndexed++; return payments.has(id); },
    async getAccountActivity(account) { calls.getAccountActivity++; return activity[account.toLowerCase()] ?? []; },
    async getClaims(account) { calls.getClaims++; return claims[account.toLowerCase()] ?? []; },
    async getIncomingTransfers(account) { calls.getIncomingTransfers++; return incoming[account.toLowerCase()] ?? []; },
    async getRequestSettlement(id) { calls.getRequestSettlement++; return requests.get(id) ?? null; }
  };
}
