/**
 * Idempotency keys for financial mutations. A client may pass an `Idempotency-Key`; the FIRST caller
 * for a (scope, actor, key) triple atomically reserves the slot and runs the producer, and any
 * concurrent or later caller with the same key joins that execution and replays its response — so a
 * mutation runs at most once even under concurrency.
 *
 * Correctness relies on `JsonStore.mutate` being synchronous: the reserve-if-absent check and write
 * happen inside one mutate with no `await` between them, so two overlapping callers cannot both win.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A reservation older than this with no result is treated as abandoned (crashed producer) so a
// retry can take it over instead of being locked out forever.
const STALE_MS = 60_000;

function isDone(entry) { return entry && Object.prototype.hasOwnProperty.call(entry, 'response'); }

export async function withIdempotency(store, { scope, key, actor, fingerprint = null }, producer) {
  if (!key) return producer();
  const cacheKey = `${scope}:${actor}:${key}`;

  // Same key + DIFFERENT request fingerprint is a client bug (a key reused for a different payment):
  // reject rather than replay someone else's result.
  const conflictError = () => { const e = new Error('this Idempotency-Key was already used for a different request'); e.statusCode = 409; return e; };

  let role = 'replay';
  let fingerprintMismatch = false;
  store.mutate((d) => {
    d.idempotency ??= {};
    const e = d.idempotency[cacheKey];
    const stale = e && !isDone(e) && e.state === 'in_progress' && Date.now() - Date.parse(e.at) > STALE_MS;
    if (e && !stale && fingerprint != null && e.fingerprint != null && e.fingerprint !== fingerprint) { fingerprintMismatch = true; return; }
    if (!e || stale) {
      d.idempotency[cacheKey] = { state: 'in_progress', at: new Date().toISOString(), fingerprint };
      role = 'winner';
    }
  });
  if (fingerprintMismatch) throw conflictError();

  if (role === 'winner') {
    try {
      const response = await producer();
      store.mutate((d) => { d.idempotency[cacheKey] = { state: 'succeeded', response, at: new Date().toISOString(), fingerprint }; });
      return response;
    } catch (err) {
      // Release the reservation so a genuine retry after a failure can proceed.
      store.mutate((d) => { if (d.idempotency?.[cacheKey] && !isDone(d.idempotency[cacheKey])) delete d.idempotency[cacheKey]; });
      throw err;
    }
  }

  // Replay: the slot was already taken. If it's finished, return its response; otherwise wait for the
  // in-progress winner to complete (join) so we never double-execute the mutation.
  for (let i = 0; i < 400; i++) {
    const e = store.read().idempotency?.[cacheKey];
    if (!e) break;                 // winner failed and released → fall through to a conflict below
    if (isDone(e)) return e.response;
    await sleep(25);
  }
  const e = store.read().idempotency?.[cacheKey];
  if (isDone(e)) return e.response;
  const err = new Error('a concurrent request with this Idempotency-Key is still in progress');
  err.statusCode = 409;
  throw err;
}
