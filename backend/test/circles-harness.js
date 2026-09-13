/**
 * Test harness for Prism Circles.
 *
 * The fake here is the *chain*, not the adapter. Tests run the real SafeCircleAdapter, the real
 * CircleService and the real PaymentService against an in-memory Monad that behaves like the
 * deployed one: it decodes the setup initializer, stores the owner set and threshold it was actually
 * given, keeps a single USDC ledger, and — this is the part that makes the payment tests mean
 * anything — implements `execTransaction` with Safe's real rules. It recomputes the digest from the
 * arguments it was handed, recovers every signature, requires strictly ascending owner order,
 * requires each signer to be an owner *right now*, requires the nonce to be the Safe's next nonce,
 * and only then performs the inner call and emits the logs a real Safe would.
 *
 * Two consequences worth stating, because several tests depend on them:
 *
 *  - Prism's Safe encoding is never used to check Prism's Safe encoding. The digest, the CREATE2
 *    address and the event topics are all derived independently here, from the type strings and the
 *    factory formula, so a mistake in `safeEncoding.js` shows up as a Safe that rejects the
 *    signatures or deploys somewhere else.
 *  - The router and the Safe share ONE USDC ledger. A contribution really moves a balance that the
 *    Circle then reads back, and a Circle payment really debits it. "The balance went up" is an
 *    observation, not an assertion.
 *
 * Every deviation a negative test needs (a different chainId, a tampered owner set, a Safe that
 * reports a different transaction hash) is a knob on the fake chain rather than a stubbed-out method
 * on the adapter, so the code under test is the same code that runs in production.
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {
  decodeFunctionData, encodeAbiParameters, getAddress, keccak256, toHex, toBytes,
  toEventSelector, padHex, recoverAddress
} from 'viem';
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

// --- independent derivations -------------------------------------------------
// Derived here from the canonical strings rather than imported from the code under test, so the
// suite is checking Prism's encoding rather than agreeing with it.

const DOMAIN_TYPEHASH = keccak256(toBytes('EIP712Domain(uint256 chainId,address verifyingContract)'));
const SAFE_TX_TYPEHASH = keccak256(toBytes(
  'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)'
));
const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)');
const EXEC_SUCCESS_TOPIC = toEventSelector('ExecutionSuccess(bytes32,uint256)');
const EXEC_FAILURE_TOPIC = toEventSelector('ExecutionFailure(bytes32,uint256)');
const TRANSFER_SELECTOR = '0xa9059cbb';

/** Safe's own EIP-712 digest, spelled out independently of `safeEncoding.js`. */
function safeDigest({ chainId, safeAddress, tx }) {
  const domain = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [DOMAIN_TYPEHASH, BigInt(chainId), getAddress(safeAddress)]
  ));
  const struct = keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }
    ],
    [
      SAFE_TX_TYPEHASH, getAddress(tx.to), BigInt(tx.value), keccak256(tx.data), Number(tx.operation),
      BigInt(tx.safeTxGas), BigInt(tx.baseGas), BigInt(tx.gasPrice),
      getAddress(tx.gasToken), getAddress(tx.refundReceiver), BigInt(tx.nonce)
    ]
  ));
  return keccak256(`0x1901${domain.slice(2)}${struct.slice(2)}`);
}

const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressTopic = (address) => padHex(getAddress(address).toLowerCase(), { size: 32 });

