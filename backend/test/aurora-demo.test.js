import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A } from './helpers.js';

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

// Regression: DEMO_TOKENS previously carried only source-chain USDC entries (base/arb/eth/sol) with
// no Monad entry. AuroraService.createDepositAddress always resolves USDC on the destination chain
// (Monad) via resolveAsset(), and the demo client's listTokens() returns a non-null array — so the
// pinned MONAD_USDC_FALLBACK never kicks in — meaning resolveAsset('monad', 'USDC') failed and every
// createDepositAddress call threw a 503, even in demo mode. This exercises that exact path end to end.
test('demo mode: createDepositAddress resolves Monad USDC and returns an address (regression)', async () => {
  process.env.AURORA_MODE = 'demo';
  try {
    const { config } = await import(`../src/config.js?regression=${Math.random()}`);
    const { JsonStore } = await import('../src/lib/jsonStore.js');
    const { IdentityService } = await import('../src/services/identityService.js');
    const { AuroraService } = await import('../src/services/auroraService.js');
    const { setAuroraClient, resetAuroraClient } = await import('../src/aurora/index.js');
    const { makeDemoAuroraClient } = await import('../src/aurora/demoAuroraClient.js');

    assert.equal(config.aurora.mode, 'demo');
    setAuroraClient(makeDemoAuroraClient());
    try {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-aurora-demo-')), 'store.json');
      const store = new JsonStore(file);
      const identityService = new IdentityService({ store, config });
      const auroraService = new AuroraService({ store, config, identityService });
      const alice = meraAccount(PK_A);
      store.mutate((d) => {
        d.identities.alice = { prismId: 'alice', account: alice.address, accountAddress: alice.address, aliasVersion: 1 };
      });

      const created = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
      assert.ok(created.depositAddress, 'demo receive flow must produce a deposit address, not throw 503');
      assert.equal(created.destinationChain, 'monad');
      assert.equal(created.destinationSymbol, 'USDC');
    } finally {
      resetAuroraClient();
    }
  } finally {
    delete process.env.AURORA_MODE;
  }
});
