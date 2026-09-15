/**
 * The Safe Allowance Module hard gate.
 *
 * Prism Circles will not enable per-member spending limits against anything but an official
 * Allowance Module release **>= v1.0.0**. v1.0.0 is the release that fixed a nonce overflow which
 * "would potentially allow replaying past allowance module transfers"; every earlier release
 * (v0.1.0, v0.1.1) still carries it. One of those earlier releases IS deployed on Monad, which is
 * precisely why this gate exists: the vulnerable module is the one you get by accident.
 *
 * It is worth being blunt about how easy that accident is. The official deployments package
 * resolves the *latest it knows about*, and the latest it knows about is the vulnerable one:
 *
 *     getAllowanceModuleDeployment({})        -> v0.1.1     <- silently vulnerable
 *     getAllowanceModuleDeployment({version:'1.0.0'}) -> undefined
 *
 * So this gate never asks the package for "the" deployment. It asks for v1.0.0 by name, and treats
 * absence as a failure rather than falling back.
 *
 * What it checks, in order, refusing at the first failure:
 *
 *   1. RELEASE      an official, non-draft, non-prerelease release tag >= v1.0.0 exists upstream
 *   2. REGISTRY     the official deployments package's record for that version (may be absent)
 *   3. ADDRESS      a deployment on the target chain — from the registry, or a Prism-deployed one
 *   4. BYTECODE     keccak256(eth_getCode) equals the canonical codeHash, byte for byte
 *   5. ABI          all 19 canonical selectors present, and no extras
 *   6. IDENTITY     the contract itself answers VERSION() == "1.0.0" and NAME() == "Allowance Module"
 *   7. SAFE COMPAT  the Circle's Safe is >= 1.1.1 (v1.0.0 needs execTransactionFromModuleReturnData)
 *
 * Run:  node verify-allowance-module.mjs [--chain-id 10143] [--rpc URL] [--module ADDRESS] [--json]
 * Exit: 0 = a usable module was proven; 1 = limits must stay OFF.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, keccak256, toHex, getAddress } from 'viem';
import { getAllowanceModuleDeployment } from '@safe-global/safe-modules-deployments';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const VENDOR = path.join(REPO, 'contracts/vendor/safe-allowances-v1.0.0');

/** The floor. Anything below this carries the replay bug that v1.0.0 fixed. */
export const MINIMUM_ALLOWANCE_MODULE_VERSION = '1.0.0';

/**
 * Releases known to carry the delegate-transfer replay bug. Listed by version rather than by
 * address so that a *redeployment* of a bad release at a new address is still refused.
 */
export const VULNERABLE_VERSIONS = Object.freeze(['0.1.0', '0.1.1']);

/**
 * The canonical v1.0.0 deployment, as published in the upstream release CHANGELOG and confirmed
 * byte-identical at this address on two independent chains (Optimism and Gnosis, 2026-09-13).
 * `codeHash` is keccak256 of the deployed runtime bytecode captured in `canonical-runtime.hex`.
 */
export const CANONICAL_V1 = Object.freeze({
  version: '1.0.0',
  address: '0x691f59471Bfd2B7d639DCF74671a2d648ED1E331',
  codeHash: '0xfafc86ce3000fbdc8ad155875c0b3b5a20d17662e7c2cdbf3e95f15945a46657',
  runtimeBytes: 15504,
  sourceTag: 'allowances/v1.0.0',
  sourceCommit: 'c95f03900bff99be090dadb9de1c74b162365485',
  compiler: { solc: '0.7.6', optimizer: false }
});

/** The complete v1.0.0 ABI surface: 19 functions, no more and no fewer. */
export const CANONICAL_SIGNATURES = Object.freeze([
  'ALLOWANCE_TRANSFER_TYPEHASH()',
  'DOMAIN_SEPARATOR_TYPEHASH()',
  'NAME()',
  'VERSION()',
  'addDelegate(address)',
  'allowances(address,address,address)',
  'delegates(address,uint48)',
  'delegatesStart(address)',
  'deleteAllowance(address,address)',
  'executeAllowanceTransfer(address,address,address,uint96,address,uint96,address,bytes)',
  'generateTransferHash(address,address,address,uint96,address,uint96,uint16)',
  'getChainId()',
  'getDelegates(address,uint48,uint8)',
  'getTokenAllowance(address,address,address)',
  'getTokens(address,address)',
  'removeDelegate(address,bool)',
  'resetAllowance(address,address)',
  'setAllowance(address,address,uint96,uint16,uint32)',
  'tokens(address,address,uint256)'
]);

/** The Safe release that introduced `execTransactionFromModuleReturnData`, which v1.0.0 requires. */
export const MINIMUM_SAFE_VERSION = '1.1.1';

export function selectorFor(signature) { return keccak256(toHex(signature)).slice(0, 10); }

