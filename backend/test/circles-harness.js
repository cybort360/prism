/**
 * Test harness for Prism Circles.
 *
 * The fake here is the *chain*, not the adapter. Tests run the real SafeCircleAdapter and the real
 * CircleService against an in-memory Safe that behaves like the deployed one: it decodes the setup
 * initializer, stores the owner set and threshold it was actually given, and answers reads from that
 * state. So a test that asserts "the wrong owner set is rejected" is exercising Prism's genuine
 * encoding, prediction and verification path — only the RPC is simulated.
 *
 * Every deviation a negative test needs (a different chainId, a tampered owner set, a Safe that
 * reports a different transaction hash) is a knob on the fake chain rather than a stubbed-out method
 * on the adapter, so the code under test is the same code that runs in production.
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '../src/lib/crypto.js';

// Set at module load, before anything imports config.js — the test runner gives each file its own
// process, so this is the whole environment for the suite that imported us.
process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;

export const SAFE_SINGLETON = '0x41675C099F32341bf84BFc5382aF534df5C7461a';
export const SAFE_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
export const SAFE_FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

const SETUP_ABI = [{
  name: 'setup', type: 'function', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' }
  ]
}];

/** A minimal but faithful in-memory Safe deployment. */
export function fakeSafeChain({ chainId = 10143, usdc }) {
  const safes = new Map();          // address -> { owners, threshold, version, nonce }
  const receipts = new Map();       // txHash -> { status }
  const balances = new Map();       // address -> bigint
  const calls = { deployments: 0, writes: [] };

  // Deterministic stand-in for the factory's real creation code. The adapter reads it from the
  // factory rather than hardcoding it, so any consistent value exercises the same prediction path.
  const proxyCreationCode = `0x${'60'.repeat(32)}`;

  const knobs = {
    reportChainId: chainId,
    overrideOwners: null,       // deploy a different owner set than requested
    overrideThreshold: null,
    overrideVersion: null,
    txHashDisagreement: false,  // make the Safe report a different digest than Prism computes
    deploymentReverts: false,
    receiptPending: false,
    readFails: false
  };

  // SafeProxyFactory's address derivation, spelled out independently of the adapter's copy so a
  // mistake in Prism's prediction shows up here as a Safe that deployed somewhere else.
  //   salt     = keccak256(keccak256(initializer) ++ uint256(saltNonce))
  //   initCode = proxyCreationCode ++ abi.encode(singleton)
  //   address  = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
  function predict(singleton, initializer, saltNonce) {
    const bytes = (hex) => hex.slice(2);
    const word = (value) => BigInt(value).toString(16).padStart(64, '0');
    const salt = keccak256(`0x${bytes(keccak256(initializer))}${word(saltNonce)}`);
    const initCode = `0x${bytes(proxyCreationCode)}${word(BigInt(getAddress(singleton)))}`;
    const hash = keccak256(`0xff${bytes(getAddress(SAFE_PROXY_FACTORY))}${bytes(salt)}${bytes(keccak256(initCode))}`);
    return getAddress(`0x${hash.slice(-40)}`);
  }

  const chain = {
    async getChainId() { return knobs.reportChainId; },

    async readContract({ address, functionName, args }) {
      if (knobs.readFails) throw new Error('rpc unavailable');
      if (functionName === 'proxyCreationCode') return proxyCreationCode;
      if (functionName === 'balanceOf') return balances.get(getAddress(args[0]).toLowerCase()) ?? 0n;

      const safe = safes.get(getAddress(address).toLowerCase());
      if (!safe) throw new Error(`no contract at ${address}`);
      switch (functionName) {
        case 'getOwners': return safe.owners;
        case 'getThreshold': return BigInt(safe.threshold);
        case 'nonce': return BigInt(safe.nonce);
        case 'VERSION': return safe.version;
        case 'isOwner': return safe.owners.map((o) => o.toLowerCase()).includes(getAddress(args[0]).toLowerCase());
        case 'getTransactionHash':
          // The Safe's own answer. When `txHashDisagreement` is set it returns something else, which
          // is exactly the drift the adapter's cross-check exists to catch.
          return knobs.txHashDisagreement ? keccak256(toHex('a different transaction entirely')) : null;
        default: throw new Error(`fake safe: unexpected read ${functionName}`);
      }
    },

    async writeContract({ functionName, args }) {
      calls.writes.push(functionName);
      if (functionName === 'createProxyWithNonce') {
        const [singleton, initializer, saltNonce] = args;
        const address = predict(singleton, initializer, saltNonce);
        const txHash = keccak256(toHex(`deploy:${address}`));
        if (knobs.deploymentReverts) { receipts.set(txHash, { status: 'reverted' }); return txHash; }

        const { args: setupArgs } = decodeFunctionData({ abi: SETUP_ABI, data: initializer });
        const [owners, threshold] = setupArgs;
        calls.deployments++;
        safes.set(address.toLowerCase(), {
          address,
          singleton: getAddress(singleton),
          owners: (knobs.overrideOwners ?? owners).map((o) => getAddress(o)),
          threshold: Number(knobs.overrideThreshold ?? threshold),
          version: knobs.overrideVersion ?? '1.4.1',
          nonce: 0
        });
        receipts.set(txHash, { status: 'success', blockNumber: 1000n + BigInt(calls.deployments) });
        return txHash;
      }
      if (functionName === 'execTransaction') {
        const txHash = keccak256(toHex(`exec:${calls.writes.length}`));
        receipts.set(txHash, { status: 'success', blockNumber: 2000n });
        return txHash;
      }
      throw new Error(`fake safe: unexpected write ${functionName}`);
    },

    async getReceipt(hash) { return knobs.receiptPending ? null : (receipts.get(hash) ?? null); }
  };

  return {
    chain, knobs, calls,
    /** Inspect the deployed Safe for assertions. */
    safeAt: (address) => safes.get(getAddress(address).toLowerCase()) ?? null,
    /** Fund a Circle so a balance read has something to return. */
    setBalance: (address, amount) => balances.set(getAddress(address).toLowerCase(), BigInt(amount)),
    /** Simulate an approved owner change landing on-chain, out from under Prism. */
    forceOwners: (address, owners, threshold) => {
      const safe = safes.get(getAddress(address).toLowerCase());
      safe.owners = owners.map((o) => getAddress(o));
      if (threshold !== undefined) safe.threshold = threshold;
    },
    bumpNonce: (address, to) => { safes.get(getAddress(address).toLowerCase()).nonce = to; }
  };
}

