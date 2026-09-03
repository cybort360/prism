export function consumeRateLimit(store, key, { limit, windowMs }) {
  const now = Date.now();
  return store.mutate(data => {
    const current = data.rateLimits[key] ?? { start: now, count: 0 };
    if (now - current.start >= windowMs) { current.start = now; current.count = 0; }
    current.count += 1;
    data.rateLimits[key] = current;
    if (current.count > limit) {
      const err = new Error('rate limit exceeded');
      err.statusCode = 429;
      throw err;
    }
    return { remaining: Math.max(0, limit - current.count), resetAt: current.start + windowMs };
  });
}
