import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { reconstructPosition, buildSaveOperation, SavePositionStatus } = await import('../src/domain/savePosition.js');
const { SavePositionService } = await import('../src/services/savePositionService.js');

const ACCOUNT = '0xAbc0000000000000000000000000000000000001';
const nowIso = () => new Date().toISOString();
const saveOp = (actualAUSD, sharesReceived, inputUSDC = actualAUSD) => ({
  kind: 'SAVE', state: 'SAVED', inputUSDC: String(inputUSDC), actualAUSD: String(actualAUSD),
  sharesReceived: String(sharesReceived), createdAt: nowIso()
});

test('domain: zero shares ⇒ no active position (NONE)', () => {
  const p = reconstructPosition({ prismIdentityId: 'alice', ownerAccount: ACCOUNT, chain: { available: true, shares: '0', currentAUSDValue: '0' }, operations: [] });
  assert.equal(p.status, SavePositionStatus.NONE);
  assert.equal(p.earnAUSDShares, '0');
});

test('domain: active position — earned = observed value − adjusted AUSD basis', () => {
  const p = reconstructPosition({
    prismIdentityId: 'alice', ownerAccount: ACCOUNT,
    chain: { available: true, shares: '99000000', currentAUSDValue: '105000000' },
    operations: [saveOp(99_000000, 99_000000, 100_000000)]  // 100 USDC → 99 AUSD basis
  });
  assert.equal(p.status, SavePositionStatus.ACTIVE);
  assert.equal(p.currentAUSDValue, '105000000');
  assert.equal(p.principalAUSD, '99000000');       // basis is AUSD deposited, not USDC
  assert.equal(p.unrealizedYieldAUSD, '6000000');
  assert.equal(p.earnedAUSD, '6000000');           // swap cost never shows as loss
});

test('domain: reinstall — position reconstructs from chain with NO local operations', () => {
  // Savings must prove from chain alone. Shares + value come back; earned is simply unavailable, not guessed.
  const p = reconstructPosition({
    prismIdentityId: 'alice', ownerAccount: ACCOUNT,
    chain: { available: true, shares: '99000000', currentAUSDValue: '105000000' }, operations: []
  });
  assert.equal(p.status, SavePositionStatus.ACTIVE);
  assert.equal(p.earnAUSDShares, '99000000');
  assert.equal(p.currentAUSDValue, '105000000');
  assert.equal(p.principalKnown, false);
  assert.equal(p.earnedAUSD, null);
  assert.equal(p.unrealizedYieldAUSD, null);
});

test('domain: chain unavailable ⇒ UNAVAILABLE, never a stale/guessed value', () => {
  const p = reconstructPosition({ prismIdentityId: 'alice', ownerAccount: ACCOUNT, chain: { available: false, shares: null, currentAUSDValue: null }, operations: [] });
  assert.equal(p.status, SavePositionStatus.UNAVAILABLE);
  assert.equal(p.currentAUSDValue, null);
});

test('domain: external incentives stay separate from earned/APY/balance', () => {
  const p = reconstructPosition({ prismIdentityId: 'alice', ownerAccount: ACCOUNT, chain: { available: true, shares: '1000000', currentAUSDValue: '1000000' }, operations: [saveOp(1_000000, 1_000000)] });
  assert.equal(p.externalIncentives.included, false);
  assert.match(p.externalIncentives.note, /merkl/i);
});

test('domain: estimated monthly earnings present only with a fresh APY', () => {
  const withApy = reconstructPosition({
    prismIdentityId: 'alice', ownerAccount: ACCOUNT, chain: { available: true, shares: '100000000', currentAUSDValue: '100000000' },
    operations: [saveOp(100_000000, 100_000000)], apyRecord: { apy: 0.0708, apySource: 'upshift', apyWindow: '30d', observedAt: nowIso() }
  });
  assert.equal(withApy.apy.available, true);
  assert.ok(Math.abs(Number(withApy.estimatedMonthlyEarningsAUSD) - 571700) < 3000);
  const noApy = reconstructPosition({ prismIdentityId: 'alice', ownerAccount: ACCOUNT, chain: { available: true, shares: '100000000', currentAUSDValue: '100000000' }, operations: [saveOp(100_000000, 100_000000)], apyRecord: null });
  assert.equal(noApy.apy.available, false);
  assert.equal(noApy.estimatedMonthlyEarningsAUSD, null);
});

// --- service: reads chain first, never serves a stale cached value ---
class MockReader {
  constructor(o) { this.o = o; }
  available() { return this.o.available; }
  async sharesOf() { return this.o.shares; }
  async convertToAssets() { return this.o.value; }
  async apy() { return this.o.apy ?? null; }
}
function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-savepos-')), 'store.json')); }
const identityStub = { get: () => ({ prismId: 'alice', accountAddress: ACCOUNT }) };

test('service: position is read from chain first, and refreshes (no stale cache)', async () => {
  const reader = new MockReader({ available: true, shares: '100000000', value: '100000000' });
  const svc = new SavePositionService({ store: tmpStore(), config, identityService: identityStub, vaultReader: reader });
  assert.equal((await svc.position('alice')).currentAUSDValue, '100000000');
  reader.o.value = '106000000';  // the vault appreciated
  assert.equal((await svc.position('alice')).currentAUSDValue, '106000000', 'served fresh, not stale');
  reader.o.available = false;     // vault read fails
  assert.equal((await svc.position('alice')).status, SavePositionStatus.UNAVAILABLE);
});

test('service: terminal operations in the store project onto the reconstructed position', async () => {
  const store = tmpStore();
  const positionId = `save_${ACCOUNT.toLowerCase()}`;
  const op = buildSaveOperation({ positionId, kind: 'SAVE', state: 'SAVED', inputUSDC: '100000000', actualAUSD: '99000000', sharesReceived: '99000000' });
  store.mutate((d) => { (d.saveOperations ||= {})[op.operationId] = op; });
  const svc = new SavePositionService({ store, config, identityService: identityStub, vaultReader: new MockReader({ available: true, shares: '99000000', value: '104000000' }) });
  const p = await svc.position('alice');
  assert.equal(p.principalAUSD, '99000000');
  assert.equal(p.earnedAUSD, '5000000');
});
