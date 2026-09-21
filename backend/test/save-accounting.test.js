import test from 'node:test';
import assert from 'node:assert/strict';

const {
  reduceCostBasis, unrealizedYieldAUSD, totalEarnedAUSD, resolveApy, effectiveMonthlyRate, estimatedMonthlyEarningsAtomic
} = await import('../src/lib/saveAccounting.js');
const { canTransition, isTerminal, consumerPhase, timestampField } = await import('../src/lib/saveLifecycle.js');

const save = (actualAUSD, sharesReceived, inputUSDC = actualAUSD) => ({ kind: 'SAVE', inputUSDC: String(inputUSDC), actualAUSD: String(actualAUSD), sharesReceived: String(sharesReceived) });
const withdraw = (sharesRedeemed, outputAUSD) => ({ kind: 'WITHDRAW_INSTANT', sharesRedeemed: String(sharesRedeemed), outputAUSD: String(outputAUSD) });
const isIntString = (v) => typeof v === 'string' && /^-?\d+$/.test(v);

test('accounting: multiple deposits accumulate AUSD basis + shares', () => {
  const r = reduceCostBasis([save(99_000000, 99_000000), save(50_000000, 49_500000)]);
  assert.equal(r.principalAUSD, '149000000');
  assert.equal(r.shares, '148500000');
  assert.equal(r.realizedYieldAUSD, '0');
});

test('accounting: swap cost is an entry cost, NOT negative yield', () => {
  // 100 USDC deposited → 99 AUSD received (1 USDC swap cost). Basis starts from the 99 AUSD, not 100 USDC.
  const r = reduceCostBasis([save(99_000000, 99_000000, 100_000000)]);
  assert.equal(r.principalAUSD, '99000000', 'cost basis is actual AUSD deposited');
  // value unchanged at 99 AUSD ⇒ earned 0, never −1 USDC of "yield loss".
  assert.equal(totalEarnedAUSD({ realizedYieldAUSD: '0', currentAUSDValue: '99000000', principalAUSD: r.principalAUSD }), '0');
});

test('accounting: share appreciation ⇒ positive unrealized; depreciation ⇒ negative', () => {
  assert.equal(unrealizedYieldAUSD('105000000', '99000000'), '6000000');
  assert.equal(unrealizedYieldAUSD('97000000', '100000000'), '-3000000');
});

test('accounting: partial withdrawal removes proportional basis and realizes yield', () => {
  // basis 100 / shares 100; redeem 40 shares for 44 AUSD → basisRemoved 40, realized 4, remaining 60/60.
  const r = reduceCostBasis([save(100_000000, 100_000000), withdraw(40_000000, 44_000000)]);
  assert.equal(r.principalAUSD, '60000000');
  assert.equal(r.shares, '60000000');
  assert.equal(r.realizedYieldAUSD, '4000000');
});

test('accounting: full withdrawal clears basis and shares, realizing all yield', () => {
  const r = reduceCostBasis([save(100_000000, 100_000000), withdraw(100_000000, 108_000000)]);
  assert.equal(r.principalAUSD, '0');
  assert.equal(r.shares, '0');
  assert.equal(r.realizedYieldAUSD, '8000000');
});

test('accounting: APY fresh vs stale vs missing (never stale-as-current, never fabricated)', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const fresh = resolveApy({ apy: 0.0708, apySource: 'upshift', apyWindow: '30d', observedAt: '2026-01-01T00:00:00Z' }, { now, maxAgeMs: 30 * 60_000 });
  assert.equal(fresh.available, true); assert.equal(fresh.apy, 0.0708);
  const stale = resolveApy({ apy: 0.0708, observedAt: '2025-12-31T22:00:00Z' }, { now, maxAgeMs: 30 * 60_000 });
  assert.equal(stale.available, false); assert.equal(stale.reason, 'rate_stale');
  assert.equal(resolveApy(null, { now }).available, false);
});

