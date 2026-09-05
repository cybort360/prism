import crypto from 'node:crypto';
import { encryptString, decryptString, phoneLookupKey, normalizeE164, canonicalJson } from '../lib/crypto.js';
import { verifyAccountMessage, isEvmAddress, checksum } from '../chain/eth.js';

/**
 * Prism Identity is a lightweight, persistent product identity. It records reachability aliases
 * (private phone, optional public @handle) and binds them to the user's Mera passkey-derived
 * account address. The Mera account is the financial signing authority; Prism Identity never holds
 * a key. Alias possession (OTP) can update reachability but can NEVER seize a bound account:
 * account-scoped actions require a fresh signature from the Mera account itself.
 */
export class IdentityService {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  async upsertVerifiedPhone({ phone, account, bindingProof, requestedHandle, challengeNonce }) {
    phone = normalizeE164(phone);
    account = this._assertAccount(account);
    await this._assertAccountControl(account, bindingProof, challengeNonce);
    const key = phoneLookupKey(phone, this.config.resolverPepper);
    let identity = this.store.mutate(data => {
      const existingId = data.phoneIndex[key];
      if (existingId) {
        const existing = data.identities[existingId];
        // Alias possession is not spending authority. OTP can never repoint a bound account.
        if (existing.account.toLowerCase() !== account.toLowerCase()) {
          const e = new Error('existing Prism identity is bound to a different account; recovery required');
          e.statusCode = 409;
          throw e;
        }
        return existing;
      }
      return this._insert(data, { account, phone, key });
    });
    if (requestedHandle) identity = this.setHandle(identity.prismId, requestedHandle);
    return identity;
  }

  async createDeviceIdentity({ account, bindingProof, requestedHandle, challengeNonce }) {
    account = this._assertAccount(account);
    await this._assertAccountControl(account, bindingProof, challengeNonce);
    let identity = this.store.mutate(data => {
      const duplicate = Object.values(data.identities).find(x => x.account.toLowerCase() === account.toLowerCase());
      if (duplicate) return duplicate;
      return this._insert(data, { account });
    });
    if (requestedHandle) identity = this.setHandle(identity.prismId, requestedHandle);
    return identity;
  }

  _insert(data, { account, phone = null, key = null }) {
    const prismId = crypto.randomUUID();
    const now = new Date().toISOString();
    const rec = {
      prismId, createdAt: now, updatedAt: now, aliasVersion: 1,
      displayName: null,
      account,                      // Mera passkey-derived EVM account = signing authority AND money account
      accountAddress: account,      // canonical USDC-holding address (same address)
      phoneEncrypted: phone ? encryptString(phone, this.config.dataEncryptionKeyHex) : null,
      phoneLookupKey: key,
      phoneDiscoverable: true, handleSearchable: true, handle: null
    };
    data.identities[prismId] = rec;
    if (key) data.phoneIndex[key] = prismId;
    return rec;
  }

  async bindVerifiedPhoneAuthorized(prismId, phone, accountSignature) {
    phone = normalizeE164(phone);
    const identity = this.get(prismId);
    if (!identity) throw new Error('identity not found');
    await this._assertAccountMutation(identity, { action: 'bind_phone', aliasVersion: identity.aliasVersion, prismId: identity.prismId, value: phone }, accountSignature);
    return this.bindVerifiedPhone(prismId, phone);
  }

  async setHandleAuthorized(prismId, rawHandle, accountSignature) {
    const handle = normalizeHandle(rawHandle);
    const identity = this.get(prismId);
    if (!identity) throw new Error('identity not found');
    await this._assertAccountMutation(identity, { action: 'set_handle', aliasVersion: identity.aliasVersion, prismId: identity.prismId, value: handle }, accountSignature);
    return this.setHandle(prismId, handle);
  }

  bindVerifiedPhone(prismId, phone) {
    phone = normalizeE164(phone);
    const key = phoneLookupKey(phone, this.config.resolverPepper);
    return this.store.mutate(data => {
      const identity = data.identities[prismId];
      if (!identity) throw new Error('identity not found');
      const owner = data.phoneIndex[key];
      if (owner && owner !== prismId) {
        const e = new Error('phone already belongs to another Prism identity');
        e.statusCode = 409;
        throw e;
      }
      if (identity.phoneLookupKey === key) return identity;
      if (identity.phoneLookupKey) delete data.phoneIndex[identity.phoneLookupKey];
      identity.phoneEncrypted = encryptString(phone, this.config.dataEncryptionKeyHex);
      identity.phoneLookupKey = key;
      identity.aliasVersion += 1;
      identity.updatedAt = new Date().toISOString();
      data.phoneIndex[key] = prismId;
      return identity;
    });
  }