/** A temp-file JsonStore, as every other suite in this repo uses. */
export function tempStore(JsonStore) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-circles-')), 'store.json');
  return new JsonStore(file);
}

/**
 * A complete Circle stack: real IdentityService, real SafeCircleAdapter, real CircleService, and the
 * fake chain above. Returns the knobs so a test can make the chain misbehave.
 */
export async function circleStack() {
  const { config } = await import('../src/config.js');
  const { JsonStore } = await import('../src/lib/jsonStore.js');
  const { IdentityService } = await import('../src/services/identityService.js');
  const { CircleService } = await import('../src/services/circleService.js');
  const { SafeCircleAdapter } = await import('../src/circles/safeCircleAdapter.js');

  const store = tempStore(JsonStore);
  const fake = fakeSafeChain({ chainId: Number(config.chain.chainId), usdc: config.chain.usdc });
  const identityService = new IdentityService({ store, config });
  const safeAdapter = new SafeCircleAdapter({ config, chain: fake.chain, txService: null });
  const circles = new CircleService({ store, config, identityService, safeAdapter });
  return { store, config, identityService, safeAdapter, circles, fake };
}

let keyCounter = 0;
/** Create a real Prism identity bound to a fresh Mera-style account, as onboarding would. */
export async function makeIdentity(identityService, { name, handle } = {}) {
  keyCounter += 1;
  const account = privateKeyToAccount(`0x${String(keyCounter).padStart(2, '0').repeat(32)}`);
  const { nonce } = identityService.issueBindingChallenge();
  const bindingProof = await account.signMessage({
    message: canonicalJson({ action: 'bind_account', account: account.address.toLowerCase(), nonce })
  });
  const identity = await identityService.createDeviceIdentity({
    account: account.address, bindingProof, requestedHandle: handle, challengeNonce: nonce
  });
  if (name) identityService.setProfile(identity.prismId, { displayName: name });
  return { ...identityService.get(identity.prismId), account };
}

/** The acknowledgement a creator must send; mirrors what the creation sheet would have shown. */
export function acknowledgement({ threshold, adminCount, warnings = [] }) {
  return { threshold, adminCount, acknowledgedWarnings: warnings };
}
