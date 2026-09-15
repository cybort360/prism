/**
 * The runtime half of the Allowance Module hard gate.
 *
 * `tools/circles/verify-allowance-module.mjs` is the build-time gate an operator runs before
 * turning limits on. This is the one the server runs itself, at boot and again before it will let
 * anybody spend against an allowance — because "we checked at build time" is not a statement about
 * the chain the server is actually talking to.
 *
 * It fails closed in every direction. An unreadable chain, a mismatched codeHash, a module that
 * reports a version below the floor, a missing selector — all of them mean the same thing: no
 * spending limits. Circles falls back to threshold-only payments, which always work.
 *
 * The check is deliberately about **code**, not address. A Prism-deployed module at a novel address
 * is acceptable if and only if its runtime bytecode is byte-identical to Safe's canonical v1.0.0
 * deployment; the canonical address with the wrong code is not.
 */
import { getAddress, keccak256, toHex } from 'viem';
import {
  ALLOWANCE_MODULE_ABI, CANONICAL_ALLOWANCE_MODULE, MINIMUM_ALLOWANCE_MODULE_VERSION,
  MINIMUM_SAFE_VERSION_FOR_MODULE, VULNERABLE_ALLOWANCE_MODULE_VERSIONS,
  compareVersions, meetsMinimumModuleVersion
} from './allowanceModule.js';
import { logger } from '../lib/logger.js';

/** Every function the module must expose. A deployment missing any of these is not this module. */
export const REQUIRED_SELECTORS = Object.freeze([
  'NAME()', 'VERSION()', 'addDelegate(address)', 'removeDelegate(address,bool)',
  'setAllowance(address,address,uint96,uint16,uint32)', 'deleteAllowance(address,address)',
  'getTokenAllowance(address,address,address)', 'getDelegates(address,uint48,uint8)',
  'generateTransferHash(address,address,address,uint96,address,uint96,uint16)',
  'executeAllowanceTransfer(address,address,address,uint96,address,uint96,address,bytes)'
].map((sig) => ({ sig, selector: keccak256(toHex(sig)).slice(2, 10) })));

/** How long a successful verification is reused before the chain is asked again. */
const VERIFICATION_TTL_MS = 5 * 60_000;

export class AllowanceModuleGate {
  /**
   * @param {object} deps
   * @param {object} deps.config Prism config — `config.circles.{limitsEnabled,allowanceModule}`
   * @param {object} deps.chain  { readContract, getCode } — the RPC seam
   */
  constructor({ config, chain }) {
    this.config = config;
    this.chain = chain;
    this._cache = null;
  }

  /** True only when the operator asked for limits AND named a module to check. */
  get requested() {
    return Boolean(this.config.circles.limitsEnabled && this.config.circles.allowanceModule);
  }

  /**
   * Verify the configured module against the chain. Cached briefly on success; a failure is never
   * cached, so a transient RPC problem does not disable limits for five minutes, and a real one
   * keeps being reported.
   */
  async verify({ force = false } = {}) {
    if (!this.config.circles.limitsEnabled) {
      return this._off('CIRCLE_LIMITS_ENABLED is false');
    }
    if (!this.config.circles.allowanceModule) {
      return this._off('CIRCLE_LIMITS_ENABLED is true but CIRCLE_ALLOWANCE_MODULE names no module');
    }
    if (!force && this._cache && Date.now() - this._cache.at < VERIFICATION_TTL_MS) {
      return this._cache.result;
    }

    const address = getAddress(this.config.circles.allowanceModule);
    const result = await this._check(address).catch((error) => ({
      usable: false, address, reason: `the Allowance Module could not be verified: ${error.message}`
    }));

    if (result.usable) this._cache = { at: Date.now(), result };
    else logger.error('circles.allowance.gate.failed', { address, reason: result.reason });
    return result;
  }

  async _check(address) {
    // --- the code itself ---------------------------------------------------
    const code = await this.chain.getCode(address);
    if (!code || code === '0x') return { usable: false, address, reason: `no contract at ${address}` };

    const codeHash = keccak256(code);
    if (codeHash.toLowerCase() !== CANONICAL_ALLOWANCE_MODULE.codeHash.toLowerCase()) {
      return {
        usable: false, address,
        reason: `the code at ${address} is not Safe's canonical Allowance Module v${CANONICAL_ALLOWANCE_MODULE.version} `
          + `(codeHash ${codeHash}, expected ${CANONICAL_ALLOWANCE_MODULE.codeHash})`
      };
    }

    const lower = code.toLowerCase();
    const missing = REQUIRED_SELECTORS.filter((s) => !lower.includes(s.selector));
    if (missing.length) {
      return { usable: false, address, reason: `the module is missing ${missing.map((m) => m.sig).join(', ')}` };
    }

    // --- what the contract says about itself -------------------------------
    const [version, name] = await Promise.all([
      this.chain.readContract({ address, abi: ALLOWANCE_MODULE_ABI, functionName: 'VERSION', args: [] }),
      this.chain.readContract({ address, abi: ALLOWANCE_MODULE_ABI, functionName: 'NAME', args: [] })
    ]);

    if (VULNERABLE_ALLOWANCE_MODULE_VERSIONS.includes(String(version))) {
      return {
        usable: false, address,
        reason: `the module reports v${version}, a release whose allowance nonce can overflow and replay past transfers`
      };
    }
    if (!meetsMinimumModuleVersion(String(version))) {
      return { usable: false, address, reason: `the module reports v${version}, below the required v${MINIMUM_ALLOWANCE_MODULE_VERSION}` };
    }
    if (String(name) !== 'Allowance Module') {
      return { usable: false, address, reason: `the contract calls itself ${JSON.stringify(name)}, not "Allowance Module"` };
    }

    return {
      usable: true,
      address,
      version: String(version),
      codeHash,
      canonical: getAddress(CANONICAL_ALLOWANCE_MODULE.address) === address,
      verifiedAt: new Date().toISOString()
    };
  }

  /**
   * A Circle's Safe must be new enough for the module. v1.0.0 calls
   * `execTransactionFromModuleReturnData`, added in Safe v1.1.1 — against anything older every
   * allowance transfer reverts. Circles deploys v1.4.1, so this catches configuration drift.
   */
  assertSafeCompatible(safeVersion) {
    if (compareVersions(String(safeVersion), MINIMUM_SAFE_VERSION_FOR_MODULE) < 0) {
      return {
        ok: false,
        reason: `this Circle runs Safe v${safeVersion}; Allowance Module v${MINIMUM_ALLOWANCE_MODULE_VERSION} `
          + `requires Safe v${MINIMUM_SAFE_VERSION_FOR_MODULE} or newer`
      };
    }
    return { ok: true };
  }

  _off(reason) {
    return { usable: false, address: this.config.circles.allowanceModule || null, reason, disabled: true };
  }
}
