import { reconstructPosition } from '../domain/savePosition.js';
import { isTerminal } from '../lib/saveLifecycle.js';

// SavePositionService — reads a user's Save position. The vault is the source of truth for shares + value
// (via an injected SaveVaultReader), and the backend store is a projection of operations only. The
// position reconstructs from chain, so it survives reinstall/login without a local row.
//
// The SaveVaultReader interface (real impl reads earnAUSD on Monad; a test injects a fixture):
//   available()                    -> boolean          // is the vault readable on this deployment?
//   sharesOf(account)              -> Promise<string>  // earnAUSD shares held by the account (canonical)
//   convertToAssets(sharesAtomic)  -> Promise<string>  // the vault's OWN share→AUSD conversion
//   apy()                          -> Promise<{ apy, apySource, apyWindow, observedAt } | null>

/** Preview reader — the real earnAUSD vault is mainnet-only and its ABI is unverified, so nothing is
 *  readable here yet. It announces itself (available:false) rather than inventing a position. */
export class PreviewVaultReader {
  constructor(config) { this.config = config; }
  available() { return this.config.save.substrateVerified === true; }
  async sharesOf() { return null; }
  async convertToAssets() { return null; }
  async apy() { return null; }
}

function terminalSaveOps(store, positionId) {
  return Object.values(store.read().saveOperations ?? {})
    .filter((o) => o.positionId === positionId && isTerminal(o.kind, o.state));
}

export class SavePositionService {
  constructor({ store, config, identityService, vaultReader }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.vaultReader = vaultReader ?? new PreviewVaultReader(config);
  }

  async position(prismId) {
    const identity = this.identityService.get(prismId);
    if (!identity?.accountAddress) { const e = new Error('no Prism account for this user'); e.statusCode = 409; throw e; }
    const account = identity.accountAddress;

    // Chain first — never serve a stale cached value as if current.
    const available = this.vaultReader.available();
    let shares = null, value = null, apyRecord = null;
    if (available) {
      shares = await this.vaultReader.sharesOf(account);
      value = shares == null ? null : await this.vaultReader.convertToAssets(shares);
      apyRecord = await this.vaultReader.apy();
    }

    const positionId = `save_${account.toLowerCase()}`;
    const operations = terminalSaveOps(this.store, positionId);
    return reconstructPosition({
      prismIdentityId: identity.prismId, ownerAccount: account,
      chain: { available, shares, currentAUSDValue: value },
      operations, apyRecord
    });
  }
}
