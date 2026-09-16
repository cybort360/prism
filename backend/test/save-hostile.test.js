// Prism Save — hostile tests SAVE-001..018. Each adversarial scenario is bound to the REAL verifier that
// must refuse it. Nothing here trusts acceptance, a quote, or a bundler: refusal comes from signature
// recovery, the allowlist plan verifier, execution-policy gates, or reconciliation over canonical evidence.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { saveIntentTypedData, verifySaveIntentSignature, validateSaveIntent, consumeSaveNonce } = await import('../src/lib/saveIntent.js');
const { validateExecutionQuote, reconcileSaveEvidence, SaveExecOutcome, isRetryable } = await import('../src/lib/saveExecution.js');
const { verifySaveExecutionPlan, SaveCallKind } = await import('../src/lib/saveRoute.js');
const { reconcileWithdrawEvidence, WithdrawOutcome, classifyClaimable, withdrawFailureAction, withdrawModes } = await import('../src/lib/saveWithdraw.js');
const { resolveApy } = await import('../src/lib/saveAccounting.js');
const { reconstructPosition, SavePositionStatus } = await import('../src/domain/savePosition.js');

const OWNER = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const ATTACKER = '0xdead000000000000000000000000000000000000';
const VC = config.save.executor;
const b32 = (h) => `0x${h.repeat(32)}`;

// A substrate the plan verifier can allowlist against (real config leaves swapRouter unset).
const SUB = {
  chainId: config.save.substrateChainId, account: OWNER.address,
  usdc: config.save.substrateUsdc, ausd: config.save.ausd, earnAusdVault: config.save.earnAusdVault,
  swapRouter: '0x1111111111111111111111111111111111111111'
};

function validPlan(over = {}) {
  const deadline = Math.floor(Date.now() / 1000) + 300;
  return {
    chainId: SUB.chainId, account: SUB.account,
    input: { token: SUB.usdc, amount: '1000000' },
    intermediate: { token: SUB.ausd, minAmount: '995000' },
    output: { vault: SUB.earnAusdVault, receiver: SUB.account, minShares: '990000' },
    deadline,
    calls: [
      { kind: SaveCallKind.USDC_APPROVE, target: SUB.usdc, spender: SUB.swapRouter, amount: '1000000', value: '0' },
      { kind: SaveCallKind.SWAP, target: SUB.swapRouter, value: '0' },
      { kind: SaveCallKind.AUSD_APPROVE, target: SUB.ausd, spender: SUB.earnAusdVault, amount: '995000', value: '0' },
      { kind: SaveCallKind.VAULT_DEPOSIT, target: SUB.earnAusdVault, receiver: SUB.account, value: '0' }
    ],
    ...over
  };
}
const expected = { ...SUB, inputAmount: '1000000' };

function intent(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    owner: OWNER.address, inputToken: config.save.substrateUsdc, maxInputUSDC: '1000000',
    intermediateToken: config.save.ausd, vault: config.save.earnAusdVault, shareToken: config.save.earnAusdVault,
    minAUSDOut: '995000', minSharesOut: '990000', receiver: OWNER.address,
    quoteId: b32('11'), deadline: now + 300, nonce: b32('de'), chainId: config.save.substrateChainId, ...over
  };
}
const sign = (i) => OWNER.signTypedData(saveIntentTypedData(i, { verifyingContract: VC }));
const tmpStore = () => new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-hostile-')), 'store.json'));

// Sanity: the honest plan clears the verifier, so the refusals below are about the tampering, not noise.
test('SAVE-000 baseline: an honest plan and intent verify', async () => {
  assert.equal(verifySaveExecutionPlan(validPlan(), expected).ok, true);
  const i = intent(); assert.equal(await verifySaveIntentSignature(i, await sign(i), { verifyingContract: VC }), true);
});

test('SAVE-001 vault swapped for an attacker vault → refuse', () => {
  const r = verifySaveExecutionPlan(validPlan({ output: { vault: ATTACKER, receiver: SUB.account, minShares: '990000' } }), expected);
  assert.equal(r.ok, false);
  assert.ok(r.violations.includes('output_not_earnausd'));
});

test('SAVE-002 amount changed after authorization → signature refuses', async () => {
  const base = intent(); const sig = await sign(base);
  assert.equal(await verifySaveIntentSignature({ ...base, maxInputUSDC: '999000000' }, sig, { verifyingContract: VC }), false);
  // And the plan verifier refuses a plan whose input amount no longer matches what was agreed.
  assert.equal(verifySaveExecutionPlan(validPlan({ input: { token: SUB.usdc, amount: '999000000' } }), expected).ok, false);
});

