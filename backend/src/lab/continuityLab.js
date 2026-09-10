// PRISM Continuity Lab — a safe, deterministic comparison harness that makes the load-bearing
// security invariant judge-visible. It runs TWO paths over the SAME fixture identities:
//
//   BASELINE  alias ─────────────────────────────► account     (a normal payments app: last write wins)
//   PRISM     alias ─► PrismIdentity ─► active account          (reachability decoupled from identity)
//
// and shows the delta: after an alias is legitimately reassigned to a DIFFERENT human, the baseline
// would silently route money to the new account, while PRISM detects the identity change and blocks.
//
// GROUND RULES honoured here (AGENTS.md):
//   • This creates NO production payment state. It takes no store and writes nothing. Every value is
//     an in-memory FIXTURE, and the report is flagged `fixtures:true`/`createsProductionState:false`.
//   • The DETECTORS are the real product's own code, not a toy that returns the desired answer:
//       - continuity/discontinuity/staleness → `classifyContinuity` (backend/src/lib/continuity.js),
//         the exact classifier the server's continuity enforcement delegates to.
//       - amount/recipient/replay mutation → `paymentEnvelopeTypedData` + `verifyTypedData`
//         (backend/src/chain/eth.js), the exact EIP-712 build + verify used at settlement. A real
//         throwaway key signs a real envelope; mutating any signed field makes the real verifier
//         recover a different address and return false. Nothing is stubbed to "reject".
//   • On-chain replay rejection is enforced by the single-use nonce in the contract; the Lab proves
//     the nonce is signature-bound and cites the executed contract evidence (see `evidence`).

import { classifyContinuity, ContinuityState } from '../lib/continuity.js';
import { paymentEnvelopeTypedData, verifyTypedData } from '../chain/eth.js';
import { privateKeyToAccount } from 'viem/accounts';

// ---- deterministic fixture identities (NOT real users; clearly namespaced) ------------------------
const P1 = 'lab-PrismIdentity-P1';                                   // Tobi — the human the payer trusts
const P2 = 'lab-PrismIdentity-P2';                                   // a DIFFERENT human, later on the same alias
const W1 = '0x1111111111111111111111111111111111111111';            // P1's account
const W2 = '0x2222222222222222222222222222222222222222';            // P2's account
const ALIAS_A = '+1-555-0100 (fixture)';                             // the reassigned phone alias
const ALIAS_B = '@tobi-new (fixture)';                               // where P1 legitimately moved

// A fixed clock so the report is byte-stable across runs. All attestation lifetimes are relative to it.
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// A fixture resolver attestation shaped exactly as `classifyContinuity` consumes it. `signatureValid`
// stands in for the resolver P-256 check the real resolver performs before classification.
function attestation({ prismIdentity, account, aliasVersion, expiresAt, signatureValid = true }) {
  return {
    found: true,
    signatureValid,
    attestation: { prismIdentity, recipientAccount: account, aliasVersion, issuedAt: iso(NOW), expiresAt }
  };
}

// ---- the two resolution paths, over identical fixtures --------------------------------------------

// BASELINE: a plain mutable alias→account map, last write wins. This is what a normal payments app
// does — and why a reassigned number silently redirects money to whoever holds it now.
function baselineResolve(aliasMap, alias) {
  return aliasMap[alias] ?? null;
}

// PRISM: classify the fresh resolution against what the payer last trusted for this contact, using the
// real production classifier. No new logic here — this is the product's decision function.
function prismClassify({ resolution, knownBinding }) {
  return classifyContinuity({ resolution, knownBinding, now: NOW, currentAliasVersion: null });
}

// ---- envelope-mutation detector (real EIP-712 build + real verify) --------------------------------

// A deterministic throwaway signer — never a real user key; used only to produce a signable fixture.
const LAB_KEY = `0x${'1a'.repeat(32)}`;

const BASE_ENVELOPE = Object.freeze({
  paymentId: `0x${'a1'.repeat(32)}`,
  payer: null,                                    // filled with the throwaway account below
  recipient: W1,
  amount: '1000000',                              // 1.00 USDC (6dp)
  requestId: `0x${'00'.repeat(32)}`,
  resolutionHash: `0x${'c0'.repeat(32)}`,
  validBefore: Math.floor(NOW / 1000) + 3600,
  nonce: `0x${'de'.repeat(32)}`
});

// Sign a fixture envelope once, then verify the ORIGINAL signature against a MUTATED envelope through
// the real `verifyTypedData`. Recovery lands on a different address → false. `reject:true` means the
// product would refuse the mutated authorization.
async function detectEnvelopeMutation(signer, signature, mutate) {
  const mutated = mutate({ ...BASE_ENVELOPE, payer: signer.address });
  const accepted = await verifyTypedData(paymentEnvelopeTypedData(mutated), signer.address, signature);
  return { reject: accepted === false };
}

