import test from 'node:test';
import assert from 'node:assert/strict';

test('config: AURORA_MODE defaults to preview; demo flag derived', async () => {
  delete process.env.AURORA_MODE;
  const { config } = await import(`../src/config.js?a=${Math.random()}`);
  assert.equal(config.aurora.mode, 'preview');
  assert.equal(config.aurora.demo, false);
});
