import test from 'node:test';
import assert from 'node:assert/strict';

// The demo vault reads must survive Monad's public-RPC rate limiting (15/sec) and skip pointless
// zero-arg conversions. Configure a demo vault before importing anything that reads config.
process.env.SAVE_MODE = 'demo';
process.env.SAVE_MOCK_VAULT = '0x000000000000000000000000000000000000dEaD';

const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { mockVault } = await import('../src/chain/mockVault.js');

test('convertToAssets(0) short-circuits to "0" with no chain read', async (t) => {
  let calls = 0;
  setChainProvider({ readContract: async () => { calls += 1; return 123n; } });
  t.after(resetChainProvider);

  assert.equal(await mockVault.convertToAssets(0), '0');
  assert.equal(await mockVault.previewDeposit(0), '0');
  assert.equal(calls, 0, 'zero-arg conversions never hit the rate-limited RPC');
});

test('a rate-limited vault read is retried with backoff instead of failing the flow', async (t) => {
  let calls = 0;
  setChainProvider({
    readContract: async () => {
      calls += 1;
      if (calls < 3) throw new Error('requests limited to 15/sec'); // 429 twice, then succeed
      return 246000002n;
    }
  });
  t.after(resetChainProvider);

  const value = await mockVault.convertToAssets(215789475n);
  assert.equal(value, '246000002'); // the real value, recovered — not a thrown "couldn't load"
  assert.ok(calls >= 3, 'the read is retried past the transient rate-limit');
});

test('a vault read that keeps failing surfaces the error (never a fabricated number)', async (t) => {
  setChainProvider({ readContract: async () => { throw new Error('requests limited to 15/sec'); } });
  t.after(resetChainProvider);

  await assert.rejects(() => mockVault.convertToAssets(100n));
});
