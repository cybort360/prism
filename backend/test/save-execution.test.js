import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { saveIntentTypedData, verifySaveIntentSignature, validateSaveIntent, consumeSaveNonce } = await import('../src/lib/saveIntent.js');
const { validateExecutionQuote, reconcileSaveEvidence, SaveExecOutcome, isRetryable, PreviewSaveExecutor } = await import('../src/lib/saveExecution.js');
const { verifySaveExecutionPlan, SaveCallKind } = await import('../src/lib/saveRoute.js');
const { assembleSaveProof } = await import('../src/lib/saveProof.js');

const OWNER = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const VC = config.save.executor;
const b32 = (h) => `0x${h.repeat(32)}`;

function intent(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    owner: OWNER.address, inputToken: config.save.substrateUsdc, maxInputUSDC: '500000000',
    intermediateToken: config.save.ausd, vault: config.save.earnAusdVault, shareToken: config.save.earnAusdVault,
    minAUSDOut: '495000000', minSharesOut: '490000000', receiver: OWNER.address,
    quoteId: b32('11'), deadline: now + 300, nonce: b32('de'), chainId: config.save.substrateChainId, ...over
  };
}
const sign = (i) => OWNER.signTypedData(saveIntentTypedData(i, { verifyingContract: VC }));

test('intent: a valid signature verifies; changing ANY protected field invalidates it', async () => {
  const base = intent();
  const sig = await sign(base);
  assert.equal(await verifySaveIntentSignature(base, sig, { verifyingContract: VC }), true);

  const mutations = {
    maxInputUSDC: '999000000', vault: '0xdead000000000000000000000000000000000000',
    receiver: '0xdead000000000000000000000000000000000000', minSharesOut: '1',
    minAUSDOut: '1', chainId: 1, deadline: base.deadline + 5, quoteId: b32('22'),
    nonce: b32('ff'), inputToken: config.save.ausd, intermediateToken: config.save.substrateUsdc,
    shareToken: '0xbeef000000000000000000000000000000000000'
  };
  for (const [field, value] of Object.entries(mutations)) {
    const mutated = { ...base, [field]: value };
    assert.equal(await verifySaveIntentSignature(mutated, sig, { verifyingContract: VC }), false, `mutating ${field} must invalidate the signature`);
  }
});

test('intent: structural validation rejects non-owner receiver, foreign vault, raised amount, wrong chain, expired', () => {
  const ok = validateSaveIntent(intent(), { save: config.save, expectedOwner: OWNER.address, maxInputUSDC: '500000000' });
  assert.equal(ok.ok, true, ok.violations.join(','));
  const bad = (over, code) => {
    const r = validateSaveIntent(intent(over), { save: config.save, expectedOwner: OWNER.address, maxInputUSDC: '500000000' });
    assert.ok(r.violations.includes(code), `expected ${code}, got ${r.violations.join(',')}`);
  };
  bad({ receiver: '0xdead000000000000000000000000000000000000' }, 'receiver_not_owner');
  bad({ vault: '0xdead000000000000000000000000000000000000' }, 'vault_not_verified_earnausd');
  bad({ maxInputUSDC: '9000000000' }, 'input_amount_out_of_bounds');
  bad({ chainId: 1 }, 'wrong_chain');
  bad({ deadline: 1 }, 'expired_intent');
  bad({ minSharesOut: '0' }, 'missing_min_shares');
});

test('intent: a replayed authorization (same nonce) is rejected', () => {
  const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-save-nonce-')), 'store.json'));
  assert.equal(consumeSaveNonce(store, OWNER.address, b32('de')), true);
  assert.equal(consumeSaveNonce(store, OWNER.address, b32('de')), false, 'replay must be rejected');
});

test('quote gate: preview/expired/paused/capped/slippage/impact all block execution', () => {
  const policy = { maxSlippageBps: config.save.maxSlippageBps, maxPriceImpactBps: config.save.maxPriceImpactBps };
  const good = {
    live: true, planExecutable: true, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    minimumAUSD: '495000000', minimumShares: '490000000', slippageBps: 20, priceImpactBps: 30
  };
  assert.equal(validateExecutionQuote(good, { policy }).ok, true);
  const blocked = (over, code) => assert.ok(validateExecutionQuote({ ...good, ...over }, { policy }).blockers.includes(code));
  blocked({ live: false }, 'route_unavailable');
  blocked({ expiresAt: new Date(Date.now() - 1000).toISOString() }, 'quote_expired');
  blocked({ vaultPaused: true }, 'vault_paused');
  blocked({ vaultDepositCapReached: true }, 'vault_deposit_capped');
  blocked({ slippageBps: 5000 }, 'slippage_too_high');
  blocked({ priceImpactBps: 5000 }, 'price_impact_too_high');
  blocked({ minimumShares: '0' }, 'missing_min_shares');
});

