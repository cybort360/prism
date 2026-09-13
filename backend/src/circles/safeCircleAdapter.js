/**
 * SafeCircleAdapter — the only place in Prism that talks to Safe.
 *
 * Every Safe concern (proxy factory, singleton ABI, owner linked list, transaction service) stops
 * here. Route handlers and CircleService speak the Circle domain language and never see a Safe ABI,
 * so swapping the Safe SDK, moving to a different Safe version, or changing how proposals are stored
 * is a change to this file and nothing else.
 *
 * Two rules this adapter enforces on behalf of the whole system:
 *
 *  1. Reads that the chain owns (owners, threshold, balance, version) are always live calls. There
 *     is no cache, because a cached authority is a fabricated authority the moment it goes stale.
 *  2. Nothing the Safe Transaction Service returns is trusted on its word. Its confirmations are
 *     re-verified as cryptographic signatures against the digest and the live owner set before they
 *     are allowed to count — the service is a convenience for storage, never a source of authority.
 */
import { getAddress, isAddress, recoverAddress, recoverMessageAddress } from 'viem';
import {
  safeTransaction, safeTxHash, encodeTransactionData, encodeSetupInitializer, predictSafeAddress,
  encodeUsdcTransfer, encodeAddOwnerWithThreshold, encodeRemoveOwner, encodeChangeThreshold,
  prevOwnerFor, buildSignatureBytes, SafeOperation, findUsdcTransfer, safeExecutionOutcome
} from './safeEncoding.js';
import { SignatureType, badRequest, conflict } from './model.js';
import { logger } from '../lib/logger.js';

/**
 * The adapter contract. CircleService validates any injected adapter against this list at
 * construction, so a test double that forgets a method fails loudly at wiring time rather than
 * halfway through a creation flow.
 */
export const SAFE_ADAPTER_METHODS = Object.freeze([
  'predictCircleAddress', 'createCircle', 'getCircleState', 'getOwners', 'getThreshold', 'getNonce',
  'buildTransaction', 'getTransactionHash', 'encodeContractSignature',
  'proposeTransaction', 'addConfirmation', 'getPendingTransactions',
  'simulateExecution', 'executeTransaction', 'getTransactionReceipt', 'verifyExecutionEvidence',
  'getUsdcBalance', 'getDeploymentReceipt', 'verifyApproval'
]);

export function assertAdapterContract(adapter) {
  const missing = SAFE_ADAPTER_METHODS.filter((m) => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`SafeCircleAdapter is missing: ${missing.join(', ')}`);
  return adapter;
}

