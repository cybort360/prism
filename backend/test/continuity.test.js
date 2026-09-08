import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyContinuity, ContinuityState as S } from '../src/lib/continuity.js';

// Deterministic, platform-independent tests for the PRISM Continuity classifier. No services, no env —
// same inputs always yield the same state. Mirrors ios/PrismTests/PrismContinuityTests.swift.

const NOW = 1_800_000_000_000;
const acctA = '0xAAaa00000000000000000000000000000000AAaa';
const acctB = '0xBBbb00000000000000000000000000000000BBbb';

function attestation({ prismId = 'prism-A', account = acctA, aliasVersion = 1, expiresInMs = 120_000 } = {}) {
  return {
    prismIdentity: prismId, recipientAccount: account, aliasVersion,
    requesterPrismId: 'payer', requestId: 'res_abc',
    issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + expiresInMs).toISOString()
  };
}
const resolved = (o = {}) => ({ found: true, signatureValid: true, attestation: attestation(o) });
const binding = (o = {}) => ({ prismId: 'prism-A', account: acctA, aliasVersion: 1, ...o });
const classify = (resolution, knownBinding = null, currentAliasVersion = null) =>
  classifyContinuity({ resolution, knownBinding, now: NOW, currentAliasVersion }).state;

// A — FIRST_CONTACT
test('continuity A: first resolution (no prior binding) is FIRST_CONTACT', () => {
  assert.equal(classify(resolved(), null), S.FIRST_CONTACT);
});

// B — CONTINUITY_MATCH: same identity, same alias
test('continuity B: same identity + same alias is CONTINUITY_MATCH', () => {
  assert.equal(classify(resolved({ aliasVersion: 1 }), binding({ aliasVersion: 1 })), S.CONTINUITY_MATCH);
});

// B — CONTINUITY_MATCH: same identity, rotated alias (version bumped, account unchanged)
test('continuity B: same identity + rotated alias is CONTINUITY_MATCH', () => {
  assert.equal(classify(resolved({ aliasVersion: 4 }), binding({ aliasVersion: 1 })), S.CONTINUITY_MATCH);
});

// B — CONTINUITY_MATCH: same identity, rotated active account under an authenticated (advancing) binding
test('continuity B: same identity + rotated account with advancing version is CONTINUITY_MATCH (not a different human)', () => {
  assert.equal(classify(resolved({ account: acctB, aliasVersion: 5 }), binding({ account: acctA, aliasVersion: 1 })), S.CONTINUITY_MATCH);
});

// Guard: same identity, account changed WITHOUT a version advance → do not silently proceed
test('continuity: same identity + account change without version advance is AMBIGUOUS (fail closed)', () => {
  assert.equal(classify(resolved({ account: acctB, aliasVersion: 1 }), binding({ account: acctA, aliasVersion: 1 })), S.RESOLVER_UNAVAILABLE_OR_AMBIGUOUS);
});

// C — IDENTITY_DISCONTINUITY: different PrismIdentity behind the previously-known alias
test('continuity C: a different PrismIdentity behind a known alias is IDENTITY_DISCONTINUITY', () => {
  assert.equal(classify(resolved({ prismId: 'prism-B', account: acctB }), binding({ prismId: 'prism-A', account: acctA })), S.IDENTITY_DISCONTINUITY);
});

// D — STALE_RESOLUTION: stale version (attestation version != live identity version)
test('continuity D: a superseded alias version is STALE_RESOLUTION', () => {
  assert.equal(classify(resolved({ aliasVersion: 2 }), binding(), /*currentAliasVersion*/ 3), S.STALE_RESOLUTION);
});

// D — STALE_RESOLUTION: expired attestation
test('continuity D: an expired attestation is STALE_RESOLUTION', () => {
  assert.equal(classify(resolved({ expiresInMs: -1 }), binding()), S.STALE_RESOLUTION);
});

// D — STALE_RESOLUTION: invalid resolver signature
test('continuity D: an invalid resolver signature is STALE_RESOLUTION', () => {
  assert.equal(classify({ found: true, signatureValid: false, attestation: attestation() }, binding()), S.STALE_RESOLUTION);
});

// D — STALE_RESOLUTION: revoked alias (revocation advances the live version past the attestation)
test('continuity D: a revoked alias is STALE_RESOLUTION', () => {
  assert.equal(classify(resolved({ aliasVersion: 1 }), binding(), /*currentAliasVersion*/ 2), S.STALE_RESOLUTION);
});

// E — RESOLVER_UNAVAILABLE_OR_AMBIGUOUS: ambiguity / not found
test('continuity E: resolver ambiguity is RESOLVER_UNAVAILABLE_OR_AMBIGUOUS', () => {
  assert.equal(classify({ found: true, ambiguous: true, attestation: attestation() }, binding()), S.RESOLVER_UNAVAILABLE_OR_AMBIGUOUS);
});
test('continuity E: a not-found resolution is RESOLVER_UNAVAILABLE_OR_AMBIGUOUS', () => {
  assert.equal(classify({ found: false }, binding()), S.RESOLVER_UNAVAILABLE_OR_AMBIGUOUS);
});

// Determinism + fail-closed ordering: an expired attestation that ALSO points at a different identity
// is reported STALE (verification precedes identity), never a silent match.
test('continuity: freshness is checked before identity (fail closed)', () => {
  assert.equal(classify(resolved({ prismId: 'prism-B', expiresInMs: -1 }), binding()), S.STALE_RESOLUTION);
});