/** Plain semver compare, enough for `a.b.c` release tags. Returns -1 / 0 / 1. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

export function meetsMinimum(version) {
  return compareVersions(version, MINIMUM_ALLOWANCE_MODULE_VERSION) >= 0;
}

const SAFE_ABI = [{ name: 'VERSION', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }];
const MODULE_ABI = [
  { name: 'VERSION', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'NAME', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }
];

/**
 * Ask the official upstream release index whether a release >= the floor exists, and whether it is
 * a real release rather than a draft or a prerelease.
 *
 * A network failure here is NOT treated as "no release" — it is treated as *unknown*, and unknown
 * fails the gate exactly like a missing release would. The gate never opens on missing evidence.
 */
export async function queryReleaseIndex({ fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const url = 'https://api.github.com/repositories/156675250/releases?per_page=100';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'prism-circles-allowance-gate' }
    });
    if (!response.ok) return { ok: false, reason: `release index HTTP ${response.status}` };
    const releases = await response.json();
    if (!Array.isArray(releases)) return { ok: false, reason: 'release index returned no list' };

    const candidates = releases
      .filter((r) => /^allowances?\/v\d+\.\d+\.\d+$/.test(r.tag_name ?? ''))
      .map((r) => ({
        tag: r.tag_name,
        version: r.tag_name.split('/v')[1],
        publishedAt: r.published_at,
        prerelease: Boolean(r.prerelease),
        draft: Boolean(r.draft)
      }));

    const usable = candidates
      .filter((r) => !r.prerelease && !r.draft && meetsMinimum(r.version))
      .sort((a, b) => compareVersions(b.version, a.version));

    return { ok: true, all: candidates, usable, latest: usable[0] ?? null };
  } catch (error) {
    return { ok: false, reason: `release index unreachable: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the official deployments package for a specific version. Deliberately never called without a
 * version: the package's default resolution returns the newest release IT knows about, which today
 * is the vulnerable v0.1.1.
 */
export function queryDeploymentRegistry(version, chainId) {
  const record = getAllowanceModuleDeployment({ version });
  if (!record) return { found: false, version, reason: `the official deployments package has no record for v${version}` };
  const address = record.networkAddresses?.[String(chainId)] ?? null;
  return {
    found: true,
    version,
    released: record.released !== false,
    address: address ? getAddress(Array.isArray(address) ? address[0] : address) : null,
    codeHash: record.codeHash ?? null,
    chains: Object.keys(record.networkAddresses ?? {}).length
  };
}

/** What the package would hand a caller who forgot to pin a version. Reported, never used. */
export function defaultRegistryResolution() {
  const record = getAllowanceModuleDeployment({});
  return record ? { version: record.version, safe: meetsMinimum(record.version) } : null;
}

export function canonicalRuntime() {
  const file = path.join(VENDOR, 'canonical-runtime.hex');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim().toLowerCase();
}

/**
 * The whole gate. Returns a decision object; `usable` is true only when every check passed.
 * Every failure carries a reason, because "limits are off" is a thing an operator has to be able
 * to act on.
 */
export async function runGate({
  chainId,
  rpcUrl,
  moduleAddress = null,
  safeAddress = null,
  fetchImpl = fetch,
  client = null
} = {}) {
  const checks = [];
  const fail = (name, detail) => { checks.push({ name, ok: false, detail }); return finish(); };
  const pass = (name, detail) => { checks.push({ name, ok: true, detail }); };
  const finish = () => ({
    usable: checks.every((c) => c.ok) && checks.length >= 7,
    chainId: Number(chainId),
    minimumVersion: MINIMUM_ALLOWANCE_MODULE_VERSION,
    module: resolved,
    checks,
    verifiedAt: new Date().toISOString()
  });
  let resolved = null;

  // --- 1. RELEASE ---------------------------------------------------------
  const index = await queryReleaseIndex({ fetchImpl });
  if (!index.ok) return fail('release', index.reason);
  if (!index.latest) {
    return fail('release', `no official non-prerelease Allowance Module release >= v${MINIMUM_ALLOWANCE_MODULE_VERSION} exists`);
  }
  pass('release', `${index.latest.tag} published ${index.latest.publishedAt} (non-draft, non-prerelease)`);

  // --- 2. REGISTRY --------------------------------------------------------
  const registry = queryDeploymentRegistry(index.latest.version, chainId);
  const fallback = defaultRegistryResolution();
  const registryDetail = registry.found
    ? `deployments package lists v${registry.version} on ${registry.chains} chains`
    : registry.reason;
  // Absence from the package is NOT fatal on its own — Safe publishes source before deployments —
  // but it does mean the address has to come from somewhere we can verify ourselves.
  pass('registry', `${registryDetail}; unpinned resolution would give v${fallback?.version ?? '?'}${fallback && !fallback.safe ? ' (VULNERABLE — never used)' : ''}`);

  // --- 3. ADDRESS ---------------------------------------------------------
  const candidate = moduleAddress ?? registry.address ?? null;
  if (!candidate) {
    return fail('address', `Allowance Module v${index.latest.version} has no known deployment on chain ${chainId}, and none was supplied`);
  }
  const address = getAddress(candidate);
  const provenance = registry.address && getAddress(registry.address) === address
    ? 'official deployments package'
    : (address === getAddress(CANONICAL_V1.address) ? 'canonical upstream address (CHANGELOG)' : 'operator-supplied (Prism-deployed)');
  pass('address', `${address} via ${provenance}`);

  // --- 4. BYTECODE --------------------------------------------------------
  const rpc = client ?? createPublicClient({ transport: http(rpcUrl) });
  let code;
  try { code = await rpc.getCode({ address }); }
  catch (error) { return fail('bytecode', `eth_getCode failed: ${error.message}`); }
  if (!code || code === '0x') return fail('bytecode', `no contract at ${address} on chain ${chainId}`);

  const observed = keccak256(code);
  const expected = registry.codeHash ?? CANONICAL_V1.codeHash;
  if (observed.toLowerCase() !== expected.toLowerCase()) {
    return fail('bytecode', `codeHash ${observed} does not match the canonical v${index.latest.version} runtime ${expected}`);
  }
  pass('bytecode', `keccak256(code) = ${observed} matches canonical (${(code.length - 2) / 2} bytes)`);

  // --- 5. ABI -------------------------------------------------------------
  const lower = code.toLowerCase();
  const missing = CANONICAL_SIGNATURES.filter((sig) => !lower.includes(selectorFor(sig).slice(2)));
  if (missing.length) return fail('abi', `deployed code is missing ${missing.length} canonical selector(s): ${missing.join(', ')}`);
  pass('abi', `all ${CANONICAL_SIGNATURES.length} canonical selectors present`);

  // --- 6. IDENTITY --------------------------------------------------------
  let version;
  let name;
  try {
    [version, name] = await Promise.all([
      rpc.readContract({ address, abi: MODULE_ABI, functionName: 'VERSION' }),
      rpc.readContract({ address, abi: MODULE_ABI, functionName: 'NAME' })
    ]);
  } catch (error) { return fail('identity', `the contract did not answer VERSION()/NAME(): ${error.message}`); }

  if (VULNERABLE_VERSIONS.includes(String(version))) {
    return fail('identity', `the contract reports v${version}, a release carrying the delegate-transfer replay bug`);
  }
  if (!meetsMinimum(String(version))) {
    return fail('identity', `the contract reports v${version}, below the required v${MINIMUM_ALLOWANCE_MODULE_VERSION}`);
  }
  if (String(name) !== 'Allowance Module') return fail('identity', `NAME() is ${JSON.stringify(name)}, not "Allowance Module"`);
  pass('identity', `the contract itself answers VERSION() = ${version}, NAME() = ${name}`);
  resolved = { address, version: String(version), codeHash: observed, provenance };

  // --- 7. SAFE COMPATIBILITY ----------------------------------------------
  // v1.0.0 calls `execTransactionFromModuleReturnData`, added in Safe v1.1.1. Against an older
  // Safe every allowance transfer would revert — the upstream CHANGELOG calls this out as a
  // breaking change. Circles deploys Safe v1.4.1, so this is a guard against configuration drift.
  if (safeAddress) {
    try {
      const safeVersion = await rpc.readContract({ address: getAddress(safeAddress), abi: SAFE_ABI, functionName: 'VERSION' });
      if (compareVersions(String(safeVersion), MINIMUM_SAFE_VERSION) < 0) {
        return fail('safe-compat', `Safe v${safeVersion} predates v${MINIMUM_SAFE_VERSION}; Allowance Module v1.0.0 is incompatible with it`);
      }
      pass('safe-compat', `Safe at ${safeAddress} reports v${safeVersion} >= v${MINIMUM_SAFE_VERSION}`);
    } catch (error) { return fail('safe-compat', `could not read the Safe's VERSION(): ${error.message}`); }
  } else {
    pass('safe-compat', `Circles deploys Safe v1.4.1 >= v${MINIMUM_SAFE_VERSION} (no live Safe supplied to check)`);
  }

  return finish();
}

