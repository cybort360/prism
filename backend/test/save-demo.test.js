import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const { JsonStore } = await import('../src/lib/jsonStore.js');

function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-save-demo-')), 'store.json')); }

function demoDeps() {
  const store = tmpStore();
  // chain.chainId (the deployment/MockVault chain) MUST differ from save.substrateChainId (the mainnet
  // preview substrate) so the redeem-domain tests prove the fix uses the DEPLOYMENT chain id, not 143.
  const config = { chain: { chainId: 10143 }, save: { enabled: true, mode: 'demo', demo: true, mockVault: '0x000000000000000000000000000000000000dEaD', maxSlippageBps: 50, substrateChainId: 143, inputToken: '0x0000000000000000000000000000000000000001', maxSaveAtomic: '10000000000' } };
  const identityService = { get: () => ({ prismId: 'prism_x', accountAddress: '0x00000000000000000000000000000000000000A1' }) };
  return { store, config, identityService };
}

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

test('saveService.state reports demo + persists quote', async () => {
  const { SaveService } = await import('../src/services/saveService.js');
  const { DemoVaultSaveRouteProvider } = await import('../src/lib/demoSaveProviders.js');
  const fakeVault = { available: () => true, previewDeposit: async () => '100000000' };
  const { store, config, identityService } = demoDeps();
  const svc = new SaveService({ store, config, identityService, routeProvider: new DemoVaultSaveRouteProvider(config, fakeVault) });
  const state = svc.state('prism_x');
  assert.equal(state.demo, true);
  const q = await svc.quote({ prismId: 'prism_x', amountAtomic: '100000000' });
  assert.equal(q.demo, true);
  assert.ok(store.read().saveQuotes[q.quoteId], 'quote persisted for submit');
});

test('demo executor: submit deposit verifies quote, submits, records SAVED op', async () => {
  const { DemoSaveExecutor } = await import('../src/services/demoSaveExecutor.js');
  const { store, config, identityService } = demoDeps();
  const account = '0x00000000000000000000000000000000000000A1';
  // Seed a quote as saveService.quote would.
  store.mutate((d) => { d.saveQuotes = { q1: { quoteId: 'q1', kind: 'SAVE', prismId: 'prism_x', account, amountAtomic: '100000000', vault: config.save.mockVault, nonce: '0x' + '11'.repeat(32), deadline: Math.floor(Date.now()/1000)+300, minimumShares: '99500000', estimatedShares: '100000000' } }; });
  const fakeVault = { available: () => true, submitDeposit: async () => '0xhash', sharesOf: async () => '100000000' };
  const fakeChain = { getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }) };
  // signature verification is stubbed to pass for this unit test:
  const exec = new DemoSaveExecutor({ store, config, identityService, vault: fakeVault, chain: fakeChain, verify: async () => true });
  const res = await exec.submitDeposit({ prismId: 'prism_x', quoteId: 'q1', signature: '0x' + 'ab'.repeat(65) });
  assert.equal(res.txHash, '0xhash');
  assert.equal(res.state, 'SAVED');
  const op = store.read().saveOperations[res.operationId];
  assert.equal(op.kind, 'SAVE');
  assert.equal(op.transactionHash, '0xhash');
  assert.equal(op.inputUSDC, '100000000');
});

test('redeem typed data matches the contract domain + type', async () => {
  const { redeemAuthorizationTypedData } = await import('../src/lib/redeemAuthorization.js');
  const td = redeemAuthorizationTypedData({ owner: '0x00000000000000000000000000000000000000A1', shares: '100000000', validAfter: 0, validBefore: 999, nonce: '0x' + '22'.repeat(32), vault: '0x000000000000000000000000000000000000dEaD', chainId: 10143 });
  assert.equal(td.domain.name, 'Prism Save Demo Vault');
  assert.equal(td.domain.version, '1');
  assert.equal(td.primaryType, 'RedeemWithAuthorization');
  assert.deepEqual(td.types.RedeemWithAuthorization.map(f => f.name), ['owner','shares','validAfter','validBefore','nonce']);
});

test('demo executor: submit withdraw records AVAILABLE op with USDC out', async () => {
  const { DemoSaveExecutor } = await import('../src/services/demoSaveExecutor.js');
  const { store, config, identityService } = demoDeps();
  const account = '0x00000000000000000000000000000000000000A1';
  store.mutate((d) => { d.saveQuotes = { w1: { quoteId: 'w1', kind: 'WITHDRAW_INSTANT', prismId: 'prism_x', account, sharesAtomic: '100000000', vault: config.save.mockVault, nonce: '0x' + '33'.repeat(32), deadline: Math.floor(Date.now()/1000)+300, estimatedUSDC: '110000000' } }; });
  const fakeVault = { available: () => true, submitRedeem: async () => '0xwd', convertToAssets: async () => '110000000' };
  const fakeChain = { getTransactionReceipt: async () => ({ status: 'success', blockNumber: 2n }) };
  const exec = new DemoSaveExecutor({ store, config, identityService, vault: fakeVault, chain: fakeChain, verify: async () => true });
  const res = await exec.submitWithdraw({ prismId: 'prism_x', quoteId: 'w1', signature: '0x' + 'cd'.repeat(65) });
  assert.equal(res.txHash, '0xwd');
  assert.equal(res.state, 'AVAILABLE');
  const op = store.read().saveOperations[res.operationId];
  assert.equal(op.kind, 'WITHDRAW_INSTANT');
  assert.equal(op.outputUSDC, '110000000');
});

