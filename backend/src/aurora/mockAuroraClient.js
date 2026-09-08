import { createHash } from 'node:crypto';

/**
 * In-memory Aurora client for tests. Substitutable via `setAuroraClient(makeMockAuroraClient())`.
 *
 * Deposit addresses are derived deterministically from their inputs, mirroring the real API's
 * guarantee that the same (recipient, chain, asset) always yields the same persistent address. Tests
 * drive status by calling `setStatus(depositAddress, status)` — nothing advances on its own, so a
 * test that asserts a terminal state has to say so explicitly.
 */

const DEFAULT_TOKENS = [
  { assetId: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx', decimals: 6, blockchain: 'monad', symbol: 'USDC', price: 0.9998, priceUpdatedAt: '2026-09-08T12:13:00.547Z', contractAddress: '0x754704bc059f8c67012fed69bc8a327a5aafb603' },
  { assetId: 'nep245:v2_1.omni.hot.tg:143_11111111111111111111', decimals: 18, blockchain: 'monad', symbol: 'MON', price: 0.0253, priceUpdatedAt: '2026-09-08T12:13:00.547Z', contractAddress: null },
  { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', decimals: 6, blockchain: 'arb', symbol: 'USDC', price: 0.9998, priceUpdatedAt: '2026-09-08T12:13:00.547Z', contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 0.9998, priceUpdatedAt: '2026-09-08T12:13:00.547Z', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDC', price: 0.9998, priceUpdatedAt: '2026-09-08T12:13:00.547Z', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 2471.67, priceUpdatedAt: '2026-09-08T12:13:00.547Z', contractAddress: null },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', price: 0.9998, priceUpdatedAt: '2026-09-08T12:13:00.547Z', contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 78279, priceUpdatedAt: '2026-09-08T12:13:00.547Z', contractAddress: null }
];

function deterministicEvmAddress(...parts) {
  return `0x${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}

export function makeMockAuroraClient(seed = {}) {
  const tokens = seed.tokens ?? DEFAULT_TOKENS;
  const statuses = new Map();          // depositAddress -> status string
  const details = new Map();           // depositAddress -> extra swapDetails
  const persistent = new Map();        // key -> depositAddress
  const quotes = [];                   // every quote request the service made
  const deposits = [];                 // every submitDeposit call
  const addressRequests = [];          // every persistentAddress request body
  const calls = { listTokens: 0, quote: 0, status: 0, submitDeposit: 0, persistentAddress: 0 };
  let unavailable = seed.unavailable ?? false;
  let failNext = null;

  return {
    name: 'mock-aurora',
    calls,
    quotes,
    deposits,
    addressRequests,

    available() { return !unavailable; },
    setUnavailable(value) { unavailable = value; },
    /** Force the next call of `method` to fail the way the live client does: a null return. */
    failOnce(method) { failNext = method; },
    setStatus(depositAddress, status, extra = {}) {
      statuses.set(depositAddress.toLowerCase(), status);
      details.set(depositAddress.toLowerCase(), extra);
    },

    async listTokens() {
      calls.listTokens++;
      if (consume('listTokens')) return null;
      return tokens;
    },

    async quote(request) {
      calls.quote++;
      quotes.push(request);
      if (consume('quote')) return null;
      const depositAddress = request.dry ? null : deterministicEvmAddress('quote', request.originAsset, request.destinationAsset, request.recipient, request.amount);
      // Mirrors the real response shape: a signed envelope wrapping quoteRequest + quote.
      const amountOut = String(BigInt(request.amount ?? '0'));
      return {
        timestamp: new Date().toISOString(),
        signature: `mock-quote-signature-${createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 32)}`,
        correlationId: `mock-corr-${quotes.length}`,
        quoteRequest: request,
        quote: {
          depositAddress,
          depositMemo: null,
          amountIn: request.amount,
          amountInFormatted: request.amount,
          amountOut,
          amountOutFormatted: amountOut,
          minAmountOut: String((BigInt(amountOut) * 99n) / 100n),
          deadline: request.deadline ?? new Date(Date.now() + 180_000).toISOString(),
          timeWhenInactive: new Date(Date.now() + 180_000).toISOString(),
          timeEstimate: 45,
          refundFee: '0',
          withdrawFee: '0'
        }
      };
    },

    async status({ depositAddress }) {
      calls.status++;
      if (consume('status')) return null;
      const key = String(depositAddress).toLowerCase();
      if (!statuses.has(key)) return null;
      return { status: statuses.get(key), updatedAt: new Date().toISOString(), swapDetails: details.get(key) ?? {} };
    },

    async submitDeposit(args) {
      calls.submitDeposit++;
      deposits.push(args);
      if (consume('submitDeposit')) return null;
      return { ok: true };
    },

    async persistentAddress({ recipient, sender, depositChain, destinationChain, destinationAsset }) {
      calls.persistentAddress++;
      addressRequests.push({ recipient, sender, depositChain, destinationChain, destinationAsset });
      if (consume('persistentAddress')) return null;
      // The real API returns one address for all EVM chains, and is deterministic per input set.
      const key = [recipient.toLowerCase(), depositChain, destinationChain, destinationAsset].join('|');
      const alreadyExists = persistent.has(key);
      if (!alreadyExists) persistent.set(key, deterministicEvmAddress('persistent', key, sender ?? ''));
      return { depositAddress: persistent.get(key), alreadyExists, memo: null, correlationId: `mock-pda-${persistent.size}` };
    }
  };

  function consume(method) {
    if (failNext !== method) return false;
    failNext = null;
    return true;
  }
}
