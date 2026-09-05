import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';
import { withIdempotency } from '../src/lib/idempotency.js';
import { OtpService } from '../src/services/otpService.js';

function tmpStore() {
  const p = path.join(os.tmpdir(), `prism-p0-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  return new JsonStore(p);
}

// F-05 — the audit REPRODUCED two producer executions for one idempotency key under concurrency.
test('F-05: concurrent calls with one Idempotency-Key execute the producer exactly once', async () => {
  const store = tmpStore();
  let executions = 0;
  const producer = async () => { executions += 1; await new Promise(r => setTimeout(r, 60)); return { ok: executions }; };
  const opts = { scope: 'claim-fund', actor: 'sender-1', key: 'same-key' };

  const [a, b] = await Promise.all([
    withIdempotency(store, opts, producer),
    withIdempotency(store, opts, producer)
  ]);

  assert.equal(executions, 1, 'producer must run exactly once under concurrency');
  assert.deepEqual(a, b, 'both concurrent callers receive the same response');
});

test('F-05: a different request body under a taken in-progress key is not a second execution', async () => {
  const store = tmpStore();
  let executions = 0;
  const slow = async () => { executions += 1; await new Promise(r => setTimeout(r, 80)); return { n: executions }; };
  const opts = { scope: 'pay', actor: 'a', key: 'k1' };
  const first = withIdempotency(store, opts, slow);
  await new Promise(r => setTimeout(r, 10));            // let the first reserve the slot
  const second = await withIdempotency(store, opts, slow);
  await first;
  assert.equal(executions, 1);
  assert.deepEqual(second, { n: 1 }, 'the joiner replays the winner response');
});

// F-04 — dev OTP must never be usable in production.
test('F-04: the dev OTP path is refused when NODE_ENV=production', async () => {
  const store = tmpStore();
  const otp = new OtpService({
    config: { nodeEnv: 'production', otpProvider: 'dev', devOtpCode: '123456', resolverPepper: 'x'.repeat(40), twilio: {} },
    store
  });
  await assert.rejects(() => otp.check('+2348100000000', '123456', 'test'), /disabled in production/);
  await assert.rejects(() => otp.start('+2348100000000', 'test'), /disabled in production/);
});

test('F-04: a production config without Twilio fails assertSafeConfig', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'production',
    SESSION_SECRET: 's'.repeat(40),
    RESOLVER_PEPPER: 'p'.repeat(40),
    DATA_ENCRYPTION_KEY: 'a'.repeat(64),
    SERVICE_KEY_ENCRYPTION_KEY: 'b'.repeat(64),
    RELAYER_PRIVATE_KEY: '0x' + '1'.repeat(64),
    PRISM_PAYMENT_ROUTER: '0x' + '2'.repeat(40),
    PRISM_CLAIM_VAULT: '0x' + '3'.repeat(40),
    CLAIM_AUTHORIZER_PRIVATE_KEY: '0x' + '4'.repeat(64)
  });
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_VERIFY_SERVICE_SID;
  delete process.env.OTP_PROVIDER;
  try {
    const { assertSafeConfig } = await import('../src/config.js?f04check');
    assert.throws(() => assertSafeConfig(), /OTP_PROVIDER/, 'prod boot must reject a non-twilio OTP provider');
  } finally {
    process.env = saved;
  }
});
