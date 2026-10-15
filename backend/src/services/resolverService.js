import { canonicalJson, phoneLookupKey, normalizeE164, p256SignData, hex, fromHex, p256VerifyData } from '../lib/crypto.js';
import { consumeRateLimit } from '../lib/rateLimit.js';

export class ResolverService {
  constructor({ store, config, keyService, identityService }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.key = keyService.getOrCreate('resolver');
  }

  publicKey() { return { qx: this.key.qx, qy: this.key.qy, keyId: 'resolver-v1' }; }

  resolvePhone(requesterPrismId, phone, ip = null) {
    phone = normalizeE164(phone);
    this._consume(requesterPrismId, 'phone', ip);
    const lookup = phoneLookupKey(phone, this.config.resolverPepper);
    const data = this.store.read();
    const targetId = data.phoneIndex[lookup];
    if (!targetId) return { found: false, reason: 'not_found' };
    const identity = data.identities[targetId];
    if (identity?.phoneDiscoverable === false) return { found: false, reason: 'not_discoverable' };
    return this._attest(identity, 'phone', requesterPrismId);
  }

  resolveHandle(requesterPrismId, rawHandle, ip = null) {
    this._consume(requesterPrismId, 'handle', ip);
    const handle = String(rawHandle).trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) return { found: false, reason: 'invalid_handle' };
    const data = this.store.read();
    const targetId = data.handleIndex[handle];
    if (!targetId) return { found: false, reason: 'not_found' };
    const identity = data.identities[targetId];
    if (identity?.handleSearchable === false) return { found: false, reason: 'not_discoverable' };
    return this._attest(identity, 'handle', requesterPrismId);
  }

  /**
   * A cheap "is this handle on Prism?" check for as-you-type validation in the recipient picker, so a
   * user is told a handle is real BEFORE they commit to paying it (and can catch a typo). It issues NO
   * signed attestation and reveals no account — only existence + the canonical handle — so it can run
   * on every keystroke without burning the strict `resolve` budget that real payments depend on. It
   * still respects handle discoverability and carries its own generous rate limit against enumeration.
   */
  handleOnPrism(requesterPrismId, rawHandle, ip = null) {
    consumeRateLimit(this.store, `handle-check:${requesterPrismId}`, { limit: 300, windowMs: 60 * 60_000 });
    // Network-wide backstops so cycling identities (each with its own 300/h budget) cannot turn the
    // cheap existence check into an unbounded enumeration oracle. Coarse on purpose: tune per deploy.
    if (ip) consumeRateLimit(this.store, `handle-check-ip:${ip}`, { limit: 600, windowMs: 60 * 60_000 });
    consumeRateLimit(this.store, 'handle-check-global', { limit: 20_000, windowMs: 60 * 60_000 });
    const handle = String(rawHandle ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) return { onPrism: false, handle: null, reason: 'invalid_handle' };
    const data = this.store.read();
    const targetId = data.handleIndex[handle];
    if (!targetId) return { onPrism: false, handle, reason: 'not_found' };
    // The caller's own handle is theirs, not "taken": a resumed onboarding must be able to keep it.
    // Tells the caller nothing they don't already know, so it is answered before discoverability.
    if (targetId === requesterPrismId) return { onPrism: true, handle, yours: true };
    const identity = data.identities[targetId];
    if (identity?.handleSearchable === false) return { onPrism: false, handle, reason: 'not_discoverable' };
    return { onPrism: true, handle, yours: false };
  }

  // Direct Prism-ID resolution is used for already-signed payment requests and QR/payment links.
  resolvePrismId(requesterPrismId, prismId, ip = null) {
    this._consume(requesterPrismId, 'prism', ip);
    const identity = this.identityService.get(prismId);
    if (!identity) return { found: false, reason: 'not_found' };
    return this._attest(identity, 'prism', requesterPrismId);
  }

  verifyResolution(resolution, requesterPrismId) {
    if (!resolution?.found || !resolution?.attestation || !resolution?.signature) throw new Error('signed resolution required');
    if (resolution.resolverKeyId !== 'resolver-v1') throw new Error('unknown resolver key');
    const a = resolution.attestation;
    if (a.requesterPrismId !== requesterPrismId) throw new Error('resolution belongs to another requester');
    const issued = Date.parse(a.issuedAt);
    const expires = Date.parse(a.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('resolution expired');
    if (issued > Date.now() + 30_000 || expires - issued > 5 * 60_000) throw new Error('invalid resolution lifetime');
    const ok = p256VerifyData(this.key.publicKeyPem, Buffer.from(canonicalJson(a)), fromHex(resolution.signature));
    if (!ok) throw new Error('invalid resolver signature');
    return a;
  }

  _consume(requesterPrismId, route, ip = null) {
    consumeRateLimit(this.store, `resolve:${requesterPrismId}`, { limit: 60, windowMs: 60 * 60_000 });
    consumeRateLimit(this.store, `resolve-route:${requesterPrismId}:${route}`, { limit: 40, windowMs: 60 * 60_000 });
    // Per-identity caps alone let an attacker with N identities buy 60N/h of attested resolves. These
    // network-wide backstops bound the whole endpoint regardless of how many identities are cycled:
    // a per-source-IP ceiling, plus a coarse global ceiling for this backend instance. The signed
    // attestation + OTP/Mera cost still make each resolve expensive; these just remove the ceiling's
    // dependence on identity count. Limits are intentionally generous — tune per deployment.
    if (ip) consumeRateLimit(this.store, `resolve-ip:${ip}`, { limit: 120, windowMs: 60 * 60_000 });
    consumeRateLimit(this.store, 'resolve-global', { limit: 3_000, windowMs: 60 * 60_000 });
  }

  _attest(identity, route, requesterPrismId) {
    if (!identity?.accountAddress) return { found: false, reason: 'account_not_ready' };
    const now = Date.now();
    const attestation = {
      recipientAccount: identity.accountAddress,
      prismIdentity: identity.prismId,
      aliasVersion: identity.aliasVersion,
      requesterPrismId,
      requestId: `res_${globalThis.crypto.randomUUID()}`,
      route,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 2 * 60_000).toISOString()
    };
    const payload = Buffer.from(canonicalJson(attestation));
    return {
      found: true,
      attestation,
      signature: hex(p256SignData(this.key.privateKeyPem, payload)),
      resolverKeyId: 'resolver-v1'
    };
  }
}
