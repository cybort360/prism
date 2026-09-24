import test from 'node:test';
import assert from 'node:assert/strict';

test('config: AURORA_MODE defaults to preview; demo flag derived', async () => {
  delete process.env.AURORA_MODE;
  const { config } = await import(`../src/config.js?a=${Math.random()}`);
  assert.equal(config.aurora.mode, 'preview');
  assert.equal(config.aurora.demo, false);
});

test('DemoAuroraClient: available, deterministic address, token catalog', async () => {
  const { makeDemoAuroraClient } = await import('../src/aurora/demoAuroraClient.js');
  const c = makeDemoAuroraClient();
  assert.equal(c.available(), true);
  const tokens = await c.listTokens();
  assert.ok(Array.isArray(tokens) && tokens.length > 0);
  const recipient = '0x00000000000000000000000000000000000000A1';
  const a1 = await c.persistentAddress({ recipient, depositChain: 'base', destinationChain: 'monad', destinationAsset: 'x' });
  const a2 = await c.persistentAddress({ recipient, depositChain: 'base', destinationChain: 'monad', destinationAsset: 'x' });
  assert.match(a1.depositAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(a1.depositAddress, a2.depositAddress); // deterministic
});
