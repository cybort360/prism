// Prism Save — eligibility. Upshift restricts access for users in some jurisdictions, so Save must be able
// to say whether a user is eligible BEFORE any real-money deposit. This never guesses countries: it
// returns the honest state, and if eligibility cannot be established it does NOT silently enable Save.

export const SaveEligibility = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  INELIGIBLE: 'INELIGIBLE',
  UNKNOWN: 'UNKNOWN',                     // no determination could be made for this user
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE' // the compliance check itself is not reachable/configured
});

export class SaveEligibilityService {
  /**
   * @param provider the accepted upstream compliance check, shape: { available():bool,
   *        check(prismId):Promise<'ELIGIBLE'|'INELIGIBLE'|'UNKNOWN'> }. None is wired in V1, so the
   *        service reports SERVICE_UNAVAILABLE — deliberately, rather than fabricating an ELIGIBLE.
   */
  constructor({ config, provider = null } = {}) {
    this.config = config;
    this.provider = provider;
  }

  /** Is a compliance provider wired and reachable at all? Cheap, synchronous — used by the Save home
   *  surface, which cannot await a per-user check. Never asserts ELIGIBLE; that requires check(). */
  providerReady() {
    return !!this.provider && typeof this.provider.available === 'function' && this.provider.available();
  }

  /** Synchronous status for surfaces that can't await: SERVICE_UNAVAILABLE when no provider, else
   *  UNKNOWN (the real determination needs check()). Never fabricates ELIGIBLE. */
  snapshot() {
    return this.providerReady()
      ? { status: SaveEligibility.UNKNOWN, reason: 'per-user determination requires a check' }
      : { status: SaveEligibility.SERVICE_UNAVAILABLE, reason: 'no compliance provider configured for this deployment' };
  }

  async check(prismId) {
    if (!this.providerReady()) {
      return { status: SaveEligibility.SERVICE_UNAVAILABLE, reason: 'no compliance provider configured for this deployment' };
    }
    try {
      const status = await this.provider.check(prismId);
      if (![SaveEligibility.ELIGIBLE, SaveEligibility.INELIGIBLE, SaveEligibility.UNKNOWN].includes(status)) {
        return { status: SaveEligibility.UNKNOWN, reason: 'provider returned an unrecognized status' };
      }
      return { status, reason: null };
    } catch {
      return { status: SaveEligibility.SERVICE_UNAVAILABLE, reason: 'compliance provider errored' };
    }
  }
}

/**
 * The gate real-money Save must pass. Real deposits require BOTH a verified substrate AND a positive
 * eligibility determination. If eligibility is anything other than ELIGIBLE (including UNKNOWN or
 * SERVICE_UNAVAILABLE), real-money Save stays OFF — silence is never treated as consent.
 */
export function realSaveEnabled({ substrateVerified, eligibility }) {
  return substrateVerified === true && eligibility === SaveEligibility.ELIGIBLE;
}
