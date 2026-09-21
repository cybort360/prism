import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { buildSaveProof } = await import('../src/lib/saveProof.js');
const { SavePositionService } = await import('../src/services/savePositionService.js');
const { ActivityService } = await import('../src/services/activityService.js');

const OWNER = '0xAbc0000000000000000000000000000000000001';
const SAVE = { substrateChainId: 143, earnAusdVault: config.save.earnAusdVault };
const POSITION = `save_${OWNER.toLowerCase()}`;

function op(over = {}) {
  return {
    operationId: 'so1', positionId: POSITION, kind: 'SAVE', state: 'SAVED',
    inputUSDC: '500000000', routeProvider: '0xkuru', quotedAUSD: '499000000', actualAUSD: '498500000',
    minimumAUSD: '495000000', sharesExpected: '493000000', sharesReceived: '492000000', minimumShares: '490000000',
    vaultSharePriceBefore: '1010000', transactionHash: '0xabc', blockNumber: '100', ...over
  };
}
const evidence = (over = {}) => ({ txStatus: 'success', transactionHash: '0xabc', usdcDebitedAtomic: '500000000', ausdConvertedAtomic: '498500000', sharesMintedAtomic: '492000000', sharesReceiver: OWNER, blockNumber: '100', ...over });
const statusOf = (p, name) => p.verification.find((v) => v.check === name).status;

test('proof: a real operation + evidence produces a complete, verified proof', () => {
  const p = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence() });
  assert.equal(p.operationId, 'so1');
  assert.equal(p.positionId, POSITION);
  assert.equal(p.inputAmount, '500000000');
  assert.equal(p.actualAUSD, '498500000');
  assert.equal(p.sharesActual, '492000000');
  assert.equal(statusOf(p, 'usdc_debit'), 'verified');
  assert.equal(statusOf(p, 'ausd_conversion'), 'verified');
  assert.equal(statusOf(p, 'earnausd_shares'), 'verified');
  assert.equal(statusOf(p, 'share_ownership'), 'verified');
  assert.equal(p.complete, true);
});

test('proof: quote differs from actual — both are shown, verification uses actual', () => {
  const p = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence({ ausdConvertedAtomic: '497000000', sharesMintedAtomic: '491000000' }) });
  assert.equal(p.quotedAUSD, '499000000');
  assert.equal(p.actualAUSD, '497000000');   // actual, not the quote
  assert.equal(statusOf(p, 'ausd_conversion'), 'verified'); // 497 >= min 495
});

test('proof: a wrong transaction hash breaks correlation and fails the proof', () => {
  const p = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence({ transactionHash: '0xdeadbeef' }) });
  assert.equal(p.txCorrelates, false);
  assert.equal(p.complete, false);
  assert.equal(statusOf(p, 'usdc_debit'), 'failed');
});

test('proof: shares minted to the wrong owner fail share_ownership', () => {
  const p = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence({ sharesReceiver: '0xdead000000000000000000000000000000000000' }) });
  assert.equal(statusOf(p, 'share_ownership'), 'failed');
  assert.equal(p.complete, false);
});

test('proof: below-minimum conversion or shares fails verification', () => {
  const belowAusd = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence({ ausdConvertedAtomic: '400000000' }) });
  assert.equal(statusOf(belowAusd, 'ausd_conversion'), 'failed');
  const belowShares = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence({ sharesMintedAtomic: '1' }) });
  assert.equal(statusOf(belowShares, 'earnausd_shares'), 'failed');
});

test('proof: NO evidence ⇒ nothing is marked verified (unavailable, not verified)', () => {
  const p = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: null });
  for (const name of ['usdc_debit', 'ausd_conversion', 'earnausd_shares', 'share_ownership']) {
    assert.equal(statusOf(p, name), 'unavailable', `${name} must not be verified without evidence`);
  }
  assert.equal(p.complete, false);
});

test('proof: independent readback — verified when the vault reads back, unavailable when the indexer is delayed', () => {
  const withReadback = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence(), stateReadback: { available: true, shares: '492000000', valueAtomic: '498500000' } });
  assert.equal(statusOf(withReadback, 'independent_readback'), 'verified');
  const delayed = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence(), stateReadback: null });
  assert.equal(statusOf(delayed, 'independent_readback'), 'unavailable');
  assert.equal(delayed.complete, true, 'a delayed indexer/readback does not un-verify evidence-backed facts');
});

test('proof: reconstructs identically from the stored operation after a restart', () => {
  const a = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence() });
  const b = buildSaveProof({ operation: op(), save: SAVE, ownerAccount: OWNER, evidence: evidence() });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// --- service + activity ---
function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-save-proof-')), 'store.json')); }
const identityStub = { get: () => ({ prismId: 'alice', accountAddress: OWNER }) };

test('service: saveProof returns the proof for the user\'s own op; unknown op 404s', async () => {
  const store = tmpStore();
  store.mutate((d) => { d.saveOperations = { so1: { ...op(), evidence: evidence() } }; });
  const svc = new SavePositionService({ store, config, identityService: identityStub });
  const p = await svc.saveProof('alice', 'so1');
  assert.equal(p.operationId, 'so1');
  assert.equal(statusOf(p, 'share_ownership'), 'verified');
  await assert.rejects(() => svc.saveProof('alice', 'nope'), /not found/);
});

test('activity: Save deposit and withdrawal appear as real rows (never daily yield rows)', () => {
  const store = tmpStore();
  store.mutate((d) => {
    d.saveOperations = {
      dep: { ...op(), operationId: 'dep', kind: 'SAVE', state: 'SAVED' },
      wd: { operationId: 'wd', positionId: POSITION, kind: 'WITHDRAW_STANDARD', state: 'QUEUED', outputUSDC: '200000000', submittedAt: new Date().toISOString() }
    };
  });
  const activity = new ActivityService({ store, identityService: identityStub });
  const rows = activity.list('alice');
  const dep = rows.find((r) => r.kind === 'save-deposit');
  const wd = rows.find((r) => r.kind === 'save-withdraw');
  assert.ok(dep && dep.direction === 'outgoing' && dep.memo === 'Saved' && dep.status === 'COMPLETED');
  assert.ok(wd && wd.direction === 'incoming' && wd.status === 'PENDING' && wd.memo === 'Withdrawal');
  // no daily yield rows: exactly the two operations project, nothing more from Save.
  assert.equal(rows.filter((r) => r.sourceType === 'save').length, 2);
});
