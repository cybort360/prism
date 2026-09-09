import { encodeAbiParameters } from 'viem';
import { randomHex } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

// Adoption of the device-P256 → PrismP256Account settlement path. The device holds a P-256 (Secure
// Enclave / CryptoKit) key; the backend deploys a PrismP256Account bound to that key, builds the exact
// intent the device signs, and relays the account's `pay()` (relayer pays gas). Chain effects are
// injected (`chainOps`) so the orchestration is deterministically testable; the real ops live in
// chain/p256Account.js. This is ADDITIVE — the secp256k1 router path is untouched.

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

export class P256AccountService {
  constructor({ store, config, chainOps }) {
    this.store = store;
    this.config = config;
    this.chain = chainOps; // { deployAccount({qx,qy}), relayPay({...}), getReceipt(hash) }
  }

  /** Deploy (once) a PrismP256Account bound to this user's device P-256 public key. Idempotent. */
  async ensureAccount({ prismId, qx, qy }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(qx) || !/^0x[0-9a-fA-F]{64}$/.test(qy)) throw httpError(400, 'qx/qy must be 32-byte hex');
    const existing = this.store.read().p256Accounts?.[prismId];
    if (existing?.account) return { account: existing.account, deployed: false };
    const account = await this.chain.deployAccount({ qx, qy });
    this.store.mutate(d => { (d.p256Accounts ||= {})[prismId] = { prismId, account, qx, qy, createdAt: new Date().toISOString() }; });
    logger.info('p256.account.deployed', { prismId, account });
    return { account, deployed: true };
  }

  /** Build the exact intent bytes the device P-256 key must sign (byte-identical to
   *  PrismP256Account.intent(...)), plus a fresh nonce/expiry. The device applies SHA-256 when signing,
   *  matching the account's on-chain `sha256(intent)` verification. */
  prepare({ prismId, recipient, amountAtomic }) {
    const rec = this.store.read().p256Accounts?.[prismId];
    if (!rec?.account) throw httpError(409, 'no P256 account for this user; register one first');
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw httpError(400, 'recipient must be an address');
    const amount = String(BigInt(amountAtomic));
    if (BigInt(amount) <= 0n) throw httpError(400, 'amount must be positive');
    const nonce = randomHex(32);
    const validBefore = Math.floor(Date.now() / 1000) + 300;
    const intentHex = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }],
      [BigInt(this.config.chain.chainId), rec.account, this.config.chain.usdc, recipient, BigInt(amount), nonce, BigInt(validBefore)]
    );
    const opId = `p256_${randomHex(16).slice(2)}`; // path-safe (no '#') so the status URL never needs escaping
    this.store.mutate(d => {
      (d.p256Ops ||= {})[opId] = {
        operationId: opId, kind: 'p256-payment', state: 'prepared', prismId,
        intent: { account: rec.account, token: this.config.chain.usdc, recipient, amount, nonce, validBefore },
        createdAt: new Date().toISOString()
      };
    });
    return { opId, account: rec.account, token: this.config.chain.usdc, amountAtomic: amount, nonce, validBefore, intentHex };
  }

  /** Relay a prepared payment authorized by the device's P-256 signature (r,s). Relayer pays gas. */
  async submit({ prismId, opId, r, s }) {
    const op = this.store.read().p256Ops?.[opId];
    if (!op || op.prismId !== prismId) throw httpError(404, 'operation not found');
    if (op.state !== 'prepared') return { opId, state: op.state, txHash: op.txHash ?? null };
    if (op.intent.validBefore <= Math.floor(Date.now() / 1000)) throw httpError(400, 'intent expired; re-prepare');
    const i = op.intent;
    const txHash = await this.chain.relayPay({ account: i.account, token: i.token, recipient: i.recipient, amount: i.amount, nonce: i.nonce, validBefore: i.validBefore, r, s });
    this.store.mutate(d => { d.p256Ops[opId].state = 'submitted'; d.p256Ops[opId].txHash = txHash; d.p256Ops[opId].submittedAt = new Date().toISOString(); });
    logger.info('p256.pay.submitted', { opId, account: i.account, txHash });
    return { opId, state: 'submitted', txHash };
  }

  /** Reconcile a user's non-terminal P256 ops against the chain (opportunistic, on Activity load).
   *  Flips a submitted/confirming op to completed/failed once its receipt is available. */
  async reconcile(prismId) {
    const pending = Object.values(this.store.read().p256Ops ?? {})
      .filter(o => o.prismId === prismId && o.txHash && o.state !== 'completed' && o.state !== 'failed');
    for (const op of pending) {
      const receipt = await this.chain.getReceipt(op.txHash).catch(() => null);
      if (!receipt) continue;
      const ok = receipt.status === 'success' || receipt.status === '0x1' || receipt.status === 1;
      this.store.mutate(d => { if (d.p256Ops?.[op.operationId]) d.p256Ops[op.operationId].state = ok ? 'completed' : 'failed'; });
    }
  }

  /** Confirmed on-chain state (never trust submission as completion). */
  async status({ prismId, opId }) {
    const op = this.store.read().p256Ops?.[opId];
    if (!op || op.prismId !== prismId) throw httpError(404, 'operation not found');
    if (op.txHash && op.state !== 'completed' && op.state !== 'failed') {
      const receipt = await this.chain.getReceipt(op.txHash).catch(() => null);
      if (receipt) {
        const ok = receipt.status === 'success' || receipt.status === '0x1' || receipt.status === 1;
        this.store.mutate(d => { d.p256Ops[opId].state = ok ? 'completed' : 'failed'; });
        return { opId, state: ok ? 'completed' : 'failed', txHash: op.txHash };
      }
      return { opId, state: 'confirming', txHash: op.txHash };
    }
    return { opId, state: this.store.read().p256Ops[opId].state, txHash: op.txHash ?? null };
  }
}
