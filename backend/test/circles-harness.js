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
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * Safe's canonical Allowance Module v1.0.0. The fake serves its REAL deployed runtime bytecode at
 * this address, read from the vendored capture, so the backend's module gate — which identifies a
 * module by `keccak256(eth_getCode)` — is exercised against the genuine article rather than waved
 * through. The module's *behaviour* is simulated below; its *identity* is not.
 *
 * The contract-level security properties (replay, over-limit, wrong token, removed delegate, and
 * what a delegate structurally cannot do) are proven against the real bytecode in Foundry —
 * `contracts/test/AllowanceModuleCompat.t.sol`. What the JS fake exists to exercise is the
 * BACKEND's behaviour around it: the gate, the governance flow, the readback, freshness.
 */
export const ALLOWANCE_MODULE = '0x691f59471Bfd2B7d639DCF74671a2d648ED1E331';

const CANONICAL_RUNTIME = fsSync.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/vendor/safe-allowances-v1.0.0/canonical-runtime.hex'),
  'utf8'
).trim();

// Derived independently, as everything else in this harness is.
const ALLOWANCE_DOMAIN_TYPEHASH = keccak256(toBytes('EIP712Domain(uint256 chainId,address verifyingContract)'));
const ALLOWANCE_TRANSFER_TYPEHASH = keccak256(toBytes(
  'AllowanceTransfer(address safe,address token,address to,uint96 amount,address paymentToken,uint96 payment,uint16 nonce)'
));

export const RELAYER = '0x000000000000000000000000000000000000F00D';
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
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);
const SELECTOR = {
  addDelegate: sel('addDelegate(address)'),
  removeDelegate: sel('removeDelegate(address,bool)'),
  setAllowance: sel('setAllowance(address,address,uint96,uint16,uint32)'),
  deleteAllowance: sel('deleteAllowance(address,address)'),
  enableModule: sel('enableModule(address)'),
  addOwnerWithThreshold: sel('addOwnerWithThreshold(address,uint256)'),
  removeOwner: sel('removeOwner(address,address,uint256)'),
  changeThreshold: sel('changeThreshold(uint256)')
};

/** The address in the Nth 32-byte argument slot of some calldata. */
const argAddress = (data, index) => getAddress(`0x${data.slice(10 + index * 64 + 24, 10 + (index + 1) * 64)}`);
const argUint = (data, index) => BigInt(`0x${data.slice(10 + index * 64, 10 + (index + 1) * 64)}`);

/**
 * Safe's own owner management, applied for real.
 *
 * Emitting `ExecutionSuccess` without actually changing the owner set would make every governance
 * readback pass vacuously — which is the one thing those readbacks exist to catch. So the fake
 * enforces what Safe enforces: an owner cannot be added twice, an owner that is not an owner cannot
 * be removed, and a threshold must be between 1 and the resulting owner count.
 */
