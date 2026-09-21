// Prism Save — strategy registry (architected, not a yield-chaser) and eligibility gating.

import test from 'node:test';
import assert from 'node:assert/strict';

const { SaveStrategyRegistry, APPROVED_EARNAUSD_STRATEGY, compareStrategies } = await import('../src/lib/saveStrategy.js');
const { SaveEligibilityService, SaveEligibility, realSaveEnabled } = await import('../src/services/saveEligibilityService.js');

test('registry: only the approved earnAUSD strategy is enabled in V1', () => {
  const reg = new SaveStrategyRegistry();
  assert.equal(reg.active().strategyId, APPROVED_EARNAUSD_STRATEGY.strategyId);
  assert.deepEqual(reg.enabled().map((s) => s.strategyId), [APPROVED_EARNAUSD_STRATEGY.strategyId]);
  assert.equal(reg.shouldAutoMigrate(), false); // never auto-migrate funds in V1
});

test('registry: adding/enabling a strategy requires a governed principal, and arrives disabled', () => {
  const reg = new SaveStrategyRegistry({ governance: ['0xGOV'] });
  const candidate = { strategyId: 'future-x', name: 'Future', enabled: true };
  assert.throws(() => reg.add(candidate, { governedBy: '0xNOBODY' }), /governed/);
  const added = reg.add(candidate, { governedBy: '0xgov' });
  assert.equal(added.enabled, false); // ignores the caller's enabled:true — governance enables, not the payload
  assert.throws(() => reg.enable('future-x', { governedBy: '0xNOBODY' }), /governed/);
  reg.enable('future-x', { governedBy: '0xgov' });
  assert.equal(reg.strategies.get('future-x').enabled, true);
});

test('selection: a higher-APY but riskier strategy does NOT automatically win', () => {
  const highApyRisky = { netApy: 20, smartContractRisk: 9, liquidity: 1, withdrawalTime: 5, stablecoinRisk: 5 };
  const balanced = { netApy: 7, smartContractRisk: 1, liquidity: 8, withdrawalTime: 1, stablecoinRisk: 1 };
  assert.ok(compareStrategies(balanced, highApyRisky) > 0, 'balanced should be preferred over raw-APY chasing');
});

test('eligibility: with no provider wired, the service reports SERVICE_UNAVAILABLE (never a fabricated ELIGIBLE)', async () => {
  const svc = new SaveEligibilityService({ config: {} });
  assert.equal(svc.snapshot().status, SaveEligibility.SERVICE_UNAVAILABLE);
  assert.equal((await svc.check('alice')).status, SaveEligibility.SERVICE_UNAVAILABLE);
});

test('eligibility gate: real-money Save requires BOTH a verified substrate AND ELIGIBLE', () => {
  assert.equal(realSaveEnabled({ substrateVerified: true, eligibility: SaveEligibility.ELIGIBLE }), true);
  assert.equal(realSaveEnabled({ substrateVerified: true, eligibility: SaveEligibility.UNKNOWN }), false);
  assert.equal(realSaveEnabled({ substrateVerified: true, eligibility: SaveEligibility.SERVICE_UNAVAILABLE }), false);
  assert.equal(realSaveEnabled({ substrateVerified: false, eligibility: SaveEligibility.ELIGIBLE }), false);
});

test('eligibility: a provider that says INELIGIBLE is surfaced, not overridden', async () => {
  const provider = { available: () => true, check: async () => SaveEligibility.INELIGIBLE };
  const svc = new SaveEligibilityService({ config: {}, provider });
  assert.equal((await svc.check('alice')).status, SaveEligibility.INELIGIBLE);
  assert.equal(realSaveEnabled({ substrateVerified: true, eligibility: SaveEligibility.INELIGIBLE }), false);
});