test('reconcile: SAVED only on canonical evidence; failures/partials/ambiguity fail closed', () => {
  const i = intent();
  const saved = reconcileSaveEvidence({ txStatus: 'success', usdcDebitedAtomic: '500000000', ausdConvertedAtomic: '497000000', sharesMintedAtomic: '492000000', sharesReceiver: OWNER.address }, i);
  assert.equal(saved.outcome, SaveExecOutcome.SAVED);

  // router gives less than minAUSD, atomic route ⇒ tx reverts ⇒ FAILED
  assert.equal(reconcileSaveEvidence({ txStatus: 'failed' }, i).outcome, SaveExecOutcome.FAILED);
  // vault gives fewer than minShares (atomic revert) ⇒ FAILED
  assert.equal(reconcileSaveEvidence({ txStatus: 'failed', reasons: ['shares'] }, i).outcome, SaveExecOutcome.FAILED);
  // shares minted to the wrong receiver ⇒ FAILED
  assert.equal(reconcileSaveEvidence({ txStatus: 'success', usdcDebitedAtomic: '500000000', ausdConvertedAtomic: '497000000', sharesMintedAtomic: '492000000', sharesReceiver: '0xdead000000000000000000000000000000000000' }, i).outcome, SaveExecOutcome.FAILED);
  // partial (USDC+AUSD moved, shares not minted to user) ⇒ REQUIRES_RECONCILIATION, never hidden
  assert.equal(reconcileSaveEvidence({ txStatus: 'success', usdcDebitedAtomic: '500000000', ausdConvertedAtomic: '497000000', sharesMintedAtomic: '0', sharesReceiver: OWNER.address }, i).outcome, SaveExecOutcome.REQUIRES_RECONCILIATION);
  // unknown broadcast ⇒ REQUIRES_RECONCILIATION (never SAVED on acceptance)
  assert.equal(reconcileSaveEvidence({ txStatus: 'unknown' }, i).outcome, SaveExecOutcome.REQUIRES_RECONCILIATION);
});

test('ambiguous submission: a SUBMITTED/REQUIRES_RECONCILIATION op is NOT retryable', () => {
  assert.equal(isRetryable('SUBMITTED'), false);
  assert.equal(isRetryable('REQUIRES_RECONCILIATION'), false);
  assert.equal(isRetryable('FAILED'), true);
});

test('client plan guard: malicious route/approve targets are rejected', () => {
  const expected = { chainId: config.save.substrateChainId, account: OWNER.address, usdc: config.save.substrateUsdc, ausd: config.save.ausd, earnAusdVault: config.save.earnAusdVault, swapRouter: '0x1234ab0000000000000000000000000000000001', inputAmount: '1000000' };
  const malRoute = { chainId: expected.chainId, account: OWNER.address, input: { token: expected.usdc, amount: '1000000' }, intermediate: { token: expected.ausd, minAmount: '990000' }, output: { vault: expected.earnAusdVault, receiver: OWNER.address, minShares: '980000' }, deadline: Math.floor(Date.now() / 1000) + 300, calls: [{ kind: SaveCallKind.SWAP, target: '0xc0ffee0000000000000000000000000000000000', value: '0' }] };
  assert.equal(verifySaveExecutionPlan(malRoute, expected).ok, false);
  const malApprove = { ...malRoute, calls: [{ kind: SaveCallKind.USDC_APPROVE, target: expected.usdc, spender: '0xbad0000000000000000000000000000000000000', amount: '1000000', value: '0' }] };
  assert.ok(verifySaveExecutionPlan(malApprove, expected).violations.some((v) => v.includes('unknown_spender')));
});

test('executor: the preview executor announces itself and refuses (never a fake save)', async () => {
  await assert.rejects(() => new PreviewSaveExecutor(config).execute(), /not enabled|unverified/i);
});

test('proof: assembled only from observed evidence; complete only when the tx actually proves a Save', () => {
  const op = { owner: OWNER.address, inputUSDC: '500000000', routeProvider: '0x', quotedAUSD: '497000000', vaultSharePriceBefore: '1010000', transactionHash: '0xabc' };
  // No evidence yet ⇒ not complete; unobserved fields stay null (never fabricated).
  const pending = assembleSaveProof({ operation: op, usdcBefore: '900000000', evidence: null });
  assert.equal(pending.complete, false);
  assert.equal(pending.sharesReceived, null);
  assert.equal(pending.quotedAUSD, '497000000');
  assert.equal(pending.actualAUSD, null); // quoted is NOT actual — never claimed until observed
  assert.equal(pending.usdcBefore, '900000000');
  // Canonical success evidence ⇒ complete, and actual AUSD / shares come from the evidence.
  const done = assembleSaveProof({ operation: op, usdcBefore: '900000000', evidence: { txStatus: 'success', ausdConvertedAtomic: '498000000', sharesMintedAtomic: '492000000', blockNumber: '123' } });
  assert.equal(done.complete, true);
  assert.equal(done.actualAUSD, '498000000');
  assert.equal(done.sharesReceived, '492000000');
  assert.equal(done.blockNumber, '123');
  // Unknown/failed broadcast is never "complete", even with amounts present.
  assert.equal(assembleSaveProof({ operation: op, evidence: { txStatus: 'unknown', ausdConvertedAtomic: '498000000', sharesMintedAtomic: '492000000' } }).complete, false);
});
