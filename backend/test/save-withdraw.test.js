import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { consumeSaveNonce } = await import('../src/lib/saveIntent.js');
const { isRetryable } = await import('../src/lib/saveExecution.js');
const { reduceCostBasis } = await import('../src/lib/saveAccounting.js');
const { reconstructPosition } = await import('../src/domain/savePosition.js');
const {
  WithdrawMode, WithdrawOutcome, WithdrawFailure, withdrawModes, withdrawFailureAction,
  withdrawIntentTypedData, verifyWithdrawIntentSignature, validateWithdrawIntent, reconcileWithdrawEvidence, classifyClaimable
} = await import('../src/lib/saveWithdraw.js');

const OWNER = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const VC = config.save.executor;
const b32 = (h) => `0x${h.repeat(32)}`;

function intent(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    owner: OWNER.address, mode: WithdrawMode.INSTANT, vault: config.save.earnAusdVault, shareToken: config.save.earnAusdVault,
    maxShares: '100000000', minAUSDOut: '99000000', minUSDCOut: '98000000', receiver: OWNER.address,
    quoteId: b32('11'), deadline: now + 300, nonce: b32('de'), chainId: config.save.substrateChainId, ...over
  };
}
const sign = (i) => OWNER.signTypedData(withdrawIntentTypedData(i, { verifyingContract: VC }));

test('withdraw intent: a valid signature verifies; changing any protected field invalidates it', async () => {
  const base = intent();
  const sig = await sign(base);
  assert.equal(await verifyWithdrawIntentSignature(base, sig, { verifyingContract: VC }), true);
  for (const [f, v] of Object.entries({ maxShares: '1', vault: '0xdead000000000000000000000000000000000000', receiver: '0xdead000000000000000000000000000000000000', minAUSDOut: '1', minUSDCOut: '1', mode: 'STANDARD', deadline: base.deadline + 1, nonce: b32('ff'), chainId: 1 })) {
    assert.equal(await verifyWithdrawIntentSignature({ ...base, [f]: v }, sig, { verifyingContract: VC }), false, `mutating ${f} must invalidate`);
  }
});

test('withdraw intent: structural validation rejects non-owner receiver / foreign vault / over-shares / wrong chain / expiry', () => {
  const args = { save: config.save, expectedOwner: OWNER.address, maxShares: '100000000' };
  assert.equal(validateWithdrawIntent(intent(), args).ok, true);
  const bad = (over, code) => assert.ok(validateWithdrawIntent(intent(over), args).violations.includes(code));
  bad({ receiver: '0xdead000000000000000000000000000000000000' }, 'receiver_not_owner');
  bad({ vault: '0xdead000000000000000000000000000000000000' }, 'vault_not_verified_earnausd');
  bad({ maxShares: '999000000' }, 'shares_out_of_bounds');
  bad({ chainId: 1 }, 'wrong_chain');
  bad({ deadline: 1 }, 'expired_intent');
  bad({ minUSDCOut: '0' }, 'missing_min_usdc');
});

test('withdraw reconcile: instant success returns USDC to the user (AVAILABLE)', () => {
  const r = reconcileWithdrawEvidence({ txStatus: 'success', sharesRedeemedAtomic: '100000000', ausdReceivedAtomic: '100000000', usdcReceivedAtomic: '99000000', usdcReceiver: OWNER.address }, intent());
  assert.equal(r.outcome, WithdrawOutcome.AVAILABLE);
});

test('withdraw reconcile: minimum-output failure ⇒ FAILED; wrong receiver ⇒ FAILED', () => {
  assert.equal(reconcileWithdrawEvidence({ txStatus: 'success', sharesRedeemedAtomic: '100000000', ausdReceivedAtomic: '10000000', usdcReceivedAtomic: '9000000', usdcReceiver: OWNER.address }, intent()).outcome, WithdrawOutcome.FAILED);
  assert.equal(reconcileWithdrawEvidence({ txStatus: 'success', sharesRedeemedAtomic: '100000000', ausdReceivedAtomic: '100000000', usdcReceivedAtomic: '99000000', usdcReceiver: '0xdead000000000000000000000000000000000000' }, intent()).outcome, WithdrawOutcome.FAILED);
  assert.equal(reconcileWithdrawEvidence({ txStatus: 'failed' }, intent()).outcome, WithdrawOutcome.FAILED);
});

