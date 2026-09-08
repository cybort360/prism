import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Aurora Intents Deposits client (https://intents-api.aurora.dev).
 *
 * Aurora sits on top of NEAR Intents: you ask for a quote from an origin asset to a destination
 * asset, it hands back a deposit address, and a plain token transfer to that address is what starts
 * the route. Prism uses it in both directions — any chain -> USDC on Monad (receive), and USDC on
 * Monad -> any token on any chain (send/spend).
 *
 * Like the Envio consumer, this adapter is NEVER canonical and never fabricates. A failed call
 * returns null and the caller surfaces an unknown/indexing state rather than inventing a quote, an
 * address, or a delivery. `available()` is false without an appKey and every route 503s.
 *
 * The appKey is public by design (Aurora documents it as non-confidential and safe for client-side
 * use), but Prism still keeps it server-side: it carries the integrator fee configuration, and
 * leaking it into responses would let anyone bill routes against this integrator account.
 */

const TOKEN_CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;

let tokenCache = { at: 0, tokens: null };

/** Reset the token cache. Tests call this so a stubbed fetch is not shadowed by a warm cache. */
export function resetTokenCache() { tokenCache = { at: 0, tokens: null }; }

function url(path) {
  const base = config.aurora.apiBaseUrl.replace(/\/+$/, '');
  return `${base}${path.replace('{appKey}', encodeURIComponent(config.aurora.appKey))}`;
}

async function call(method, path, { body = null, query = null } = {}) {
  if (!config.aurora.appKey) return null;
  const target = new URL(url(path));
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) target.searchParams.set(k, String(v));

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method,
      signal: timeout,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      // Read the upstream message for diagnostics, but never echo it verbatim to a consumer: it can
      // contain the appKey path segment.
      const detail = await res.text().catch(() => '');
      logger.warn('aurora.http', { method, path, status: res.status, detail: detail.slice(0, 300) });
      return null;
    }
    return await res.json();
  } catch (error) {
    logger.warn('aurora.unreachable', { method, path, error: error.message });
    return null;
  }
}

export const auroraApiClient = {
  name: 'aurora',

  available() { return Boolean(config.aurora.appKey); },

  /**
   * Supported tokens across every chain Aurora routes, with live prices. Cached briefly — this list
   * backs the chain/asset pickers and every assetId lookup, so it is read on almost every call.
   */
  async listTokens({ force = false } = {}) {
    if (!force && tokenCache.tokens && Date.now() - tokenCache.at < TOKEN_CACHE_TTL_MS) return tokenCache.tokens;
    const body = await call('GET', '/api/tokens/{appKey}');
    // The endpoint has returned both a bare array and a { tokens, asset_stats } envelope; accept both.
    const tokens = Array.isArray(body) ? body : body?.tokens;
    if (!Array.isArray(tokens)) return tokenCache.tokens ?? null;
    tokenCache = { at: Date.now(), tokens };
    return tokens;
  },

  /** Quote a route. Returns Aurora's full signed quote envelope, or null. */
  async quote(request) {
    return call('POST', '/api/quote/{appKey}', { body: request });
  },

  /** Execution status for a deposit address issued by `quote` or `persistentAddress`. */
  async status({ depositAddress, depositMemo = null }) {
    return call('GET', '/api/status/{appKey}', { query: { depositAddress, depositMemo } });
  },

  /**
   * Tell Aurora which transaction funded a deposit address. Purely an accelerant — Aurora detects
   * the deposit on its own — so callers treat a null result as a non-event.
   */
  async submitDeposit({ txHash, depositAddress, memo = null }) {
    return call('POST', '/api/deposit/submit/{appKey}', { body: { txHash, depositAddress, memo } });
  },

  /**
   * A permanent, reusable deposit address for (recipient, depositChain, destinationChain,
   * destinationAsset). Deterministic: the same inputs always return the same address, with
   * `alreadyExists: true` on subsequent calls. All EVM chains share one address.
   */
  async persistentAddress({ recipient, sender, depositChain, destinationChain, destinationAsset }) {
    return call('POST', '/api/persistent-deposit-address/{appKey}', {
      body: { recipient, sender, depositChain, destinationChain, destinationAsset }
    });
  }
};
