/**
 * Idempotency keys. A client may pass an `Idempotency-Key`; the first successful response for a
 * (scope, key, actor) triple is cached and replayed on retry, so a resubmit never double-broadcasts.
 */
export async function withIdempotency(store, { scope, key, actor }, producer) {
  if (!key) return producer();
  const cacheKey = `${scope}:${actor}:${key}`;
  const existing = store.read().idempotency?.[cacheKey];
  if (existing) return existing.response;
  const response = await producer();
  store.mutate((d) => {
    d.idempotency ??= {};
    d.idempotency[cacheKey] = { response, at: new Date().toISOString() };
  });
  return response;
}
