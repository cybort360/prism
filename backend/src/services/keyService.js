import { decryptString, encryptString, generateP256KeyPair } from '../lib/crypto.js';

/**
 * Local development signer storage.
 *
 * Private PEM material is encrypted at rest with AES-256-GCM. Production
 * deployments should replace this adapter with an HSM/KMS-backed signer;
 * keeping the interface small makes that swap mechanical.
 */
export class KeyService {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  getOrCreate(name) {
    const stored = this.store.mutate(data => {
      data.serviceKeys ??= {};
      let rec = data.serviceKeys[name];
      if (!rec) {
        const pair = generateP256KeyPair();
        rec = {
          version: 2,
          algorithm: 'P-256',
          publicKeyPem: pair.publicKeyPem,
          qx: pair.qx,
          qy: pair.qy,
          privateKeyEncrypted: encryptString(pair.privateKeyPem, this.config.serviceKeyEncryptionKeyHex),
          createdAt: new Date().toISOString()
        };
        data.serviceKeys[name] = rec;
      } else if (rec.privateKeyPem) {
        // One-time migration from the early development format.
        rec = {
          version: 2,
          algorithm: 'P-256',
          publicKeyPem: rec.publicKeyPem,
          qx: rec.qx,
          qy: rec.qy,
          privateKeyEncrypted: encryptString(rec.privateKeyPem, this.config.serviceKeyEncryptionKeyHex),
          createdAt: rec.createdAt ?? new Date().toISOString(),
          migratedAt: new Date().toISOString()
        };
        data.serviceKeys[name] = rec;
      }
      return structuredClone(rec);
    });

    return {
      privateKeyPem: decryptString(stored.privateKeyEncrypted, this.config.serviceKeyEncryptionKeyHex),
      publicKeyPem: stored.publicKeyPem,
      qx: stored.qx,
      qy: stored.qy
    };
  }
}