test('SAVE-003 receiver changed → refuse (signature + structural + plan)', async () => {
  const base = intent(); const sig = await sign(base);
  assert.equal(await verifySaveIntentSignature({ ...base, receiver: ATTACKER }, sig, { verifyingContract: VC }), false);
  const v = validateSaveIntent({ ...base, receiver: ATTACKER }, { save: config.save, expectedOwner: OWNER.address, maxInputUSDC: '1000000' });
  assert.ok(v.violations.includes('receiver_not_owner'));
  assert.equal(verifySaveExecutionPlan(validPlan({ output: { vault: SUB.earnAusdVault, receiver: ATTACKER, minShares: '990000' } }), expected).ok, false);
});

test('SAVE-004 malicious approval target → refuse', () => {
  const r = verifySaveExecutionPlan(validPlan({
    calls: [{ kind: SaveCallKind.USDC_APPROVE, target: SUB.usdc, spender: ATTACKER, amount: '1000000', value: '0' }]
  }), expected);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((x) => x.endsWith('approve_unknown_spender')));
  // A call to an entirely non-allowlisted contract is refused too.
  const r2 = verifySaveExecutionPlan(validPlan({ calls: [{ kind: SaveCallKind.SWAP, target: ATTACKER, value: '0' }] }), expected);
  assert.ok(r2.violations.some((x) => x.endsWith('target_not_allowlisted')));
});

test('SAVE-005 quote expired between quote and execution → requote (blocked)', () => {
  const q = { live: true, planExecutable: true, expiresAt: new Date(Date.now() - 1000).toISOString(), minimumAUSD: '1', minimumShares: '1' };
  const r = validateExecutionQuote(q, { policy: config.save, now: Date.now() });
  assert.equal(r.ok, false); assert.ok(r.blockers.includes('quote_expired'));
});

test('SAVE-006 slippage exceeds the minimum → revert (blocked)', () => {
  const q = { live: true, planExecutable: true, expiresAt: new Date(Date.now() + 60000).toISOString(), minimumAUSD: '1', minimumShares: '1', slippageBps: 500 };
  const r = validateExecutionQuote(q, { policy: { maxSlippageBps: 50, maxPriceImpactBps: 100 }, now: Date.now() });
  assert.equal(r.ok, false); assert.ok(r.blockers.includes('slippage_too_high'));
});

test('SAVE-007 vault paused between quote and execution → blocked, recoverable', () => {
  const q = { live: true, planExecutable: true, expiresAt: new Date(Date.now() + 60000).toISOString(), minimumAUSD: '1', minimumShares: '1', vaultPaused: true };
  const r = validateExecutionQuote(q, { policy: config.save, now: Date.now() });
  assert.ok(r.blockers.includes('vault_paused'));
  // Once unpaused, the same quote clears — recovery, not a dead end.
  assert.equal(validateExecutionQuote({ ...q, vaultPaused: false }, { policy: config.save, now: Date.now() }).ok, true);
});

test('SAVE-008 share price moved → minShares floor enforced (not SAVED)', () => {
  const i = intent();
  const ev = { txStatus: 'success', usdcDebitedAtomic: '1000000', ausdConvertedAtomic: '995000', sharesMintedAtomic: '500000', sharesReceiver: OWNER.address };
  const r = reconcileSaveEvidence(ev, { maxInputUSDC: i.maxInputUSDC, minAUSDOut: i.minAUSDOut, minSharesOut: i.minSharesOut, receiver: i.receiver });
  assert.notEqual(r.outcome, SaveExecOutcome.SAVED);
  assert.ok(r.reasons.includes('shares_below_minimum'));
});

test('SAVE-009 UserOp response lost → reconcile before any retry', () => {
  const r = reconcileSaveEvidence({ txStatus: 'unknown' }, intent());
  assert.equal(r.outcome, SaveExecOutcome.REQUIRES_RECONCILIATION);
  assert.equal(isRetryable('REQUIRES_RECONCILIATION'), false);
  assert.equal(isRetryable('SUBMITTED'), false);
});