test('accounting: APY changes are reflected (no hardcoded rate)', () => {
  const now = Date.now();
  assert.equal(resolveApy({ apy: 0.06, observedAt: new Date(now).toISOString() }, { now }).apy, 0.06);
  assert.equal(resolveApy({ apy: 0.085, observedAt: new Date(now).toISOString() }, { now }).apy, 0.085);
});

test('accounting: estimated monthly earnings use the effective monthly rate, labeled estimate', () => {
  const monthly = effectiveMonthlyRate(0.0708);
  assert.ok(Math.abs(monthly - (Math.pow(1.0708, 1 / 12) - 1)) < 1e-12);
  const now = Date.now();
  const apy = resolveApy({ apy: 0.0708, observedAt: new Date(now).toISOString() }, { now });
  const est = estimatedMonthlyEarningsAtomic('100000000', apy); // 100 AUSD
  assert.ok(isIntString(est));
  assert.ok(Math.abs(Number(est) - 571700) < 3000, `estimate ~0.5717 AUSD, got ${est}`);
  // Unavailable APY ⇒ no estimate (never a promised number).
  assert.equal(estimatedMonthlyEarningsAtomic('100000000', { available: false }), null);
});

test('accounting: all monetary outputs are integer base-unit strings (no float)', () => {
  const r = reduceCostBasis([save(99_000001, 99_000001), withdraw(33_000000, 34_000000)]);
  for (const v of [r.principalAUSD, r.shares, r.realizedYieldAUSD]) assert.ok(isIntString(v), `${v} is not an int string`);
  assert.ok(isIntString(unrealizedYieldAUSD('1', '2')));
});

test('lifecycle: deposit machine only allows real transitions; SAVED is terminal; FAILED always reachable', () => {
  assert.equal(canTransition('SAVE', 'CREATED', 'QUOTING'), true);
  assert.equal(canTransition('SAVE', 'AUTHORIZED', 'SUBMITTED'), true);
  assert.equal(canTransition('SAVE', 'CREATED', 'SAVED'), false, 'no skipping');
  assert.equal(canTransition('SAVE', 'SUBMITTED', 'FAILED'), true);
  assert.equal(isTerminal('SAVE', 'SAVED'), true);
  assert.equal(canTransition('SAVE', 'SAVED', 'RECONCILING'), false);
});

test('lifecycle: consumer phases hide the substrate vocabulary', () => {
  assert.equal(consumerPhase('SAVE', 'SWAPPING').label, 'Saving…');
  assert.equal(consumerPhase('SAVE', 'DEPOSITING').label, 'Saving…');
  assert.equal(consumerPhase('SAVE', 'AUTHORIZED').label, 'Preparing…');
  assert.equal(consumerPhase('SAVE', 'SAVED').label, 'Saved');
  assert.equal(consumerPhase('WITHDRAW_INSTANT', 'REDEEMING').label, 'Withdrawing…');
  assert.equal(consumerPhase('WITHDRAW_INSTANT', 'AVAILABLE').label, 'Available');
  assert.equal(consumerPhase('WITHDRAW_STANDARD', 'WITHDRAWAL_REQUESTED').label, 'Withdrawal requested');
  assert.equal(consumerPhase('WITHDRAW_STANDARD', 'CLAIMABLE').label, 'Ready');
  assert.equal(consumerPhase('WITHDRAW_STANDARD', 'CLAIMING').label, 'Processing');
});

test('lifecycle: semantic proof steps carry NO fabricated observed timestamp', () => {
  assert.equal(timestampField('SWAPPING'), null);
  assert.equal(timestampField('DEPOSITING'), null);
  assert.equal(timestampField('RECONCILING'), null);
  assert.equal(timestampField('CONFIRMED'), 'confirmedAt');
  assert.equal(timestampField('SAVED'), 'completedAt');
  assert.equal(timestampField('CREATED'), 'createdAt');
});