const SAFE_ABI = [
  { name: 'getOwners', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { name: 'getThreshold', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'nonce', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'VERSION', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'domainSeparator', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'isOwner', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  {
    name: 'getTransactionHash', type: 'function', stateMutability: 'view', outputs: [{ type: 'bytes32' }],
    inputs: [
      { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }
    ]
  },
  {
    name: 'execTransaction', type: 'function', stateMutability: 'payable', outputs: [{ type: 'bool' }],
    inputs: [
      { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }
    ]
  }
];

const FACTORY_ABI = [
  { name: 'createProxyWithNonce', type: 'function', stateMutability: 'nonpayable', outputs: [{ type: 'address' }], inputs: [{ type: 'address' }, { type: 'bytes' }, { type: 'uint256' }] },
  { name: 'proxyCreationCode', type: 'function', stateMutability: 'pure', inputs: [], outputs: [{ type: 'bytes' }] }
];

const ERC20_BALANCE_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];

export const EXPECTED_SAFE_VERSION = '1.4.1';

export class SafeCircleAdapter {
  /**
   * @param {object} deps
   * @param {object} deps.config        Prism config (config.circles holds the audited Safe addresses)
   * @param {object} deps.chain         { readContract, writeContract, getReceipt, simulate } — the RPC seam
   * @param {object} [deps.txService]   optional Safe Transaction Service client; absent = local-only proposals
   */
  constructor({ config, chain, txService = null }) {
    this.config = config;
    this.chain = chain;
    this.txService = txService;
    this.chainId = Number(config.chain.chainId);
    this.singleton = getAddress(config.circles.safeSingleton);
    this.proxyFactory = getAddress(config.circles.safeProxyFactory);
    this.fallbackHandler = getAddress(config.circles.safeFallbackHandler);
    this._proxyCreationCode = null;
  }

  // --- creation --------------------------------------------------------------

  /**
   * The address `createCircle` will deploy to, computed from the factory's own creation code.
   * Deterministic in `saltNonce`, which is what makes a repeated creation request idempotent rather
   * than a second Circle: the same admins and salt always predict the same Safe.
   */
  async predictCircleAddress({ owners, threshold, saltNonce }) {
    const initializer = encodeSetupInitializer({ owners, threshold, fallbackHandler: this.fallbackHandler });
    const proxyCreationCode = await this._creationCode();
    const address = predictSafeAddress({
      proxyFactory: this.proxyFactory, singleton: this.singleton, initializer, saltNonce, proxyCreationCode
    });
    return { address, initializer, saltNonce: String(saltNonce) };
  }

  /** Broadcast the Safe deployment. Returns only what was submitted — never "it worked". */
  async createCircle({ owners, threshold, saltNonce }) {
    const { address, initializer } = await this.predictCircleAddress({ owners, threshold, saltNonce });
    const txHash = await this.chain.writeContract({
      address: this.proxyFactory, abi: FACTORY_ABI, functionName: 'createProxyWithNonce',
      args: [this.singleton, initializer, BigInt(saltNonce)]
    });
    logger.info('circle.safe.deploy.submitted', { predicted: address, txHash });
    return { predictedAddress: address, txHash };
  }

  async getDeploymentReceipt(txHash) {
    const receipt = await this.chain.getReceipt(txHash).catch(() => null);
    if (!receipt) return null;
    const ok = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
    return { status: ok ? 'success' : 'reverted', blockNumber: receipt.blockNumber ?? null, raw: receipt };
  }

  // --- live chain state ------------------------------------------------------

  /**
   * Everything needed to decide whether a deployed Safe is really this Circle. Read live, every
   * time, in one place — so activation, drift detection and the read API all check the same facts.
   */
  async getCircleState(safeAddress) {
    const address = this._assertAddress(safeAddress);
    const [chainId, owners, threshold, version, nonce] = await Promise.all([
      this.chain.getChainId(),
      this.getOwners(address),
      this.getThreshold(address),
      this._read(address, 'VERSION', []),
      this._read(address, 'nonce', [])
    ]);
    return {
      safeAddress: address,
      chainId: Number(chainId),
      owners,
      threshold,
      version,
      nonce: Number(nonce),
      singleton: this.singleton,
      readAt: new Date().toISOString()
    };
  }

  async getOwners(safeAddress) {
    const owners = await this._read(this._assertAddress(safeAddress), 'getOwners', []);
    return owners.map((o) => getAddress(o));
  }

  async getThreshold(safeAddress) {
    return Number(await this._read(this._assertAddress(safeAddress), 'getThreshold', []));
  }

  async getNonce(safeAddress) {
    return Number(await this._read(this._assertAddress(safeAddress), 'nonce', []));
  }

  /** The Circle's money, straight from the token contract. Never persisted, never defaulted. */
  async getUsdcBalance(safeAddress) {
    const balance = await this.chain.readContract({
      address: getAddress(this.config.chain.usdc), abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf', args: [this._assertAddress(safeAddress)]
    });
    return BigInt(balance);
  }

  // --- building transactions -------------------------------------------------

  /**
   * Build the Safe transaction for a Circle intent. The nonce comes from the Safe itself unless one
   * is supplied: a proposal built against a guessed nonce is a proposal that cannot execute.
   */
  async buildTransaction({ safeAddress, intent, nonce }) {
    const safe = this._assertAddress(safeAddress);
    const resolvedNonce = nonce ?? await this.getNonce(safe);
    const built = await this._intentToCall(safe, intent);
    return safeTransaction({ to: built.to, value: 0n, data: built.data, operation: SafeOperation.CALL, nonce: resolvedNonce });
  }

  /** Translate a Circle-level intent into `to` + calldata. The only place intents become Safe calls. */
  async _intentToCall(safeAddress, intent) {
    switch (intent.kind) {
      case 'PAYMENT':
        // The Circle's Safe calls USDC.transfer — `to` is the token, never the recipient.
        return { to: getAddress(this.config.chain.usdc), data: encodeUsdcTransfer({ recipient: intent.recipient, amountAtomic: intent.amountAtomic }) };
      case 'OWNER_ADD':
        // Owner management is the Safe calling itself; that is why `to` is the Circle's own address.
        return { to: safeAddress, data: encodeAddOwnerWithThreshold({ owner: intent.owner, threshold: intent.threshold }) };
      case 'OWNER_REMOVE': {
        // The predecessor is derived from the live owner list, never from a remembered copy.
        const owners = await this.getOwners(safeAddress);
        return { to: safeAddress, data: encodeRemoveOwner({ prevOwner: prevOwnerFor(owners, intent.owner), owner: intent.owner, threshold: intent.threshold }) };
      }
      case 'THRESHOLD_CHANGE':
        return { to: safeAddress, data: encodeChangeThreshold({ threshold: intent.threshold }) };
      default:
        throw badRequest(`unknown circle intent: ${intent.kind}`);
    }
  }

  /**
   * The digest owners will sign, computed locally AND cross-checked against the Safe contract when
   * the Safe exists on-chain. A disagreement means our encoding drifted from the deployed Safe, and
   * is raised rather than papered over — this is the check that would catch a Safe version change.
   */
  async getTransactionHash({ safeAddress, tx, crossCheck = true }) {
    const safe = this._assertAddress(safeAddress);
    const local = safeTxHash({ chainId: this.chainId, safeAddress: safe, tx });
    if (crossCheck) {
      const onchain = await this._read(safe, 'getTransactionHash', [
        tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce
      ]).catch(() => null);
      if (onchain && onchain.toLowerCase() !== local.toLowerCase()) {
        throw conflict('Safe transaction hash disagreement: Prism and the deployed Safe encode this transaction differently');
      }
    }
    return local;
  }

  /** The EIP-712 pre-image an EIP-1271 contract owner is handed (Safe passes the pre-image, not the hash). */
  encodeContractSignature({ safeAddress, tx }) {
    return encodeTransactionData({ chainId: this.chainId, safeAddress: this._assertAddress(safeAddress), tx });
  }

  // --- approvals -------------------------------------------------------------

  /**
   * Verify one approval cryptographically and against the live owner set.
   *
   * This is the function that makes "collected approvals" a fact rather than a count. It answers:
   * did *this* signature, over *this* digest, come from an address that is an owner of *this* Safe
   * right now? Nothing else — not a transaction-service record, not a Prism row — is allowed to
   * stand in for that answer.
   */
  async verifyApproval({ safeAddress, safeTxHash: digest, signature, owners = null }) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) throw badRequest('approval must be a 65-byte signature');
    const ownerSet = (owners ?? await this.getOwners(safeAddress)).map((o) => getAddress(o));
    const v = parseInt(signature.slice(130, 132), 16);

    // Safe encodes its signature variants in `v`: 27/28 is a plain EIP-712 ECDSA signature, and
    // 31/32 is the same signature over an eth_sign personal-message digest.
    let recovered = null;
    let signatureType = null;
    if (v === 27 || v === 28) {
      recovered = await recoverAddress({ hash: digest, signature }).catch(() => null);
      signatureType = SignatureType.ECDSA;
    } else if (v === 31 || v === 32) {
      const adjusted = `${signature.slice(0, 130)}${(v - 4).toString(16).padStart(2, '0')}`;
      recovered = await recoverMessageAddress({ message: { raw: digest }, signature: adjusted }).catch(() => null);
      signatureType = SignatureType.ETH_SIGN;
    } else {
      // v=0 (contract signature) and v=1 (pre-approved hash) are valid Safe encodings, but they are
      // not self-verifying off-chain: one needs an EIP-1271 call, the other an on-chain read.
      throw badRequest('unsupported approval encoding; Circles verifies ECDSA and eth_sign approvals');
    }
    if (!recovered) throw badRequest('approval signature could not be recovered');
    const authorityAddress = getAddress(recovered);
    if (!ownerSet.includes(authorityAddress)) {
      throw badRequest('approval was not signed by a current admin of this Circle');
    }
    return { authorityAddress, signatureType };
  }

  // --- proposal coordination -------------------------------------------------
  // The Safe Transaction Service is reachable on Monad (see docs/CIRCLES_DEPENDENCY_AUDIT.md) and is
  // used, when configured, purely as shared storage so a proposal is visible to co-admins on other
  // devices. Correctness never depends on it: every confirmation it hands back is re-verified by
  // `verifyApproval` before it counts, and a service outage degrades sharing, not authority.

  async proposeTransaction({ safeAddress, tx, safeTxHash: digest, proposerAddress, signature = null }) {
    if (!this.txService) return { stored: 'local', safeTxHash: digest };
    await this.txService.propose({ safeAddress: this._assertAddress(safeAddress), tx, safeTxHash: digest, proposerAddress, signature })
      .catch((e) => { logger.error('circle.txservice.propose.failed', { safeTxHash: digest, error: e.message }); });
    return { stored: 'txService', safeTxHash: digest };
  }

  async addConfirmation({ safeTxHash: digest, signature }) {
    if (!this.txService) return { stored: 'local' };
    await this.txService.confirm({ safeTxHash: digest, signature })
      .catch((e) => { logger.error('circle.txservice.confirm.failed', { safeTxHash: digest, error: e.message }); });
    return { stored: 'txService' };
  }

  /**
   * Pending transactions for a Safe, with every confirmation re-verified locally. Signatures that do
   * not recover to a current owner are dropped, so a compromised or confused service cannot inflate
   * an approval count.
   */
  async getPendingTransactions(safeAddress) {
    const safe = this._assertAddress(safeAddress);
    if (!this.txService) return [];
    const pending = await this.txService.pending(safe).catch((e) => {
      logger.error('circle.txservice.pending.failed', { safeAddress: safe, error: e.message });
      return [];
    });
    const owners = await this.getOwners(safe);
    const out = [];
    for (const entry of pending) {
      const confirmations = [];
      for (const c of entry.confirmations ?? []) {
        const verified = await this.verifyApproval({ safeAddress: safe, safeTxHash: entry.safeTxHash, signature: c.signature, owners })
          .catch(() => null);
        if (verified) confirmations.push({ ...verified, signature: c.signature });
      }
      out.push({ safeTxHash: entry.safeTxHash, nonce: entry.nonce, confirmations });
    }
    return out;
  }

  // --- execution -------------------------------------------------------------

  /**
   * Dry-run `execTransaction` against current chain state, without broadcasting.
   *
   * This is the gate in front of every Circle payment, and it is not a nicety. Safe re-derives the
   * digest and re-checks every signature against its own live owner set inside `execTransaction`, so
   * a successful simulation is the Safe itself confirming — at this block, with these owners, at this
   * nonce — that the approvals Prism collected really do authorize this transaction. A failure means
   * the broadcast would have burned gas to revert, or (worse) that Prism's view of authority and the
   * Safe's have diverged. Either way the answer is: do not broadcast.
   */
  async simulateExecution({ safeAddress, tx, approvals }) {
    const safe = this._assertAddress(safeAddress);
    const signatures = buildSignatureBytes(approvals);
    try {
      const result = await this.chain.simulateContract({
        address: safe, abi: SAFE_ABI, functionName: 'execTransaction',
        args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures]
      });
      // Safe's `execTransaction` returns false when the inner call fails but the Safe itself did
      // not revert. That is still a payment that would not happen, so it is not a success here.
      if (result?.result === false) return { ok: false, reason: 'the Safe would execute but the USDC transfer itself would fail' };
      return { ok: true, request: result?.request ?? null, signatures };
    } catch (error) {
      logger.warn('circle.safe.simulate.failed', { safeAddress: safe, nonce: String(tx.nonce), error: error.shortMessage ?? error.message });
      return { ok: false, reason: error.shortMessage ?? error.message };
    }
  }

  /**
   * Submit a fully-approved Safe transaction. The relayer pays gas; authority is in the signatures.
   *
   * The relayer is a courier and nothing more. Every field it submits is covered by the owners'
   * signatures, so rewriting the recipient, the token, the amount or the nonce on the way out does
   * not redirect the money — it produces a digest the signatures do not authorize and the Safe
   * reverts. `circles-payments.test.js` asserts exactly that against a Safe that checks signatures.
   */
  async executeTransaction({ safeAddress, tx, approvals }) {
    const safe = this._assertAddress(safeAddress);
    const signatures = buildSignatureBytes(approvals);
    const txHash = await this.chain.writeContract({
      address: safe, abi: SAFE_ABI, functionName: 'execTransaction',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures]
    });
    logger.info('circle.safe.exec.submitted', { safeAddress: safe, nonce: String(tx.nonce), txHash });
    return { txHash };
  }

  /** A mined transaction, or null while it is still in flight. Never a guess. */
  async getTransactionReceipt(txHash) {
    const receipt = await this.chain.getReceipt(txHash).catch(() => null);
    if (!receipt) return null;
    const ok = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
    return { status: ok ? 'success' : 'reverted', blockNumber: receipt.blockNumber ?? null, logs: receipt.logs ?? [], raw: receipt };
  }

  /**
   * Turn a receipt into an answer to one question: did THIS Circle pay THIS recipient THIS amount?
   *
   * Three separate facts have to line up, and the reason all three are required is that each alone
   * is forgeable or merely circumstantial:
   *
   *   1. the transaction succeeded                     — otherwise nothing happened at all;
   *   2. the Safe emitted ExecutionSuccess for this
   *      exact safeTxHash                              — Safe swallows a failing inner call and emits
   *                                                      ExecutionFailure while the *outer* receipt
   *                                                      still says success, so (1) does not imply it;
   *   3. the configured USDC emitted Transfer, from
   *      the Circle's Safe, to the reviewed recipient,
   *      for the exact amount                          — the only evidence that money moved, and the
   *                                                      only one tied to who was actually paid.
   *
   * Anything less is reported as a mismatch with a reason, never rounded up to "completed".
   */
  verifyExecutionEvidence({ receipt, safeAddress, safeTxHash: digest, recipient, amountAtomic }) {
    const safe = this._assertAddress(safeAddress);
    if (!receipt) return { ok: false, reason: 'no receipt yet' };
    if (receipt.status !== 'success') return { ok: false, reason: 'the execution transaction reverted' };

    const outcome = safeExecutionOutcome(receipt, { safeAddress: safe, safeTxHash: digest });
    if (outcome === 'failure') return { ok: false, reason: 'the Safe reported ExecutionFailure for this transaction' };
    if (outcome !== 'success') return { ok: false, reason: 'the receipt carries no Safe ExecutionSuccess for this transaction' };

    const transfer = findUsdcTransfer(receipt, {
      usdcAddress: this.config.chain.usdc, from: safe, to: recipient, amountAtomic
    });
    if (!transfer) {
      return { ok: false, reason: 'no USDC Transfer from this Circle to the reviewed recipient for the exact amount' };
    }
    return {
      ok: true,
      transfer: { from: transfer.from, to: transfer.to, amountAtomic: transfer.amountAtomic.toString(), token: getAddress(this.config.chain.usdc) },
      blockNumber: receipt.blockNumber ? String(receipt.blockNumber) : null
    };
  }

  // --- internals -------------------------------------------------------------

  async _creationCode() {
    // Read once per process: the factory's creation code is immutable for a deployed factory, and it
    // is read from the factory rather than hardcoded so a wrong factory address cannot go unnoticed.
    if (this._proxyCreationCode) return this._proxyCreationCode;
    this._proxyCreationCode = await this.chain.readContract({ address: this.proxyFactory, abi: FACTORY_ABI, functionName: 'proxyCreationCode', args: [] });
    return this._proxyCreationCode;
  }

  _read(address, functionName, args) {
    return this.chain.readContract({ address, abi: SAFE_ABI, functionName, args });
  }

  _assertAddress(address) {
    if (!isAddress(address ?? '')) throw badRequest('a Circle Safe address is required');
    return getAddress(address);
  }
}
