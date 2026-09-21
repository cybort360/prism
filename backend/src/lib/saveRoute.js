// Prism Save — money-safe route/plan types and the ALLOWLIST verifier.
//
// The backend must never be able to hand the phone arbitrary executable calldata and call it "Save".
// A SaveExecutionPlan is therefore fully constrained, and BOTH the backend and the client run this same
// `verifySaveExecutionPlan` against it. A plan only clears verification when every call targets an
// allowlisted contract, moves only USDC→AUSD→earnAUSD, sends the shares to the user's own account, sets
// real minimums + a deadline, and never uses an unlimited approval, an arbitrary recipient, an arbitrary
// external call, or a native MON transfer.
//
// All monetary values are integer base-unit strings (atomic). Never a float, never a Number.

export const SaveCallKind = Object.freeze({
  USDC_APPROVE: 'usdc-approve',   // approve the swap router to pull exactly `input.amount` USDC
  SWAP: 'swap',                   // swap USDC → AUSD on the approved router
  AUSD_APPROVE: 'ausd-approve',   // approve the earnAUSD deposit path to pull AUSD
  VAULT_DEPOSIT: 'vault-deposit'  // deposit AUSD → earnAUSD, receiver = user's Prism account
});

const MAX_UINT256 = (2n ** 256n - 1n).toString();
const lc = (v) => String(v ?? '').toLowerCase();
const isAtomic = (v) => typeof v === 'string' && /^[0-9]+$/.test(v);
const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const gt0 = (v) => isAtomic(v) && BigInt(v) > 0n;

/**
 * Verify a SaveExecutionPlan against what the user actually agreed to. Pure and deterministic; the client
 * mirrors it. Returns { ok, violations }. `ok` is true only when there are zero violations.
 *
 * @param {object} plan
 * @param {object} expected { chainId, account, usdc, ausd, earnAusdVault, swapRouter, inputAmount, now? }
 */
export function verifySaveExecutionPlan(plan, expected) {
  const v = [];
  const usdc = lc(expected.usdc), ausd = lc(expected.ausd), vault = lc(expected.earnAusdVault), router = lc(expected.swapRouter);
  const account = lc(expected.account);
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  // The set of contracts a Save plan is ever allowed to touch. An empty swapRouter means no route is
  // approved yet, so any swap target is unknown → rejected.
  const allow = new Set([usdc, ausd, vault, router].filter((a) => a && a.length === 42));

  if (!plan || typeof plan !== 'object') return { ok: false, violations: ['plan_missing'] };
  if (Number(plan.chainId) !== Number(expected.chainId)) v.push('wrong_chain');
  if (lc(plan.account) !== account || !isAddr(plan.account)) v.push('wrong_account');

  // Input leg: exactly the user-approved USDC amount, and the token is USDC.
  if (lc(plan.input?.token) !== usdc) v.push('input_not_usdc');
  if (!isAtomic(plan.input?.amount) || plan.input?.amount !== String(expected.inputAmount)) v.push('input_amount_mismatch');

  // Intermediate leg: AUSD, with a real minimum-out (slippage floor).
  if (lc(plan.intermediate?.token) !== ausd) v.push('intermediate_not_ausd');
  if (!gt0(plan.intermediate?.minAmount)) v.push('missing_min_ausd');

  // Output leg: earnAUSD, shares to the user's OWN account, with a real minimum share floor.
  if (lc(plan.output?.vault) !== vault) v.push('output_not_earnausd');
  if (lc(plan.output?.receiver) !== account) v.push('output_receiver_not_user');
  if (!gt0(plan.output?.minShares)) v.push('missing_min_shares');

  // Deadline present and in the future.
  if (!Number.isFinite(Number(plan.deadline)) || Number(plan.deadline) <= now) v.push('missing_or_past_deadline');

  // Every call: allowlisted target, no native value, no unlimited/foreign approval, exact-amount approvals.
  const calls = Array.isArray(plan.calls) ? plan.calls : null;
  if (!calls || calls.length === 0) v.push('no_calls');
  for (const [i, c] of (calls ?? []).entries()) {
    const at = `call_${i}`;
    if (!isAddr(c?.target) || !allow.has(lc(c.target))) v.push(`${at}_target_not_allowlisted`);
    if (c?.value !== undefined && c.value !== '0' && c.value !== 0) v.push(`${at}_native_value`);
    if (c?.kind === SaveCallKind.USDC_APPROVE || c?.kind === SaveCallKind.AUSD_APPROVE) {
      const token = c.kind === SaveCallKind.USDC_APPROVE ? usdc : ausd;
      if (lc(c.target) !== token) v.push(`${at}_approve_wrong_token`);
      if (lc(c.spender) !== router && lc(c.spender) !== vault) v.push(`${at}_approve_unknown_spender`);
      if (c.amount === MAX_UINT256 || String(c.amount).toLowerCase() === 'max') v.push(`${at}_unlimited_approval`);
      if (!isAtomic(c.amount)) v.push(`${at}_approve_amount_invalid`);
    }
    if (c?.kind === SaveCallKind.VAULT_DEPOSIT && lc(c.receiver ?? plan.output?.receiver) !== account) {
      v.push(`${at}_deposit_receiver_not_user`);
    }
  }

  return { ok: v.length === 0, violations: v };
}

/**
 * Build the SaveExecutionPlan skeleton the dev/preview provider returns. It is structurally allowlisted
 * (correct targets, value 0, exact input amount, receiver = account) but deliberately carries NO share
 * floor and no live share estimate, because the earnAUSD share price is not yet independently readable —
 * so `verifySaveExecutionPlan` will (correctly) reject it as not-executable. That is the honest signal
 * the client uses to land on the preview terminal instead of pretending a deposit happened.
 */
export function buildPreviewPlan({ chainId, account, usdc, ausd, earnAusdVault, swapRouter, inputAmount, minAusd, deadline }) {
  const spender = swapRouter && swapRouter.length === 42 ? swapRouter : null;
  const calls = [];
  if (spender) {
    calls.push({ kind: SaveCallKind.USDC_APPROVE, target: usdc, spender, amount: String(inputAmount), value: '0' });
    calls.push({ kind: SaveCallKind.SWAP, target: spender, value: '0' });
  }
  calls.push({ kind: SaveCallKind.AUSD_APPROVE, target: ausd, spender: earnAusdVault, amount: String(minAusd ?? '0'), value: '0' });
  calls.push({ kind: SaveCallKind.VAULT_DEPOSIT, target: earnAusdVault, receiver: account, value: '0' });
  return {
    chainId, account,
    input: { token: usdc, amount: String(inputAmount) },
    intermediate: { token: ausd, minAmount: String(minAusd ?? '0') },
    output: { vault: earnAusdVault, receiver: account, minShares: '0' },   // unknown share price → no floor
    deadline: deadline ?? 0,
    calls,
    preview: true,
    executable: false
  };
}
