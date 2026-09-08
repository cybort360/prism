import { config } from '../config.js';

/**
 * Envio consumer. Queries the Envio HyperIndex GraphQL API for Prism's INDEXED, QUERYABLE history —
 * activity, receipts, claim history, sender/recipient history, and payment indexing state.
 *
 * Envio is NEVER canonical: the backend treats the chain (via Alchemy) as the source of financial
 * truth and only uses Envio for reconciled historical queries and to report indexing/finality state.
 * If Envio is unavailable or lagging, methods return null/empty and the app shows an indexing state
 * rather than fabricating completion.
 */
async function query(gql, variables) {
  if (!config.envio.graphqlUrl) return null;
  try {
    const res = await fetch(config.envio.graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: gql, variables })
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.errors ? null : body.data;
  } catch { return null; }
}

export const envioGraphqlIndexer = {
  name: 'envio',
  available() { return Boolean(config.envio.graphqlUrl); },

  async getPayment(paymentId) {
    const data = await query(
      `query($id: String!) { Payment(where: {id: {_eq: $id}}) { id payer recipient amount requestId resolutionHash txHash blockNumber timestamp } }`,
      { id: paymentId }
    );
    return data?.Payment?.[0] ?? null;
  },

  /** True once Envio has indexed the on-chain PaymentSettled for this payment. */
  async isPaymentIndexed(paymentId) {
    return Boolean(await this.getPayment(paymentId));
  },

  async getAccountActivity(account, limit = 50) {
    const data = await query(
      `query($acct: String!, $limit: Int!) { AccountActivity(where: {account: {_ilike: $acct}}, order_by: {timestamp: desc}, limit: $limit) { id account counterparty direction kind amount ref txHash timestamp } }`,
      { acct: account, limit }
    );
    return data?.AccountActivity ?? [];
  },

  async getClaims(account) {
    const data = await query(
      `query($acct: String!) { Claim(where: {_or: [{sender: {_ilike: $acct}}, {recipient: {_ilike: $acct}}]}, order_by: {fundedAt: desc}) { id status sender recipient amount expiry recipientReference fundedTx resolvedTx fundedAt resolvedAt } }`,
      { acct: account }
    );
    return data?.Claim ?? [];
  },

  /**
   * USDC transfers INTO an account. This is how an inbound cross-chain deposit becomes attributable:
   * Aurora delivers it as a plain token transfer to the user's Mera account, touching no Prism
   * contract, so there is no Prism event to key off. Excludes `from` so a user's own outbound
   * payments don't come back as incoming.
   */
  async getIncomingTransfers(account, limit = 50) {
    const data = await query(
      `query($acct: String!, $limit: Int!) { UsdcTransfer(where: {to: {_ilike: $acct}}, order_by: {timestamp: desc}, limit: $limit) { id from to value txHash blockNumber timestamp } }`,
      { acct: account, limit }
    );
    return data?.UsdcTransfer ?? [];
  },

  async getRequestSettlement(requestId) {
    const data = await query(
      `query($id: String!) { RequestSettlement(where: {id: {_eq: $id}}) { id paymentId payer recipient amount txHash timestamp } }`,
      { id: requestId }
    );
    return data?.RequestSettlement?.[0] ?? null;
  }
};
