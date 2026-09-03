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

  resolvePhone(requesterPrismId, phone) {
    phone = normalizeE164(phone);
    this._consume(requesterPrismId, 'phone');
    const lookup = phoneLookupKey(phone, this.config.resolverPepper);
    const data = this.store.read();
    const targetId = data.phoneIndex[lookup];
    if (!targetId) return { found: false, reason: 'not_found' };
    const identity = data.identities[targetId];
    if (identity?.phoneDiscoverable === false) return { found: false, reason: 'not_discoverable' };
    return this._attest(identity, 'phone', requesterPrismId);
  }

  resolveHandle(requesterPrismId, rawHandle) {
    this._consume(requesterPrismId, 'handle');
    const handle = String(rawHandle).trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) return { found: false, reason: 'invalid_handle' };
    const data = this.store.read();
    const targetId = data.handleIndex[handle];
    if (!targetId) return { found: false, reason: 'not_found' };
    const identity = data.identities[targetId];
    if (identity?.handleSearchable === false) return { found: false, reason: 'not_discoverable' };
    return this._attest(identity, 'handle', requesterPrismId);
  }

  // Direct Prism-ID resolution is used for already-signed payment requests and QR/payment links.
  resolvePrismId(requesterPrismId, prismId) {
    this._consume(requesterPrismId, 'prism');
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

  _consume(requesterPrismId, route) {
    consumeRateLimit(this.store, `resolve:${requesterPrismId}`, { limit: 60, windowMs: 60 * 60_000 });
    consumeRateLimit(this.store, `resolve-route:${requesterPrismId}:${route}`, { limit: 40, windowMs: 60 * 60_000 });
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