function applyOwnerManagement(safe, data, commit) {
  const selector = String(data).slice(0, 10).toLowerCase();
  if (selector === SELECTOR.addOwnerWithThreshold) {
    const owner = argAddress(data, 0);
    const threshold = Number(argUint(data, 1));
    if (safe.owners.some((o) => getAddress(o) === owner)) return false;
    const after = safe.owners.length + 1;
    if (threshold < 1 || threshold > after) return false;
    if (commit) { safe.owners = [owner, ...safe.owners]; safe.threshold = threshold; }
    return true;
  }
  if (selector === SELECTOR.removeOwner) {
    const owner = argAddress(data, 1);
    const threshold = Number(argUint(data, 2));
    if (!safe.owners.some((o) => getAddress(o) === owner)) return false;
    const after = safe.owners.length - 1;
    if (after < 1 || threshold < 1 || threshold > after) return false;
    if (commit) {
      safe.owners = safe.owners.filter((o) => getAddress(o) !== owner);
      safe.threshold = threshold;
    }
    return true;
  }
  if (selector === SELECTOR.changeThreshold) {
    const threshold = Number(argUint(data, 0));
    if (threshold < 1 || threshold > safe.owners.length) return false;
    if (commit) safe.threshold = threshold;
    return true;
  }
  return false;
}

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
  // Allowance Module state, mirroring the real contract's shape.
  const enabledModules = new Map();     // safe -> Set(module)
  const spendDelegates = new Map();     // safe -> [delegate]
  const allowanceBook = new Map();      // `${safe}:${delegate}:${token}` -> { amount, spent, resetTimeMin, lastResetMin, nonce }
  let nowSeconds = 1_800_000_000;       // a realistic chain age; see the reset arithmetic below
  const calls = { deployments: 0, writes: [], executions: [], allowanceTransfers: [] };
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
    innerCallFails: false,
    // Serve different code at the module address, to exercise the gate refusing an impostor.
    moduleCodeOverride: null
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
    } else if (getAddress(to) === getAddress(ALLOWANCE_MODULE)) {
      // Module administration: adding a delegate, setting or clearing a limit. Reachable ONLY from
      // here — i.e. only as a transaction the Safe itself executed, which is what makes a limit
      // change a threshold-approved act.
      innerOk = commit ? applyModuleAdmin(safe.address, data) : true;
    } else if (getAddress(to) === getAddress(safe.address) && String(data).slice(0, 10).toLowerCase() === SELECTOR.enableModule) {
      if (commit) {
        const key = getAddress(safe.address).toLowerCase();
        const set = enabledModules.get(key) ?? new Set();
        set.add(getAddress(`0x${data.slice(34, 74)}`));
        enabledModules.set(key, set);
      }
      innerOk = true;
    } else if (getAddress(to) === getAddress(safe.address)) {
      // Owner management: the Safe calling itself. Genuinely applied, so a governance readback that
      // passes means the owner set actually changed.
      innerOk = applyOwnerManagement(safe, data, commit);
    } else {
      // Any other target is something a Circle never signs.
      innerOk = false;
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

  // --- Allowance Module -------------------------------------------------------

  const allowanceKey = (safe, delegate, token) =>
    `${getAddress(safe).toLowerCase()}:${getAddress(delegate).toLowerCase()}:${getAddress(token).toLowerCase()}`;

  /**
   * The module's `getAllowance`: reads storage and applies the period reset on load, exactly as the
   * contract does. This is why "spent today" is a chain read — the reset happens here, not in Prism.
   */
  function readAllowanceState(safe, delegate, token) {
    const stored = allowanceBook.get(allowanceKey(safe, delegate, token))
      ?? { amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 0 };
    const allowance = { ...stored };
    const currentMin = Math.floor(nowSeconds / 60);
    if (allowance.resetTimeMin > 0 && allowance.lastResetMin <= currentMin - allowance.resetTimeMin) {
      allowance.spent = 0n;
      allowance.lastResetMin = currentMin - ((currentMin - allowance.lastResetMin) % allowance.resetTimeMin);
    }
    return allowance;
  }

  function moduleTransferHash({ safe, token, to, amount, nonce }) {
    const domainSeparator = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [ALLOWANCE_DOMAIN_TYPEHASH, BigInt(knobs.reportChainId), getAddress(ALLOWANCE_MODULE)]
    ));
    const transferHash = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
       { type: 'uint96' }, { type: 'address' }, { type: 'uint96' }, { type: 'uint16' }],
      [ALLOWANCE_TRANSFER_TYPEHASH, getAddress(safe), getAddress(token), getAddress(to),
       BigInt(amount), ZERO_ADDR, 0n, Number(nonce)]
    ));
    return keccak256(`0x1901${domainSeparator.slice(2)}${transferHash.slice(2)}`);
  }

  /** `executeAllowanceTransfer`, with the real contract's ordering and its v1.0.0 nonce ceiling. */
  async function runAllowanceTransfer(args, { commit, sender }) {
    const [safeAddr, token, to, amount, , , delegate, signature] = args;
    const safe = safes.get(getAddress(safeAddr).toLowerCase());
    if (!safe) throw new Error('no Safe');
    if (!(enabledModules.get(getAddress(safeAddr).toLowerCase()) ?? new Set()).has(getAddress(ALLOWANCE_MODULE))) {
      throw new Error('GS104: module not enabled');
    }

    const allowance = readAllowanceState(safeAddr, delegate, token);
    const hash = moduleTransferHash({ safe: safeAddr, token, to, amount, nonce: allowance.nonce });

    // v1.0.0: refuse rather than wrap. This is the fix for the replay bug v0.1.x carried.
    if (allowance.nonce === 0xffff) throw new Error('allowance.nonce != type(uint16).max (use different delegate)');
    allowance.nonce += 1;

    const newSpent = allowance.spent + BigInt(amount);
    if (!(newSpent > allowance.spent && newSpent <= allowance.amount)) {
      throw new Error('newSpent > allowance.spent && newSpent <= allowance.amount');
    }
    allowance.spent = newSpent;

    // checkSignature: an empty signature authenticates msg.sender; otherwise raw ECDSA over the hash.
    const signer = (!signature || signature === '0x')
      ? getAddress(sender)
      : await recoverAddress({ hash, signature }).then(getAddress).catch(() => null);
    const registered = (spendDelegates.get(getAddress(safeAddr).toLowerCase()) ?? [])
      .some((d) => getAddress(d) === getAddress(delegate));
    if (!signer || signer !== getAddress(delegate) || !registered) {
      throw new Error('expectedDelegate == signer && delegates[address(safe)][uint48(signer)].delegate == signer');
    }

    if (balanceOf(safeAddr) < BigInt(amount)) throw new Error('Could not execute token transfer');

    const logs = [transferLog(safeAddr, to, amount)];
    if (commit) {
      allowanceBook.set(allowanceKey(safeAddr, delegate, token), allowance);
      debit(safeAddr, amount);
      credit(to, amount);
      calls.allowanceTransfers.push({ safe: getAddress(safeAddr), delegate: getAddress(delegate), amount: String(amount) });
    }
    return { logs };
  }

  /** Module administration — only ever reached through a Safe transaction, as on the real thing. */
  function applyModuleAdmin(safeAddr, data) {
    const safeKey = getAddress(safeAddr).toLowerCase();
    const selector = data.slice(0, 10).toLowerCase();
    const word = (i) => `0x${data.slice(10 + i * 64, 10 + (i + 1) * 64)}`;
    const addr = (i) => getAddress(`0x${word(i).slice(-40)}`);
    const num = (i) => BigInt(word(i));

    if (selector === SELECTOR.addDelegate) {
      const list = spendDelegates.get(safeKey) ?? [];
      if (!list.some((d) => getAddress(d) === addr(0))) list.push(addr(0));
      spendDelegates.set(safeKey, list);
      return true;
    }
    if (selector === SELECTOR.removeDelegate) {
      const delegate = addr(0);
      const removeAllowances = num(1) !== 0n;
      spendDelegates.set(safeKey, (spendDelegates.get(safeKey) ?? []).filter((d) => getAddress(d) !== delegate));
      if (removeAllowances) {
        for (const key of [...allowanceBook.keys()]) {
          if (key.startsWith(`${safeKey}:${delegate.toLowerCase()}:`)) {
            const existing = allowanceBook.get(key);
            allowanceBook.set(key, { ...existing, amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0 });
          }
        }
      }
      return true;
    }
    if (selector === SELECTOR.setAllowance) {
      const delegate = addr(0);
      if (!(spendDelegates.get(safeKey) ?? []).some((d) => getAddress(d) === delegate)) return false;
      const token = addr(1);
      const key = allowanceKey(safeAddr, delegate, token);
      const existing = allowanceBook.get(key) ?? { amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 0 };
      const next = { ...existing };
      if (next.nonce === 0) next.nonce = 1;        // the module marks an activated allowance
      const currentMin = Math.floor(nowSeconds / 60);
      if (next.lastResetMin === 0) next.lastResetMin = currentMin;
      next.resetTimeMin = Number(num(3));
      next.amount = num(2);
      allowanceBook.set(key, next);
      return true;
    }
    if (selector === SELECTOR.deleteAllowance) {
      const key = allowanceKey(safeAddr, addr(0), addr(1));
      const existing = allowanceBook.get(key);
      if (existing) allowanceBook.set(key, { ...existing, amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0 });
      return true;
    }
    return false;
  }

  const chain = {
    async getChainId() { return knobs.reportChainId; },
    async getBalance() { return 0n; },              // members hold MON = 0; the relayer pays gas

    /** The module's REAL deployed runtime, so the backend's codeHash gate is genuinely exercised. */
    async getCode(address) {
      if (getAddress(address) === getAddress(ALLOWANCE_MODULE)) {
        return knobs.moduleCodeOverride ?? CANONICAL_RUNTIME;
      }
      return safes.has(getAddress(address).toLowerCase()) ? '0x60006000' : '0x';
    },

    async readContract({ address, functionName, args }) {
      if (knobs.readFails) throw new Error('rpc unavailable');
      if (functionName === 'proxyCreationCode') return proxyCreationCode;
      if (functionName === 'balanceOf') return balanceOf(args[0]);
      if (functionName === 'authorizationState') return usedAuthorizations.has(`${getAddress(args[0]).toLowerCase()}:${String(args[1]).toLowerCase()}`);
      if (functionName === 'DOMAIN_SEPARATOR') return keccak256(toHex('fake usdc domain'));

      // --- Allowance Module reads ---
      if (getAddress(address) === getAddress(ALLOWANCE_MODULE)) {
        switch (functionName) {
          case 'VERSION': return knobs.moduleVersion ?? '1.0.0';
          case 'NAME': return 'Allowance Module';
          case 'getTokenAllowance': {
            const a = readAllowanceState(args[0], args[1], args[2]);
            return [a.amount, a.spent, BigInt(a.resetTimeMin), BigInt(a.lastResetMin), BigInt(a.nonce)];
          }
          case 'getDelegates':
            return [(spendDelegates.get(getAddress(args[0]).toLowerCase()) ?? []).map(getAddress), 0];
          case 'generateTransferHash':
            return moduleTransferHash({ safe: args[0], token: args[1], to: args[2], amount: args[3], nonce: args[6] });
          default: throw new Error(`fake module: unexpected read ${functionName}`);
        }
      }
      if (functionName === 'isModuleEnabled') {
        return (enabledModules.get(getAddress(address).toLowerCase()) ?? new Set()).has(getAddress(args[0]));
      }

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
      if (functionName === 'executeAllowanceTransfer') {
        await runAllowanceTransfer(args, { commit: false, sender: RELAYER });
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
      if (functionName === 'executeAllowanceTransfer') {
        const { logs } = await runAllowanceTransfer(args, { commit: true, sender: RELAYER });
        return mine(`allowance:${calls.writes.length}`, logs);
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
    safeDigest,
    /** Move the fake chain's clock, so an allowance window can be rolled over. */
    warp: (seconds) => { nowSeconds += seconds; },
    now: () => nowSeconds,
    /** Inspect module state directly, for assertions that must not go through the code under test. */
    delegatesOf: (safeAddress) => (spendDelegates.get(getAddress(safeAddress).toLowerCase()) ?? []).map(getAddress),
    allowanceOf: (safeAddress, delegate, token) => readAllowanceState(safeAddress, delegate, token),
    moduleEnabledOn: (safeAddress) =>
      (enabledModules.get(getAddress(safeAddress).toLowerCase()) ?? new Set()).has(getAddress(ALLOWANCE_MODULE))
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
export async function circleStack({ withPayments = false, withLimits = false } = {}) {
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

  // Spending limits are OFF unless a suite asks for them, exactly as they ship. Turning them on
  // here points the real `AllowanceModuleGate` at the fake chain — which serves the module's genuine
  // deployed bytecode, so the gate's codeHash check is a real check rather than a stubbed pass.
  let limitGate = null;
  const restoreLimits = { enabled: config.circles.limitsEnabled, module: config.circles.allowanceModule };
  if (withLimits) {
    const { AllowanceModuleGate } = await import('../src/circles/allowanceModuleGate.js');
    config.circles.limitsEnabled = true;
    config.circles.allowanceModule = ALLOWANCE_MODULE;
    limitGate = new AllowanceModuleGate({ config, chain: fake.chain });
  }

  const circles = new CircleService({ store, config, identityService, safeAdapter, paymentService, limitGate });
  const restore = () => {
    restoreProvider();
    config.circles.limitsEnabled = restoreLimits.enabled;
    config.circles.allowanceModule = restoreLimits.module;
  };
  return {
    store, config, identityService, safeAdapter, circles, fake, paymentService, resolverService,
    limitGate, restoreProvider: restore
  };
}

let keyCounter = 0;
/**
 * Create a real Prism identity bound to a fresh Mera-style account, as onboarding would.
 *
 * The key is the counter written as a full 32-byte big-endian value, so a suite may create as many
 * identities as it likes. (The earlier form repeated a 2-character string 32 times, which stopped
 * producing a valid key at the hundredth identity — a limit a hostile suite reaches easily.)
 */
export async function makeIdentity(identityService, { name, handle } = {}) {
  keyCounter += 1;
  const account = privateKeyToAccount(`0x${keyCounter.toString(16).padStart(64, '0')}`);
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