test('SAVE-010 replayed authorization (same nonce) → rejected', () => {
  const store = tmpStore();
  assert.equal(consumeSaveNonce(store, OWNER.address, b32('ab')), true);
  assert.equal(consumeSaveNonce(store, OWNER.address, b32('ab')), false);
});

test('SAVE-011 backend claims Saved but shares absent → NOT SAVED', () => {
  const i = intent();
  const ev = { txStatus: 'success', usdcDebitedAtomic: '1000000', ausdConvertedAtomic: '995000', sharesMintedAtomic: '0', sharesReceiver: OWNER.address };
  const r = reconcileSaveEvidence(ev, i);
  assert.notEqual(r.outcome, SaveExecOutcome.SAVED);
  assert.equal(r.outcome, SaveExecOutcome.REQUIRES_RECONCILIATION); // funds moved, shares not minted → recovery
});

test('SAVE-012 CRITICAL: share token owned by backend/relayer → FAIL, never SAVED', () => {
  const i = intent();
  const ev = { txStatus: 'success', usdcDebitedAtomic: '1000000', ausdConvertedAtomic: '995000', sharesMintedAtomic: '990000', sharesReceiver: ATTACKER };
  const r = reconcileSaveEvidence(ev, i);
  assert.notEqual(r.outcome, SaveExecOutcome.SAVED);
  assert.ok(r.reasons.includes('shares_not_to_owner'));
});

test('SAVE-013 APY stale → labeled unavailable (source/freshness surfaced, never faked)', () => {
  const stale = resolveApy({ apy: 0.20, apySource: 'vault', observedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
  assert.equal(stale.available, false); assert.equal(stale.reason, 'rate_stale');
  const fresh = resolveApy({ apy: 0.07, apySource: 'vault', apyWindow: '7d', observedAt: new Date().toISOString() });
  assert.equal(fresh.available, true); assert.equal(fresh.apySource, 'vault');
});

test('SAVE-014 APY zero or negative → display the truth', () => {
  const zero = resolveApy({ apy: 0, apySource: 'vault', observedAt: new Date().toISOString() });
  assert.equal(zero.available, true); assert.equal(zero.apy, 0);
  const neg = resolveApy({ apy: -0.03, apySource: 'vault', observedAt: new Date().toISOString() });
  assert.equal(neg.available, true); assert.equal(neg.apy, -0.03);
});

test('SAVE-015 instant unavailable → route to Standard', () => {
  assert.equal(withdrawFailureAction('instant_unavailable'), 'offer_standard');
  const modes = withdrawModes({ sharesAtomic: '1000000', live: false });
  assert.equal(modes.instant.available, false); // never claims instant liquidity it can't prove
});

test('SAVE-016 queued slower than estimate → still pending, not a failure', () => {
  assert.equal(classifyClaimable({ known: true, claimable: false }), WithdrawOutcome.QUEUED);
  assert.equal(classifyClaimable({ known: false }), WithdrawOutcome.QUEUED); // unknown ⇒ still queued, never optimistic
  assert.equal(withdrawFailureAction('still_queued'), 'wait');
});

test('SAVE-017 redeemed but AUSD→USDC unavailable → AUSD recovery state (funds not stranded)', () => {
  const i = { minAUSDOut: '995000', minUSDCOut: '990000', receiver: OWNER.address };
  const ev = { txStatus: 'success', sharesRedeemedAtomic: '1000000', ausdReceivedAtomic: '995000', usdcReceivedAtomic: '0', usdcReceiver: OWNER.address };
  const r = reconcileWithdrawEvidence(ev, i);
  assert.equal(r.outcome, WithdrawOutcome.RECOVERY_AUSD_HELD);
  assert.equal(r.ausdHeldAtomic, '995000');
});

test('SAVE-018 backend offline → the user still owns their earnAUSD (position reads from chain alone)', () => {
  // No operations, no backend projection — only the chain read. The position is proven from shares held
  // by the USER's account; backend availability is irrelevant to ownership.
  const pos = reconstructPosition({
    prismIdentityId: 'alice', ownerAccount: OWNER.address,
    chain: { available: true, shares: '1000000', currentAUSDValue: '1002000' }, operations: []
  });
  assert.equal(pos.status, SavePositionStatus.ACTIVE);
  assert.equal(pos.earnAUSDShares, '1000000');
  assert.equal(pos.ownerAccount, OWNER.address);
  assert.equal(pos.earnedAUSD, null); // no basis without history — unavailable, never guessed
});
