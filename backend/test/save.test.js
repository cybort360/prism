import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { SaveService, DevSaveRouteProvider } = await import('../src/services/saveService.js');
const { verifySaveExecutionPlan, SaveCallKind } = await import('../src/lib/saveRoute.js');

const ACCOUNT = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const USDC = config.save.substrateUsdc;
const AUSD = config.save.ausd;
const VAULT = config.save.earnAusdVault;
const ROUTER = '0xR0uter0000000000000000000000000000000001'.replace('R0uter', '1234ab');

function identityStub(account = ACCOUNT) { return { get: () => ({ accountAddress: account }) }; }
function svc(store) { return new SaveService({ store, config, identityService: identityStub() }); }
function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-save-')), 'store.json')); }

// A fully-formed, executable Save plan (what a REAL provider would return) — used to prove the verifier
// accepts a good plan and rejects each tampering. The dev provider deliberately does NOT produce this.
function validPlan(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    chainId: config.save.substrateChainId, account: ACCOUNT,
    input: { token: USDC, amount: '1000000' },
    intermediate: { token: AUSD, minAmount: '990000' },
    output: { vault: VAULT, receiver: ACCOUNT, minShares: '980000' },
    deadline: now + 300,
    calls: [
      { kind: SaveCallKind.USDC_APPROVE, target: USDC, spender: ROUTER, amount: '1000000', value: '0' },
      { kind: SaveCallKind.SWAP, target: ROUTER, value: '0' },
      { kind: SaveCallKind.AUSD_APPROVE, target: AUSD, spender: VAULT, amount: '990000', value: '0' },
      { kind: SaveCallKind.VAULT_DEPOSIT, target: VAULT, receiver: ACCOUNT, value: '0' }
    ],
    ...over
  };
}
const expected = () => ({
  chainId: config.save.substrateChainId, account: ACCOUNT, usdc: USDC, ausd: AUSD,
  earnAusdVault: VAULT, swapRouter: ROUTER, inputAmount: '1000000'
});

test('save: quote is money-safe and announces itself as a preview (no invented APY or position)', async () => {
  const q = await svc(tmpStore()).quote({ prismId: 'alice', amountAtomic: '1000000' });
  assert.equal(q.provider, 'dev-preview');
  assert.equal(q.live, false);
  assert.equal(q.substrateVerified, false);
  assert.ok(q.notLiveReason && /earnAUSD/i.test(q.notLiveReason));
  assert.equal(q.rate.available, false);
  assert.equal(q.rate.apyBps, null, 'never invents an APY');
  assert.equal(q.planExecutable, false, 'a preview plan is not executable');
  // every monetary field is an integer base-unit string, never a float/Number
  for (const v of [q.inputAmount, q.estimatedAUSD]) assert.match(String(v), /^[0-9]+$/);
  assert.equal(typeof q.inputAmount, 'string');
});

test('save: the quote carries a money-safe consumer review block', async () => {
  const q = await svc(tmpStore()).quote({ prismId: 'alice', amountAtomic: '500000000' });
  const r = q.review;
  assert.equal(r.youSaveAtomic, '500000000');
  assert.equal(r.estimatedInvestedAtomic, '500000000');
  assert.equal(r.estimatedInvestedIllustrative, true);
  assert.equal(r.conversionCostAtomic, '0');   // 1:1 preview, no invented cost
  assert.equal(r.conversionCostBps, 0);
  assert.equal(r.minimumInvestedAtomic, null);  // preview cannot guarantee a minimum
  assert.equal(r.apy.available, false);
  assert.equal(r.expiresInSeconds, 300);
  for (const v of [r.youSaveAtomic, r.estimatedInvestedAtomic, r.conversionCostAtomic]) assert.match(String(v), /^[0-9]+$/);
});

test('save: state is honest — not live, zero position, no rate', () => {
  const st = svc(tmpStore()).state('alice');
  assert.equal(st.live, false);
  assert.equal(st.position.shares, '0');
  assert.equal(st.position.valueAtomic, '0');
  assert.equal(st.rate.available, false);
});

test('save: amount validation fails closed', async () => {
  const s = svc(tmpStore());
  await assert.rejects(() => s.quote({ prismId: 'alice', amountAtomic: '0' }), /positive/);
  await assert.rejects(() => s.quote({ prismId: 'alice', amountAtomic: '1.5' }), /integer/);
  await assert.rejects(() => s.quote({ prismId: 'alice', amountAtomic: '99999999999' }), /limit/);
});

test('save: the plan verifier ACCEPTS a well-formed executable plan', () => {
  const r = verifySaveExecutionPlan(validPlan(), expected());
  assert.equal(r.ok, true, `unexpected violations: ${r.violations.join(', ')}`);
});

test('save: the plan verifier REJECTS every tampering (not a toy)', () => {
  const cases = {
    wrong_chain: validPlan({ chainId: 1 }),
    wrong_account: validPlan({ account: '0xdead000000000000000000000000000000000000' }),
    input_not_usdc: validPlan({ input: { token: AUSD, amount: '1000000' } }),
    input_amount_mismatch: validPlan({ input: { token: USDC, amount: '2000000' } }),
    intermediate_not_ausd: validPlan({ intermediate: { token: USDC, minAmount: '990000' } }),
    output_not_earnausd: validPlan({ output: { vault: '0xbeef000000000000000000000000000000000000', receiver: ACCOUNT, minShares: '980000' } }),
    output_receiver_not_user: validPlan({ output: { vault: VAULT, receiver: '0xbeef000000000000000000000000000000000000', minShares: '980000' } }),
    missing_min_shares: validPlan({ output: { vault: VAULT, receiver: ACCOUNT, minShares: '0' } }),
    past_deadline: validPlan({ deadline: 1 }),
  };
  for (const [name, plan] of Object.entries(cases)) {
    const r = verifySaveExecutionPlan(plan, expected());
    assert.equal(r.ok, false, `${name} should have been rejected`);
  }
  // unlimited approval
  const unlimited = validPlan();
  unlimited.calls[0].amount = (2n ** 256n - 1n).toString();
  assert.equal(verifySaveExecutionPlan(unlimited, expected()).ok, false);
  // native MON value on a call
  const native = validPlan();
  native.calls[3].value = '1';
  assert.equal(verifySaveExecutionPlan(native, expected()).ok, false);
  // arbitrary external call target
  const foreign = validPlan();
  foreign.calls[1].target = '0xc0ffee0000000000000000000000000000000000';
  assert.equal(verifySaveExecutionPlan(foreign, expected()).ok, false);
});

test('save: the dev preview plan is correctly NOT executable', () => {
  const q = new DevSaveRouteProvider(config).quoteSaveRoute({ account: ACCOUNT, amountAtomic: '1000000' });
  const r = verifySaveExecutionPlan(q.transactionPlan, {
    chainId: config.save.substrateChainId, account: ACCOUNT, usdc: config.save.substrateUsdc,
    ausd: AUSD, earnAusdVault: VAULT, swapRouter: config.save.swapRouter, inputAmount: '1000000'
  });
  assert.equal(r.ok, false, 'a preview plan must not verify as executable');
});

test('save: running quotes/state creates NO production or financial state', async () => {
  const store = tmpStore();
  const before = JSON.stringify(store.read());
  const s = svc(store);
  s.state('alice');
  await s.quote({ prismId: 'alice', amountAtomic: '5000000' });
  const after = store.read();
  assert.equal(JSON.stringify(after), before, 'Save wrote nothing to the store');
  assert.equal(Object.keys(after.operations ?? {}).length, 0);
  assert.equal(after.savePositions, undefined);
});