test('withdraw reconcile: AUSD received but USDC conversion incomplete ⇒ RECOVERY (never FAILED, never stranded)', () => {
  const r = reconcileWithdrawEvidence({ txStatus: 'success', sharesRedeemedAtomic: '100000000', ausdReceivedAtomic: '100000000', usdcReceivedAtomic: '0', usdcReceiver: OWNER.address }, intent());
  assert.equal(r.outcome, WithdrawOutcome.RECOVERY_AUSD_HELD);
  assert.equal(r.ausdHeldAtomic, '100000000');
});

test('withdraw reconcile: ambiguous broadcast ⇒ REQUIRES_RECONCILIATION and not retryable (no duplicate)', () => {
  assert.equal(reconcileWithdrawEvidence({ txStatus: 'unknown' }, intent()).outcome, WithdrawOutcome.REQUIRES_RECONCILIATION);
  assert.equal(isRetryable('REQUIRES_RECONCILIATION'), false);
  assert.equal(isRetryable('SUBMITTED'), false);
});

test('withdraw claimability: from vault state, never a local timer', () => {
  assert.equal(classifyClaimable(null), WithdrawOutcome.QUEUED);               // unknown ⇒ still queued
  assert.equal(classifyClaimable({ known: true, claimable: false }), WithdrawOutcome.QUEUED); // queue delay
  assert.equal(classifyClaimable({ known: true, claimable: true }), WithdrawOutcome.CLAIMABLE);
});

test('withdraw: a duplicate request (same nonce) is rejected', () => {
  const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-wd-nonce-')), 'store.json'));
  assert.equal(consumeSaveNonce(store, OWNER.address, b32('de')), true);
  assert.equal(consumeSaveNonce(store, OWNER.address, b32('de')), false);
});

test('withdraw failure actions: every failure has a truthful next step', () => {
  assert.equal(withdrawFailureAction(WithdrawFailure.INSTANT_UNAVAILABLE), 'offer_standard');
  assert.equal(withdrawFailureAction(WithdrawFailure.FEE_CHANGED), 'requote');
  assert.equal(withdrawFailureAction(WithdrawFailure.SUBMISSION_AMBIGUOUS), 'reconcile_no_duplicate');
  assert.equal(withdrawFailureAction(WithdrawFailure.CONVERSION_FAILED_AFTER_CLAIM), 'ausd_recovery');
  assert.equal(withdrawFailureAction(WithdrawFailure.SWAP_UNAVAILABLE), 'retry_conversion');
  assert.equal(withdrawFailureAction(WithdrawFailure.VAULT_PAUSED), 'unavailable');
});

test('withdraw modes: preview offers no invented fee/"free"; observed instant carries its real fee', () => {
  const preview = withdrawModes({ sharesAtomic: '100000000', live: false });
  assert.equal(preview.instant.available, false);
  assert.equal(preview.standard.available, false);
  assert.equal(preview.instant.vaultFeeAtomic, undefined); // no fabricated fee at all
  const observed = withdrawModes({ sharesAtomic: '100000000', live: true, instant: { estimatedUSDCAtomic: '199000000', vaultFeeAtomic: '500000', conversionCostAtomic: '500000' }, standard: { estimatedUSDCAtomic: '199500000', processingWindow: 'Up to 72 hours' } });
  assert.equal(observed.instant.available, true);
  assert.equal(observed.instant.vaultFeeAtomic, '500000');
  assert.equal(observed.standard.processingWindow, 'Up to 72 hours');
});

test('withdraw accounting: partial + full withdrawal, then position reconstructs after restart', () => {
  // partial: basis 100 / shares 100; redeem 40 for 44 AUSD ⇒ remaining 60/60, realized 4.
  const ops = [
    { kind: 'SAVE', state: 'SAVED', actualAUSD: '100000000', sharesReceived: '100000000', inputUSDC: '101000000', createdAt: new Date().toISOString() },
    { kind: 'WITHDRAW_INSTANT', state: 'AVAILABLE', sharesRedeemed: '40000000', outputAUSD: '44000000', outputUSDC: '43500000' }
  ];
  const r = reduceCostBasis(ops);
  assert.equal(r.principalAUSD, '60000000');
  assert.equal(r.shares, '60000000');
  assert.equal(r.realizedYieldAUSD, '4000000');

  // reconstruct the position from chain (shares 60, value 66) + these terminal ops — survives restart.
  const pos = reconstructPosition({ prismIdentityId: 'alice', ownerAccount: OWNER.address, chain: { available: true, shares: '60000000', currentAUSDValue: '66000000' }, operations: ops });
  assert.equal(pos.earnAUSDShares, '60000000');
  assert.equal(pos.principalAUSD, '60000000');
  assert.equal(pos.realizedYieldAUSD, '4000000');
  assert.equal(pos.unrealizedYieldAUSD, '6000000');
});