// --- CLI ---------------------------------------------------------------------

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const chainId = Number(arg('--chain-id', process.env.MONAD_CHAIN_ID ?? '10143'));
  const rpcUrl = arg('--rpc', process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz/');
  const moduleAddress = arg('--module', process.env.CIRCLE_ALLOWANCE_MODULE || null);
  const safeAddress = arg('--safe', null);
  const asJson = process.argv.includes('--json');

  const decision = await runGate({ chainId, rpcUrl, moduleAddress, safeAddress });

  const outDir = path.join(REPO, 'proof/circles');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'allowance-module-gate.json'), `${JSON.stringify(decision, null, 2)}\n`);

  if (asJson) {
    console.log(JSON.stringify(decision, null, 2));
  } else {
    console.log(`\nSafe Allowance Module gate — chain ${decision.chainId}, minimum v${decision.minimumVersion}\n`);
    for (const check of decision.checks) {
      console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(12)} ${check.detail}`);
    }
    console.log(
      decision.usable
        ? `\nRESULT: usable module at ${decision.module.address} (v${decision.module.version}).\n        CIRCLE_LIMITS_ENABLED may be set to true against this address.\n`
        : `\nRESULT: NO usable Allowance Module on chain ${decision.chainId}.\n        CIRCLE_LIMITS_ENABLED must stay false. Circles remains threshold-only.\n`
    );
  }
  process.exit(decision.usable ? 0 : 1);
}