test('FIX #1: redeem domain uses the DEPLOYMENT chain id, not substrateChainId', async () => {
  const { DemoSaveExecutor } = await import('../src/services/demoSaveExecutor.js');
  const { store, config, identityService } = demoDeps();
  // Prove the two differ so the assertion is meaningful.
  assert.equal(config.chain.chainId, 10143);
  assert.equal(config.save.substrateChainId, 143);
  const account = '0x00000000000000000000000000000000000000A1';
  store.mutate((d) => { d.saveQuotes = { w1: { quoteId: 'w1', kind: 'WITHDRAW_INSTANT', prismId: 'prism_x', account, sharesAtomic: '100000000', vault: config.save.mockVault, nonce: '0x' + '33'.repeat(32), deadline: Math.floor(Date.now()/1000)+300, estimatedUSDC: '110000000' } }; });
  const fakeVault = { available: () => true, submitRedeem: async () => '0xwd', convertToAssets: async () => '110000000' };
  const fakeChain = { getTransactionReceipt: async () => ({ status: 'success', blockNumber: 2n }) };
  // Capture the typed data the executor derives to verify the signature — its domain proves the chain id.
  let capturedChainId = null;
  const verify = async (typed) => { capturedChainId = typed.domain.chainId; return true; };
  const exec = new DemoSaveExecutor({ store, config, identityService, vault: fakeVault, chain: fakeChain, verify });
  await exec.submitWithdraw({ prismId: 'prism_x', quoteId: 'w1', signature: '0x' + 'cd'.repeat(65) });
  assert.equal(capturedChainId, 10143, 'redeem domain.chainId must be the deployment chain id');
  assert.notEqual(capturedChainId, 143, 'must NOT be the mainnet substrateChainId');
});

test('FIX #2: unmined receipt (always null) → op stays CONFIRMING, no fake success', async () => {
  const { DemoSaveExecutor } = await import('../src/services/demoSaveExecutor.js');
  const { store, config, identityService } = demoDeps();
  const account = '0x00000000000000000000000000000000000000A1';
  store.mutate((d) => { d.saveQuotes = { q1: { quoteId: 'q1', kind: 'SAVE', prismId: 'prism_x', account, amountAtomic: '100000000', vault: config.save.mockVault, nonce: '0x' + '11'.repeat(32), deadline: Math.floor(Date.now()/1000)+300, minimumShares: '99500000', estimatedShares: '100000000' } }; });
  let sharesRead = false;
  const fakeVault = { available: () => true, submitDeposit: async () => '0xhash', sharesOf: async () => { sharesRead = true; return '100000000'; } };
  const fakeChain = { getTransactionReceipt: async () => null }; // never mines
  const exec = new DemoSaveExecutor({ store, config, identityService, vault: fakeVault, chain: fakeChain, verify: async () => true, receiptPoll: { tries: 2, delayMs: 1 } });
  const res = await exec.submitDeposit({ prismId: 'prism_x', quoteId: 'q1', signature: '0x' + 'ab'.repeat(65) });
  assert.equal(res.state, 'CONFIRMING');
  const op = store.read().saveOperations[res.operationId];
  assert.equal(op.state, 'CONFIRMING');
  assert.equal(op.sharesReceived, null, 'no share readback before confirmation');
  assert.equal(sharesRead, false, 'must not read shares off an unmined tx');
});

test('FIX #2: reverted receipt → op FAILED, never reports success', async () => {
  const { DemoSaveExecutor } = await import('../src/services/demoSaveExecutor.js');
  const { store, config, identityService } = demoDeps();
  const account = '0x00000000000000000000000000000000000000A1';
  store.mutate((d) => { d.saveQuotes = { w1: { quoteId: 'w1', kind: 'WITHDRAW_INSTANT', prismId: 'prism_x', account, sharesAtomic: '100000000', vault: config.save.mockVault, nonce: '0x' + '33'.repeat(32), deadline: Math.floor(Date.now()/1000)+300, estimatedUSDC: '110000000' } }; });
  const fakeVault = { available: () => true, submitRedeem: async () => '0xwd', convertToAssets: async () => '110000000' };
  const fakeChain = { getTransactionReceipt: async () => ({ status: 'reverted', blockNumber: 9n }) };
  const exec = new DemoSaveExecutor({ store, config, identityService, vault: fakeVault, chain: fakeChain, verify: async () => true });
  const res = await exec.submitWithdraw({ prismId: 'prism_x', quoteId: 'w1', signature: '0x' + 'cd'.repeat(65) });
  assert.equal(res.state, 'FAILED');
  const op = store.read().saveOperations[res.operationId];
  assert.equal(op.state, 'FAILED');
  assert.equal(op.outputUSDC, null, 'no USDC out claimed on a reverted redeem');
  assert.ok(op.failureReason, 'records a failure reason');
});
