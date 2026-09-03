/**
 * Lightweight in-process observability. Records latency histograms and success/failure counters and
 * exposes P50 / P95 / failure-rate. No PII, key material, or signatures are ever recorded here —
 * only durations and opaque operation kinds.
 *
 * Tracked latencies (ms): payment_prepare_ms, signing_wait_ms, relay_submit_ms,
 * chain_confirmation_ms, envio_index_ms, end_to_end_payment_ms.
 */
const MAX_SAMPLES = 2000;
const histograms = new Map(); // name -> number[]
const counters = new Map(); // name -> { success, failure }

export function record(name, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const arr = histograms.get(name) ?? [];
  arr.push(ms);
  if (arr.length > MAX_SAMPLES) arr.shift();
  histograms.set(name, arr);
}

/** Start a timer; call the returned function to record the elapsed ms under `name`. */
export function startTimer(name) {
  const t = process.hrtime.bigint();
  return () => record(name, Number(process.hrtime.bigint() - t) / 1e6);
}

export function increment(name, ok) {
  const c = counters.get(name) ?? { success: 0, failure: 0 };
  if (ok) c.success++; else c.failure++;
  counters.set(name, c);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 100) / 100;
}

export function snapshot() {
  const latencies = {};
  for (const [name, arr] of histograms) {
    const sorted = [...arr].sort((a, b) => a - b);
    latencies[name] = { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
  }
  const operations = {};
  for (const [name, c] of counters) {
    const total = c.success + c.failure;
    operations[name] = { success: c.success, failure: c.failure, failureRate: total ? Math.round((c.failure / total) * 1000) / 1000 : 0 };
  }
  return { latencies, operations };
}

export function reset() { histograms.clear(); counters.clear(); }