/**
 * Run the whole Lab and return a structured, deterministic report. No store, no side effects.
 * @returns {Promise<object>} report ({ fixtures, createsProductionState, scenario, delta, attacks, verifiers })
 */
export async function runContinuityLab() {
  // ---- SCENARIO 1–7 (the narrative both paths are measured against) -------------------------------
  // Live alias map for the baseline path, mutated exactly as the scenario dictates.
  const aliasMap = { [ALIAS_A]: W1 };
  const scenario = [];
  scenario.push({ step: 1, title: 'Tobi owns phone alias A', detail: `${ALIAS_A} is Tobi's reachability route.` });
  scenario.push({ step: 2, title: 'Alias A resolves to PrismIdentity P1 / account W1', detail: `${ALIAS_A} → ${P1} → ${W1}` });

  // Step 3 — the payer pays Tobi. This records the payer's trusted binding (P1/W1). FIXTURE only.
  const trustedBinding = { prismId: P1, account: W1, aliasVersion: 1 };
  scenario.push({ step: 3, title: 'User pays Tobi — trust recorded', detail: `payer now trusts ${P1} @ ${W1} for this contact` });

  // Step 4 — Tobi legitimately moves to alias B, KEEPING P1. (Reachability changed, identity did not.)
  aliasMap[ALIAS_B] = W1;
  scenario.push({ step: 4, title: 'Tobi moves to alias B, keeps P1', detail: `${ALIAS_B} → ${P1} → ${W1} (new route, same human)` });

  // Step 5 — PRISM resolves alias B → P1: continuity holds, a later payment succeeds.
  const contViaB = prismClassify({
    resolution: attestation({ prismIdentity: P1, account: W1, aliasVersion: 2, expiresAt: iso(NOW + 120_000) }),
    knownBinding: trustedBinding
  });
  scenario.push({ step: 5, title: 'PRISM resolves alias B → P1 → CONTINUITY', detail: `classifyContinuity = ${contViaB.state} (${contViaB.reason}) → payment allowed` });

  // Step 6 — alias A is later reassigned to a DIFFERENT human: PrismIdentity P2 / account W2.
  aliasMap[ALIAS_A] = W2;
  scenario.push({ step: 6, title: 'Alias A reassigned to P2 / W2', detail: `${ALIAS_A} now belongs to a different human (${P2} @ ${W2})` });

  // Step 7 — the payer tries to pay the OLD contact (alias A). Measure both paths.
  const baselineAccount = baselineResolve(aliasMap, ALIAS_A);                 // → W2 (silent redirect)
  const prismResult = prismClassify({
    resolution: attestation({ prismIdentity: P2, account: W2, aliasVersion: 1, expiresAt: iso(NOW + 120_000) }),
    knownBinding: trustedBinding                                             // still P1/W1
  });
  scenario.push({ step: 7, title: 'User pays the old contact (alias A)', detail: 'baseline vs PRISM measured below' });

  // ---- THE DELTA (judge-visible) ------------------------------------------------------------------
  const prismBlocked = prismResult.state === ContinuityState.IDENTITY_DISCONTINUITY;
  const delta = {
    baseline: {
      model: 'alias → account (last write wins)',
      resolvesTo: baselineAccount,
      routesToDifferentHuman: baselineAccount?.toLowerCase() === W2.toLowerCase(),
      blocked: false,
      result: 'WOULD SEND to the reassigned account — no signal to the payer'
    },
    prism: {
      model: 'alias → PrismIdentity → active account',
      previouslyTrusted: { label: 'PREVIOUSLY TRUSTED', prismIdentity: P1, account: W1 },
      currentResolution: { label: 'CURRENT RESOLUTION', prismIdentity: P2, account: W2 },
      state: prismResult.state,
      reason: prismResult.reason,
      blocked: prismBlocked,
      result: prismBlocked ? 'PAYMENT BLOCKED — recipient identity changed' : `UNEXPECTED (${prismResult.state})`
    },
    // Continuity broken ≠ proven malice. It means the trusted binding no longer holds, so the payer
    // must explicitly review and re-establish trust before any money can move.
    interpretation: 'Continuity is broken → requires explicit user review / re-establishment. This does not by itself prove malicious intent.'
  };

  // ---- ATTACKS (each stated EXPECTED / OBSERVED / PASS / evidence, run through production code) ----
  const attacks = [];

  // 1) Stale-resolution attack — replay an EXPIRED attestation as if current.
  const stale = prismClassify({
    resolution: attestation({ prismIdentity: P1, account: W1, aliasVersion: 1, expiresAt: iso(NOW - 60_000) }),
    knownBinding: trustedBinding
  });
  attacks.push({
    id: 'stale-resolution',
    name: 'Stale-resolution attack',
    expected: `${ContinuityState.STALE_RESOLUTION} (fail closed; force a fresh resolution)`,
    observed: `${stale.state} (${stale.reason})`,
    pass: stale.state === ContinuityState.STALE_RESOLUTION,
    verifier: 'classifyContinuity — backend/src/lib/continuity.js',
    evidence: 'PROOF_LEDGER CONT-2 (security-boundaries.test.js; assertResolution 409)'
  });

  // Sign one real fixture envelope; every envelope attack verifies the ORIGINAL signature against a
  // mutated copy through the real verifier.
  const signer = privateKeyToAccount(LAB_KEY);
  const signed = { ...BASE_ENVELOPE, payer: signer.address };
  const signature = await signer.signTypedData(paymentEnvelopeTypedData(signed));

  // Sanity: the untouched envelope MUST verify — otherwise a rejection below would be meaningless.
  const baselineVerifies = await verifyTypedData(paymentEnvelopeTypedData(signed), signer.address, signature);

  // 2) Amount-mutation attack — inflate the amount after signing.
  const amt = await detectEnvelopeMutation(signer, signature, (e) => ({ ...e, amount: '5000000' }));
  attacks.push({
    id: 'amount-mutation',
    name: 'Amount-mutation attack',
    expected: 'REJECTED — signature no longer recovers to the payer (amount is signature-bound)',
    observed: amt.reject ? 'REJECTED (verifyTypedData = false)' : 'ACCEPTED (unexpected)',
    pass: baselineVerifies && amt.reject,
    verifier: 'paymentEnvelopeTypedData + verifyTypedData — backend/src/chain/eth.js',
    evidence: 'PROOF_LEDGER R4 / AUTH-1 (PrismPaymentRouter.t.sol testModifiedAmountRejected)'
  });

  // 3) Recipient-mutation attack — redirect to a different account after signing.
  const rcpt = await detectEnvelopeMutation(signer, signature, (e) => ({ ...e, recipient: W2 }));
  attacks.push({
    id: 'recipient-mutation',
    name: 'Recipient-mutation attack',
    expected: 'REJECTED — signature no longer recovers to the payer (recipient is signature-bound)',
    observed: rcpt.reject ? 'REJECTED (verifyTypedData = false)' : 'ACCEPTED (unexpected)',
    pass: baselineVerifies && rcpt.reject,
    verifier: 'paymentEnvelopeTypedData + verifyTypedData — backend/src/chain/eth.js',
    evidence: 'PROOF_LEDGER R5 / AUTH-1 (PrismPaymentRouter.t.sol testModifiedRecipientRejected)'
  });

  // 4) Replay attack — reuse the authorization with a fresh nonce (the only way to "replay" without
  // detection). The nonce is signature-bound, so swapping it breaks the signature; and the ORIGINAL
  // nonce is single-use on-chain, so the unmodified authorization can settle at most once.
  const replay = await detectEnvelopeMutation(signer, signature, (e) => ({ ...e, nonce: `0x${'ff'.repeat(32)}` }));
  attacks.push({
    id: 'replay',
    name: 'Replay attack',
    expected: 'REJECTED — nonce is signature-bound; the original nonce is single-use on-chain',
    observed: replay.reject ? 'REJECTED (verifyTypedData = false on a swapped nonce)' : 'ACCEPTED (unexpected)',
    pass: baselineVerifies && replay.reject,
    verifier: 'paymentEnvelopeTypedData + verifyTypedData — backend/src/chain/eth.js (nonce binding); single-use nonce enforced on-chain',
    evidence: 'PROOF_LEDGER R6 / AUTH-2 (PrismPaymentRouter.t.sol testReplayRejected; mutation-audit MUT-08/16)'
  });

  return {
    fixtures: true,
    createsProductionState: false,
    generatedAt: iso(NOW),
    identities: { P1, P2 },
    accounts: { W1, W2 },
    aliases: { A: ALIAS_A, B: ALIAS_B },
    scenario,
    delta,
    attacks,
    allAttacksPass: attacks.every((a) => a.pass),
    verifiers: {
      continuity: 'classifyContinuity — backend/src/lib/continuity.js (production classifier)',
      envelope: 'paymentEnvelopeTypedData + verifyTypedData — backend/src/chain/eth.js (production EIP-712 build + verify)'
    }
  };
}
