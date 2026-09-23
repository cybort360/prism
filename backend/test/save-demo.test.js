import test from 'node:test';
import assert from 'node:assert/strict';

test('config: SAVE_MODE defaults to preview, demo flag derived', async () => {
  delete process.env.SAVE_MODE;
  const { config } = await import(`../src/config.js?cfg=${Math.random()}`);
  assert.equal(config.save.mode, 'preview');
  assert.equal(config.save.demo, false);
});