  setHandle(prismId, rawHandle) {
    const handle = normalizeHandle(rawHandle);
    return this.store.mutate(data => {
      const owner = data.handleIndex[handle];
      if (owner && owner !== prismId) {
        const e = new Error('handle unavailable');
        e.statusCode = 409;
        throw e;
      }
      const identity = data.identities[prismId];
      if (!identity) throw new Error('identity not found');
      if (identity.handle === handle) return identity;
      if (identity.handle) delete data.handleIndex[identity.handle];
      identity.handle = handle;
      identity.aliasVersion += 1;
      identity.updatedAt = new Date().toISOString();
      data.handleIndex[handle] = prismId;
      return identity;
    });
  }

  setProfile(prismId, { displayName }) {
    const normalized = String(displayName ?? '').trim().replace(/\s+/g, ' ');
    if (normalized.length < 1 || normalized.length > 60) {
      const e = new Error('display name must be 1-60 characters');
      e.statusCode = 400;
      throw e;
    }
    return this.store.mutate(data => {
      const identity = data.identities[prismId];
      if (!identity) throw new Error('identity not found');
      identity.displayName = normalized;
      identity.updatedAt = new Date().toISOString();
      return identity;
    });
  }

  setPrivacy(prismId, { phoneDiscoverable, handleSearchable }) {
    return this.store.mutate(data => {
      const identity = data.identities[prismId];
      if (!identity) throw new Error('identity not found');
      if (typeof phoneDiscoverable === 'boolean') identity.phoneDiscoverable = phoneDiscoverable;
      if (typeof handleSearchable === 'boolean') identity.handleSearchable = handleSearchable;
      identity.updatedAt = new Date().toISOString();
      return identity;
    });
  }

  get(prismId) { return this.store.read().identities[prismId] ?? null; }

  publicView(identity) {
    if (!identity) return null;
    let phoneMasked = null;
    if (identity.phoneEncrypted) {
      try { phoneMasked = maskPhone(decryptString(identity.phoneEncrypted, this.config.dataEncryptionKeyHex)); }
      catch { phoneMasked = null; }
    }
    return {
      prismId: identity.prismId,
      displayName: identity.displayName ?? null,
      handle: identity.handle ? `@${identity.handle}` : null,
      account: identity.account,
      accountAddress: identity.accountAddress,
      aliasVersion: identity.aliasVersion,
      phoneMasked,
      hasVerifiedPhone: Boolean(identity.phoneLookupKey),
      phoneDiscoverable: identity.phoneDiscoverable !== false,
      handleSearchable: identity.handleSearchable !== false
    };
  }

  _assertAccount(account) {
    if (!isEvmAddress(account)) throw new Error('a Mera account address is required');
    return checksum(account);
  }

  // Issue a single-use, short-lived binding challenge. The app signs it to prove current control of
  // the Mera account; the server-issued nonce makes the proof non-replayable (F-07).
  issueBindingChallenge() {
    const nonce = `0x${crypto.randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.store.mutate((d) => {
      d.challenges ??= {};
      d.challenges[nonce] = { action: 'bind_account', expiresAt, createdAt: new Date().toISOString() };
    });
    return { nonce, expiresAt };
  }

  // Atomically consume a binding challenge exactly once. Throws if missing, expired, or already used.
  _consumeBindingChallenge(nonce) {
    if (!nonce) { const e = new Error('binding challenge required'); e.statusCode = 401; throw e; }
    let ok = false;
    this.store.mutate((d) => {
      d.challenges ??= {};
      const c = d.challenges[nonce];
      if (c) delete d.challenges[nonce];                       // single-use: consume regardless of validity
      if (c && c.action === 'bind_account' && Date.parse(c.expiresAt) > Date.now()) ok = true;
    });
    if (!ok) { const e = new Error('binding challenge invalid or already used'); e.statusCode = 401; throw e; }
  }

  // Onboarding proof: the app proves current control of the Mera account by signing a server-issued
  // single-use challenge. Verify the signature first (a bad signature must not burn the nonce), then
  // atomically consume the challenge so the proof can never be replayed.
  async _assertAccountControl(account, bindingProof, challengeNonce) {
    const payload = canonicalJson({ action: 'bind_account', account: account.toLowerCase(), nonce: challengeNonce });
    const ok = await verifyAccountMessage(account, payload, bindingProof ?? '');
    if (!ok) {
      const e = new Error('Mera account control signature required');
      e.statusCode = 401;
      throw e;
    }
    this._consumeBindingChallenge(challengeNonce);
  }

  async _assertAccountMutation(identity, payload, signature) {
    const ok = await verifyAccountMessage(identity.account, canonicalJson(payload), signature ?? '');
    if (!ok) {
      const e = new Error('invalid account signature');
      e.statusCode = 401;
      throw e;
    }
  }
}

function normalizeHandle(raw) {
  const handle = String(raw).trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(handle)) throw new Error('handle must be 3-24 chars: a-z, 0-9, underscore');
  return handle;
}
function maskPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return phone;
  return `${phone.slice(0, Math.min(7, phone.length))} ••• ••${digits.slice(-2)}`;
}
