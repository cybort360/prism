// backend/test/circle-withdrawal-math.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { netContributions, withdrawableFor, proRataPayouts } from '../src/circles/withdrawal.js';

const C = (prismId, amount, status = 'COMPLETED') => ({ contributorPrismId: prismId, amount: String(amount), status });
const W = (prismId, amount, status = 'COMPLETED') => ({ beneficiaryPrismId: prismId, amount: String(amount), status });

test('netContributions sums COMPLETED only, minus withdrawals, floored at 0', () => {
  const net = netContributions(
    [C('a', 100), C('a', 50), C('b', 30), C('a', 999, 'CONFIRMING')],
    [W('a', 40), W('b', 30), W('b', 5, 'PREPARED')]
  );
  assert.equal(net.get('a'), 110n); // 150 - 40; the CONFIRMING contribution ignored
  assert.equal(net.get('b'), 0n);   // 30 - 30; the PREPARED withdrawal ignored
});

test('withdrawableFor caps at the live balance', () => {
  const net = new Map([['a', 110n]]);
  assert.equal(withdrawableFor('a', net, 500n), 110n); // balance ample
  assert.equal(withdrawableFor('a', net, 40n), 40n);   // pool drained below net
  assert.equal(withdrawableFor('z', net, 40n), 0n);    // non-contributor
});

test('proRataPayouts sums exactly to the balance with largest-remainder', () => {
  // net 100/50/50 (total 200), balance 100 -> 50/25/25
  const p = proRataPayouts(new Map([['a', 100n], ['b', 50n], ['c', 50n]]), 100n);
  assert.equal(p.get('a'), 50n); assert.equal(p.get('b'), 25n); assert.equal(p.get('c'), 25n);
  assert.equal([...p.values()].reduce((s, v) => s + v, 0n), 100n);
});

test('proRataPayouts gives dust to the largest remainder deterministically', () => {
  // net 1/1/1 (total 3), balance 100 -> 34/33/33 (first by remainder, ties by prismId order)
  const p = proRataPayouts(new Map([['a', 1n], ['b', 1n], ['c', 1n]]), 100n);
  assert.equal([...p.values()].reduce((s, v) => s + v, 0n), 100n);
  assert.equal(p.get('a'), 34n); assert.equal(p.get('b'), 33n); assert.equal(p.get('c'), 33n);
});

test('proRataPayouts omits zero-net members and returns empty when total net is 0', () => {
  const p = proRataPayouts(new Map([['a', 0n], ['b', 10n]]), 10n);
  assert.equal(p.has('a'), false); assert.equal(p.get('b'), 10n);
  assert.equal(proRataPayouts(new Map([['a', 0n]]), 50n).size, 0);
});