/** A minimal but faithful in-memory Monad: one USDC ledger, one router, and real Safes. */
export function fakeSafeChain({ chainId = 10143, usdc, router }) {
  const safes = new Map();          // address -> { owners, threshold, version, nonce }
  const receipts = new Map();       // txHash -> { status, blockNumber, logs }
  const balances = new Map();       // address -> bigint
  const usedAuthorizations = new Set(); // `${authorizer}:${nonce}` — the ERC-3009 nonce namespace
  const calls = { deployments: 0, writes: [], executions: [] };
  let block = 1000n;

  const usdcAddress = getAddress(usdc);
  const routerAddress = router ? getAddress(router) : null;

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
    readFails: false,
    // Make the Safe accept the transaction but let the inner USDC call fail, which is how a real
    // Safe produces `status: success` with an `ExecutionFailure` log and no Transfer.
    innerCallFails: false
  };

  // SafeProxyFactory's address derivation, spelled out independently of the adapter's copy so a
  // mistake in Prism's prediction shows up here as a Safe that deployed somewhere else.
  //   salt     = keccak256(keccak256(initializer) ++ uint256(saltNonce))
  //   initCode = proxyCreationCode ++ abi.encode(singleton)
  //   address  = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
  function predict(singleton, initializer, saltNonce) {
    const bytes = (hex) => hex.slice(2);
    const salt = keccak256(`0x${bytes(keccak256(initializer))}${word(saltNonce)}`);
    const initCode = `0x${bytes(proxyCreationCode)}${word(BigInt(getAddress(singleton)))}`;
    const hash = keccak256(`0xff${bytes(getAddress(SAFE_PROXY_FACTORY))}${bytes(salt)}${bytes(keccak256(initCode))}`);
    return getAddress(`0x${hash.slice(-40)}`);
  }

  const balanceOf = (address) => balances.get(getAddress(address).toLowerCase()) ?? 0n;
  const credit = (address, amount) => balances.set(getAddress(address).toLowerCase(), balanceOf(address) + BigInt(amount));
  const debit = (address, amount) => balances.set(getAddress(address).toLowerCase(), balanceOf(address) - BigInt(amount));
  const transferLog = (from, to, amount) => ({
    address: usdcAddress, topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)], data: `0x${word(amount)}`
  });

  /** `transfer(address,uint256)` and nothing else — the only inner call a Circle ever makes. */
  function decodeTransfer(data) {
    const hex = String(data ?? '');
    if (hex.length !== 138 || hex.slice(0, 10).toLowerCase() !== TRANSFER_SELECTOR) return null;
    return { to: getAddress(`0x${hex.slice(34, 74)}`), amount: BigInt(`0x${hex.slice(74)}`) };
  }

  /**
   * Safe's `checkNSignatures`, as it really behaves: fixed 65-byte words, each recovered over the
   * transaction's own digest, in STRICTLY ascending owner order, every signer an owner right now,
   * and at least `threshold` of them.
   */
  async function checkSignatures(safe, digest, signatures) {
    const blob = String(signatures ?? '0x').slice(2);
    if (blob.length % 130 !== 0) throw new Error('GS021: malformed signatures');
    const count = blob.length / 130;
    if (count < safe.threshold) throw new Error('GS020: not enough signatures');
    const owners = safe.owners.map((o) => getAddress(o).toLowerCase());
    let last = '';
    for (let i = 0; i < safe.threshold; i++) {
      const signature = `0x${blob.slice(i * 130, (i + 1) * 130)}`;
      const v = parseInt(signature.slice(130, 132), 16);
      if (v !== 27 && v !== 28) throw new Error('GS024: unsupported signature type');
      const recovered = await recoverAddress({ hash: digest, signature }).catch(() => null);
      if (!recovered) throw new Error('GS026: invalid owner signature');
      const signer = recovered.toLowerCase();
      if (!owners.includes(signer)) throw new Error('GS026: invalid owner provided');
      if (!(signer > last)) throw new Error('GS026: signatures are not in ascending owner order');
      last = signer;
    }
    return true;
  }

  /** The whole of `execTransaction`, shared by simulation and submission. */
  async function runExecTransaction(address, args, { commit }) {
    const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = args;
    const safe = safes.get(getAddress(address).toLowerCase());
    if (!safe) throw new Error(`no contract at ${address}`);
    const tx = { to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce: safe.nonce };

    // Safe hashes with ITS OWN current nonce. A transaction built against a different nonce
    // therefore produces a different digest and the signatures simply do not verify — which is
    // exactly how a Safe rejects a nonce replay.
    const digest = safeDigest({ chainId: knobs.reportChainId, safeAddress: safe.address, tx });
    await checkSignatures(safe, digest, signatures);

    const logs = [];
    let innerOk = true;
    if (knobs.innerCallFails) {
      innerOk = false;
    } else if (getAddress(to) === usdcAddress) {
      const call = decodeTransfer(data);
      if (!call) innerOk = false;
      else if (balanceOf(safe.address) < call.amount) innerOk = false;
      else if (commit) {
        debit(safe.address, call.amount);
        credit(call.to, call.amount);
        logs.push(transferLog(safe.address, call.to, call.amount));
      } else {
        logs.push(transferLog(safe.address, call.to, call.amount));
      }
    } else {
      // Owner management: the Safe calling itself. Applied only so governance execution can be
      // exercised end to end; the payment tests never take this branch.
      innerOk = getAddress(to) === getAddress(safe.address);
    }

    logs.push({
      address: safe.address,
      topics: [innerOk ? EXEC_SUCCESS_TOPIC : EXEC_FAILURE_TOPIC, digest],
      data: `0x${word(0)}`
    });
    if (commit) {
      safe.nonce += 1;
      calls.executions.push({ safeAddress: safe.address, digest, innerOk });
    }
    return { digest, logs, innerOk };
  }

  async function runSettle(args) {
    // PrismPaymentRouter.settle(envelope, prismSignature, v, r, s). The fake enforces only what the
    // Circle tests depend on: one-shot nonces and a real balance movement.
    const [envelope] = args;
    const payer = getAddress(envelope.payer);
    const recipient = getAddress(envelope.recipient);
    const amount = BigInt(envelope.amount);
    const key = `${payer.toLowerCase()}:${String(envelope.nonce).toLowerCase()}`;
    if (usedAuthorizations.has(key)) throw new Error('NonceAlreadyUsed');
    if (balanceOf(payer) < amount) throw new Error('ERC20: transfer amount exceeds balance');
    return {
      apply() {
        usedAuthorizations.add(key);
        debit(payer, amount);
        credit(recipient, amount);
      },
      logs: [transferLog(payer, recipient, amount)]
    };
  }

  function mine(seed, logs, status = 'success') {
    const txHash = keccak256(toHex(seed));
    block += 1n;
    receipts.set(txHash, { status, transactionHash: txHash, blockNumber: block, logs });
    return txHash;
  }

  const chain = {
    async getChainId() { return knobs.reportChainId; },
    async getBalance() { return 0n; },              // members hold MON = 0; the relayer pays gas

    async readContract({ address, functionName, args }) {
      if (knobs.readFails) throw new Error('rpc unavailable');
      if (functionName === 'proxyCreationCode') return proxyCreationCode;
      if (functionName === 'balanceOf') return balanceOf(args[0]);
      if (functionName === 'authorizationState') return usedAuthorizations.has(`${getAddress(args[0]).toLowerCase()}:${String(args[1]).toLowerCase()}`);
      if (functionName === 'DOMAIN_SEPARATOR') return keccak256(toHex('fake usdc domain'));

      const safe = safes.get(getAddress(address).toLowerCase());
      if (!safe) throw new Error(`no contract at ${address}`);
      switch (functionName) {
        case 'getOwners': return safe.owners;
        case 'getThreshold': return BigInt(safe.threshold);
        case 'nonce': return BigInt(safe.nonce);
        case 'VERSION': return safe.version;
        case 'isOwner': return safe.owners.map((o) => o.toLowerCase()).includes(getAddress(args[0]).toLowerCase());
        case 'getTransactionHash': {
          // The Safe's own answer, computed independently above. When `txHashDisagreement` is set it
          // returns something else, which is exactly the drift the adapter's cross-check catches.
          if (knobs.txHashDisagreement) return keccak256(toHex('a different transaction entirely'));
          const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce] = args;
          return safeDigest({
            chainId: knobs.reportChainId, safeAddress: safe.address,
            tx: { to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce }
          });
        }
        default: throw new Error(`fake safe: unexpected read ${functionName}`);
      }
    },

    /** Dry run. Reverts surface here as thrown errors, exactly as viem's simulateContract does. */
    async simulateContract({ address, functionName, args }) {
      if (functionName === 'execTransaction') {
        const { innerOk } = await runExecTransaction(address, args, { commit: false });
        return { result: innerOk, request: { address, functionName, args } };
      }
      if (functionName === 'settle') {
        await runSettle(args);
        return { result: undefined, request: { address, functionName, args } };
      }
      return { request: { address, functionName, args } };
    },

    async estimateContractGas() { return 120000n; },

    async writeContract({ address, functionName, args }) {
      calls.writes.push(functionName);
      if (functionName === 'createProxyWithNonce') {
        const [singleton, initializer, saltNonce] = args;
        const safeAddress = predict(singleton, initializer, saltNonce);
        if (knobs.deploymentReverts) return mine(`deploy:${safeAddress}`, [], 'reverted');

        const { args: setupArgs } = decodeFunctionData({ abi: SETUP_ABI, data: initializer });
        const [owners, threshold] = setupArgs;
        calls.deployments++;
        safes.set(safeAddress.toLowerCase(), {
          address: safeAddress,
          singleton: getAddress(singleton),
          owners: (knobs.overrideOwners ?? owners).map((o) => getAddress(o)),
          threshold: Number(knobs.overrideThreshold ?? threshold),
          version: knobs.overrideVersion ?? '1.4.1',
          nonce: 0
        });
        return mine(`deploy:${safeAddress}`, []);
      }
      if (functionName === 'execTransaction') {
        const { logs } = await runExecTransaction(address, args, { commit: true });
        return mine(`exec:${calls.writes.length}:${address}`, logs);
      }
      if (functionName === 'settle') {
        const settlement = await runSettle(args);
        settlement.apply();
        return mine(`settle:${calls.writes.length}`, settlement.logs);
      }
      throw new Error(`fake safe: unexpected write ${functionName}`);
    },

    async getReceipt(hash) { return knobs.receiptPending ? null : (receipts.get(hash) ?? null); },
    async getTransactionReceipt(hash) { return chain.getReceipt(hash); }
  };

  /** The same fake, shaped as Prism's ChainProvider so the router path shares this USDC ledger. */
  const provider = {
    name: 'fake-monad', chainId, rpcHost: 'fake',
    getChainId: chain.getChainId, getBalance: chain.getBalance,
    readContract: chain.readContract, simulateContract: chain.simulateContract,
    estimateContractGas: chain.estimateContractGas, writeContract: chain.writeContract,
    getTransactionReceipt: chain.getTransactionReceipt
  };

  return {
    chain, provider, knobs, calls,
    usdcAddress, routerAddress,
    /** Inspect the deployed Safe for assertions. */
    safeAt: (address) => safes.get(getAddress(address).toLowerCase()) ?? null,
    /** Fund any account so a balance read has something to return. */
    setBalance: (address, amount) => balances.set(getAddress(address).toLowerCase(), BigInt(amount)),
    balanceOf,
    receiptFor: (hash) => receipts.get(hash) ?? null,
    /** Simulate an approved owner change landing on-chain, out from under Prism. */
    forceOwners: (address, owners, threshold) => {
      const safe = safes.get(getAddress(address).toLowerCase());
      safe.owners = owners.map((o) => getAddress(o));
      if (threshold !== undefined) safe.threshold = threshold;
    },
    bumpNonce: (address, to) => { safes.get(getAddress(address).toLowerCase()).nonce = to; },
    safeDigest
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
 *
 * `withPayments` additionally wires the real PaymentService and points Prism's global chain provider
 * at the same fake, so contributions settle through the real router path against the same USDC
 * ledger the Circle's balance is read from.
 */
export async function circleStack({ withPayments = false } = {}) {
  const { config } = await import('../src/config.js');
  const { JsonStore } = await import('../src/lib/jsonStore.js');
  const { IdentityService } = await import('../src/services/identityService.js');
  const { CircleService } = await import('../src/services/circleService.js');
  const { SafeCircleAdapter } = await import('../src/circles/safeCircleAdapter.js');

  const store = tempStore(JsonStore);
  const fake = fakeSafeChain({
    chainId: Number(config.chain.chainId), usdc: config.chain.usdc, router: config.chain.paymentRouter
  });
  const identityService = new IdentityService({ store, config });
  const safeAdapter = new SafeCircleAdapter({ config, chain: fake.chain, txService: null });

  let paymentService = null;
  let resolverService = null;
  let restoreProvider = () => {};
  if (withPayments) {
    const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
    const { KeyService } = await import('../src/services/keyService.js');
    const { ClaimService } = await import('../src/services/claimService.js');
    const { RequestService } = await import('../src/services/requestService.js');
    const { ResolverService } = await import('../src/services/resolverService.js');
    const { PaymentService } = await import('../src/services/paymentService.js');
    setChainProvider(fake.provider);
    restoreProvider = resetChainProvider;
    const keyService = new KeyService(store, config);
    resolverService = new ResolverService({ store, config, keyService, identityService });
    paymentService = new PaymentService({
      store, config, identityService,
      claimService: new ClaimService({ store, config, identityService }),
      resolverService,
      requestService: new RequestService({ store, identityService, config })
    });
  }

  const circles = new CircleService({ store, config, identityService, safeAdapter, paymentService });
  return { store, config, identityService, safeAdapter, circles, fake, paymentService, resolverService, restoreProvider };
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

/**
 * Sign and settle a contribution exactly as the app would: the contributor's Mera account signs both
 * the Prism envelope and the ERC-3009 receive-authorization, then the relayer submits.
 */
export async function contribute({ circles, circleId, member, amountAtomic }) {
  const prepared = await circles.prepareContribution({ circleId, prismId: member.prismId, amountAtomic });
  const prismSignature = await member.account.signTypedData(revive(prepared.typedData.envelope));
  const tokenSignature = await member.account.signTypedData(revive(prepared.typedData.tokenAuthorization));
  return circles.submitContribution({
    circleId, contributionId: prepared.contribution.contributionId,
    prismId: member.prismId, prismSignature, tokenSignature
  });
}

/** Typed data crosses the API as JSON; numeric fields come back as strings. viem wants bigints. */
function revive(typed) {
  const message = { ...typed.message };
  for (const field of typed.types[typed.primaryType] ?? []) {
    if (/^uint/.test(field.type)) message[field.name] = BigInt(message[field.name]);
  }
  return { ...typed, domain: { ...typed.domain, chainId: Number(typed.domain.chainId) }, message };
}

/** Resolve a recipient through the real Protected Alias Resolver, as the Send sheet would. */
export function resolveRecipient({ resolverService, requesterPrismId, target }) {
  return resolverService.resolvePrismId(requesterPrismId, target.prismId);
}
