import test from 'node:test';
import assert from 'node:assert/strict';
import { config, assertCircleLimitsAreSafe, VULNERABLE_ALLOWANCE_MODULES } from '../src/config.js';

// Safe's Allowance Module v1.0.0 fixed a delegate-transfer replay vulnerability and is deployed on
// no chain; the only Allowance Module on Monad is the pre-fix v0.1.1. Prism Circles therefore ships
// threshold-only. These tests exist so that decision cannot be reversed by accident — a future
// change that flips the default, or that points Circles at the vulnerable module, fails here.
// See docs/CIRCLES_DEPENDENCY_AUDIT.md.

function withCircles(overrides, run) {
  const original = { ...config.circles };
  Object.assign(config.circles, overrides);
  try {
    return run();
  } finally {
    Object.assign(config.circles, original);
  }
}

test('Circle spending limits are disabled by default', () => {
  assert.equal(config.circles.limitsEnabled, false);
  assert.equal(config.circles.allowanceModule, '');
  assert.deepEqual(assertCircleLimitsAreSafe([]), []);
});

test('the Safe v1.4.1 addresses Circles uses are the codehash-verified Monad deployments', () => {
  assert.equal(config.circles.safeSingleton, '0x41675C099F32341bf84BFc5382aF534df5C7461a');
  assert.equal(config.circles.safeProxyFactory, '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67');
  assert.equal(config.circles.safeFallbackHandler, '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99');
});

test('enabling limits without naming an allowance module is refused', () => {
  withCircles({ limitsEnabled: true, allowanceModule: '' }, () => {
    const bad = assertCircleLimitsAreSafe([]);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /CIRCLE_ALLOWANCE_MODULE/);
  });
});

test('enabling limits against the vulnerable v0.1.1 module is refused', () => {
  withCircles(
    { limitsEnabled: true, allowanceModule: '0xAA46724893dedD72658219405185Fb0Fc91e091C' },
    () => {
      const bad = assertCircleLimitsAreSafe([]);
      assert.equal(bad.length, 1);
      assert.match(bad[0], /v0\.1\.1/);
      assert.match(bad[0], /threshold-only/);
    }
  );
});

test('the vulnerable-module check is case-insensitive', () => {
  withCircles(
    { limitsEnabled: true, allowanceModule: '0xaa46724893dedd72658219405185fb0fc91e091c' },
    () => assert.equal(assertCircleLimitsAreSafe([]).length, 1)
  );
  assert.ok(VULNERABLE_ALLOWANCE_MODULES.has('0xaa46724893dedd72658219405185fb0fc91e091c'));
});

test('a future verified module address is allowed through', () => {
  withCircles(
    { limitsEnabled: true, allowanceModule: '0x0000000000000000000000000000000000001337' },
    () => assert.deepEqual(assertCircleLimitsAreSafe([]), [])
  );
});
