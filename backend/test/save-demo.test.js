import test from 'node:test';
import assert from 'node:assert/strict';

test('config: SAVE_MODE defaults to preview, demo flag derived', async () => {
  delete process.env.SAVE_MODE;
  const { config } = await import(`../src/config.js?cfg=${Math.random()}`);
  assert.equal(config.save.mode, 'preview');
  assert.equal(config.save.demo, false);
});

test('demo route provider: executable quote with real shares + signable authorization', async () => {
  const { DemoVaultSaveRouteProvider } = await import('../src/lib/demoSaveProviders.js');
  const fakeVault = { available: () => true, previewDeposit: async () => '100000000' };
  const cfg = { save: { mode: 'demo', mockVault: '0x000000000000000000000000000000000000dEaD', maxSlippageBps: 50, substrateChainId: 10143, inputToken: '0x0000000000000000000000000000000000000001' } };
  const provider = new DemoVaultSaveRouteProvider(cfg, fakeVault);
  const q = await provider.quoteSaveRoute({ account: '0x00000000000000000000000000000000000000A1', amountAtomic: '100000000' });
  assert.equal(q.demo, true);
  assert.equal(q.live, false);
  assert.equal(q.estimatedShares, '100000000');
  assert.equal(q.minimumShares, '99500000'); // 100000000 - 0.50%
  assert.ok(q.authorization?.types?.ReceiveWithAuthorization, 'has signable ERC-3009 typed data');
  assert.ok(/^0x[0-9a-fA-F]{64}$/.test(q.nonce));
});
