import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Alchemy webhook verification (Address Activity / Mined Transaction). Alchemy signs each webhook
 * with HMAC-SHA256 of the raw request body using the webhook's signing key, sent in the
 * `X-Alchemy-Signature` header.
 *
 * Security: verify the signature, reject malformed bodies, dedupe by webhook event id (replay
 * prevention + idempotency). A webhook is only a HINT to reconcile FAST — the backend always reads
 * the receipt back from the chain (via Alchemy RPC) before changing any state, so a forged or stale
 * webhook can never fabricate completion.
 */
export function verifyAlchemySignature(rawBody, signature) {
  const key = config.chain.alchemyWebhookSigningKey;
  if (!key || !signature) return false;
  const expected = crypto.createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extract candidate transaction hashes from an Alchemy webhook payload (defensive/malformed-safe). */
export function extractTxHashes(payload) {
  const hashes = new Set();
  const activity = payload?.event?.activity;
  if (Array.isArray(activity)) {
    for (const a of activity) if (typeof a?.hash === 'string') hashes.add(a.hash.toLowerCase());
  }
  const tx = payload?.event?.transaction?.hash;
  if (typeof tx === 'string') hashes.add(tx.toLowerCase());
  return [...hashes].filter((h) => /^0x[0-9a-f]{64}$/.test(h));
}
