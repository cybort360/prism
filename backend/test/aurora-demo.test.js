import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A } from './helpers.js';
import { JsonStore } from '../src/lib/jsonStore.js';
import { setChainProvider, resetChainProvider } from '../src/providers/index.js';
function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-aurora-')), 'store.json')); }

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

test('simulateInboundDeposit credits the caller and delivers the deposit', async (t) => {
  const { AuroraService } = await import('../src/services/auroraService.js');
  const store = tmpStore();
  const account = '0x00000000000000000000000000000000000000A1';
  const addr = '0x00000000000000000000000000000000000000de';
  store.mutate((d) => { d.auroraDeposits = { [addr.toLowerCase()]: { depositAddress: addr, prismId: 'p1', recipientAccount: account, depositChain: 'base', state: 'awaiting_deposit', history: [], createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() } }; });
  const config = { aurora: { mode: 'demo', destinationChain: 'monad' }, chain: { usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3' } };
  const identityService = { get: () => ({ prismId: 'p1', accountAddress: account }) };
  let minted = null;
  // mintUsdcTo (backend/src/chain/eth.js) goes through the shared chainProvider() registry, not the
  // service's injected `chain` — so the mint itself is mocked via setChainProvider; the injected
  // `chain` still backs the post-mint getTransactionReceipt call.
  setChainProvider({ writeContract: async (args) => { minted = args; return '0xmint'; } });
  t.after(resetChainProvider);
  const chain = { getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }) };
  const svc = new AuroraService({ store, config, identityService, paymentService: null, chain });
  const res = await svc.simulateInboundDeposit({ prismId: 'p1', depositAddress: addr, sourceChain: 'base', amountAtomic: '50000000' });
  assert.equal(res.txHash, '0xmint');
  assert.equal(res.deposit.state, 'delivered');
  assert.equal(minted.functionName, 'mint');
  assert.deepEqual(minted.args.map(String), [account, '50000000']);
});

test('simulateInboundDeposit rejects a non-owned address', async () => {
  const { AuroraService } = await import('../src/services/auroraService.js');
  const store = tmpStore();
  const addr = '0x00000000000000000000000000000000000000de';
  store.mutate((d) => { d.auroraDeposits = { [addr.toLowerCase()]: { depositAddress: addr, prismId: 'other', recipientAccount: '0x0', state: 'awaiting_deposit', history: [] } }; });
  const config = { aurora: { mode: 'demo' }, chain: { usdc: '0x0' } };
  const svc = new AuroraService({ store, config, identityService: { get: () => ({ prismId: 'p1', accountAddress: '0x0' }) }, paymentService: null, chain: {} });
  await assert.rejects(() => svc.simulateInboundDeposit({ prismId: 'p1', depositAddress: addr, sourceChain: 'base', amountAtomic: '1' }), /belongs to another|not found/i);
});
