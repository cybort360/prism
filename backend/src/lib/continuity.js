// PRISM Continuity — the domain model that keeps reachability separate from identity, so a mutable
// alias can never silently change WHO gets paid. Pure and deterministic; fails closed.
//
// Vocabulary (each layer decoupled from the one above it):
//   PrismIdentity          persistent { prismId } — WHO the recipient is.
//   ReachabilityAlias      phone / @handle / QR / link — HOW they are found (a mutable route, never a key).
//   AliasBinding           the (ReachabilityAlias -> PrismIdentity) mapping the resolver holds.
//   AliasVersion           a counter bumped on any authenticated alias/account mutation of an identity.
//   ResolutionAttestation  the resolver's SIGNED statement binding { prismIdentity, recipientAccount,
//                          aliasVersion, requesterPrismId, requestId, issuedAt, expiresAt }.
//   KnownRecipientBinding  what the PAYER last trusted for a local contact: { prismId, account, aliasVersion }.
//   DeviceCredential       the payer's device passkey (root of spending authority) — NOT part of a resolution.
//   PrismAccount           the recipient's on-chain account (recipientAccount) — WHERE money lives.
//
// No raw phone number or deterministic phone-derived value ever appears here — the attestation carries
// only opaque ids and the account address.

export const ContinuityState = Object.freeze({
  FIRST_CONTACT: 'FIRST_CONTACT',                                   // A — no prior trusted PrismIdentity
  CONTINUITY_MATCH: 'CONTINUITY_MATCH',                             // B — same PrismIdentity, may proceed
  IDENTITY_DISCONTINUITY: 'IDENTITY_DISCONTINUITY',                 // C — now a DIFFERENT PrismIdentity, block
  STALE_RESOLUTION: 'STALE_RESOLUTION',                             // D — attestation no longer valid, fail closed
  RESOLVER_UNAVAILABLE_OR_AMBIGUOUS: 'RESOLVER_UNAVAILABLE_OR_AMBIGUOUS' // E — do not guess, do not use stale
});

const lc = (v) => String(v ?? '').toLowerCase();

/**
 * Classify a fresh resolution against what the payer previously trusted for this contact.
 * Same inputs always yield the same state. Verification/freshness is checked BEFORE identity, so a
 * stale/expired/ambiguous resolution never masquerades as a match.
 *
 * @param {object}        p
 * @param {object|null}   p.resolution         { found, ambiguous?, attestation?, signatureValid? }
 * @param {object|null}   p.knownBinding        { prismId, account, aliasVersion } or null (never paid before)
 * @param {number}        p.now                 epoch ms (default Date.now())
 * @param {number|null}   p.currentAliasVersion the live identity aliasVersion, when known (backend); null on client
 * @returns {{ state: string, reason: string }}
 */
export function classifyContinuity({ resolution, knownBinding = null, now = Date.now(), currentAliasVersion = null } = {}) {
  // E — the resolver could not give a single confident answer. Never guess; never fall back to stale state.
  if (!resolution || resolution.found === false || resolution.ambiguous === true || !resolution.attestation) {
    return { state: ContinuityState.RESOLVER_UNAVAILABLE_OR_AMBIGUOUS, reason: resolution?.reason || 'unavailable_or_ambiguous' };
  }
  const a = resolution.attestation;

  // D — a resolution we cannot trust as CURRENT fails closed. Requires fresh resolution.
  if (resolution.signatureValid === false) return { state: ContinuityState.STALE_RESOLUTION, reason: 'invalid_signature' };
  const expires = Date.parse(a.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) return { state: ContinuityState.STALE_RESOLUTION, reason: 'expired' };
  if (currentAliasVersion != null && Number(a.aliasVersion) !== Number(currentAliasVersion)) {
    // Covers both a superseded version and a revoked alias (revocation advances the live version).
    return { state: ContinuityState.STALE_RESOLUTION, reason: 'alias_version_superseded' };
  }

  // A — nothing previously trusted for this contact.
  if (!knownBinding) return { state: ContinuityState.FIRST_CONTACT, reason: 'no_prior_binding' };

  // C — the contact now resolves to a DIFFERENT PrismIdentity (a different human). Never silent.
  if (lc(knownBinding.prismId) !== lc(a.prismIdentity)) {
    return { state: ContinuityState.IDENTITY_DISCONTINUITY, reason: 'prism_identity_changed' };
  }

  // Same PrismIdentity from here on — NOT a different human.
  if (lc(knownBinding.account) === lc(a.recipientAccount)) {
    // B — same identity; alias/version may have changed but the account is unchanged.
    return { state: ContinuityState.CONTINUITY_MATCH, reason: 'same_identity' };
  }
  // Same identity, different active account = an account ROTATION, not a different human. Accept it only
  // when the resolver recorded an authenticated mutation (an advancing AliasVersion); an account swap with
  // no version advance is anomalous — do NOT silently proceed.
  if (Number(a.aliasVersion) > Number(knownBinding.aliasVersion ?? -Infinity)) {
    return { state: ContinuityState.CONTINUITY_MATCH, reason: 'authenticated_account_rotation' };
  }
  return { state: ContinuityState.RESOLVER_UNAVAILABLE_OR_AMBIGUOUS, reason: 'account_changed_without_version_advance' };
}

/**
 * The enforcement adapter used at settlement: an attestation is only usable if it still matches the
 * LIVE identity (same account + same version). Reuses classifyContinuity so the model and the
 * enforcement can never drift. Returns { ok, state, reason }.
 */
export function assertFreshResolution(attestation, liveIdentity, now = Date.now()) {
  if (!liveIdentity || !liveIdentity.accountAddress) return { ok: false, state: ContinuityState.STALE_RESOLUTION, reason: 'identity_unavailable' };
  const knownBinding = { prismId: liveIdentity.prismId, account: liveIdentity.accountAddress, aliasVersion: liveIdentity.aliasVersion };
  const { state, reason } = classifyContinuity({
    resolution: { found: true, attestation, signatureValid: true },
    knownBinding, now, currentAliasVersion: liveIdentity.aliasVersion
  });
  return { ok: state === ContinuityState.CONTINUITY_MATCH, state, reason };
}
