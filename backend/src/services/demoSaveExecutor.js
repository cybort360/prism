import { getAddress } from 'viem';
import { splitSignature, verifyTypedData, receiveAuthorizationTypedData } from '../chain/eth.js';
import { chainProvider } from '../providers/index.js';
import { mockVault as realVault } from '../chain/mockVault.js';
import { buildSaveOperation } from '../domain/savePosition.js';
import { redeemAuthorizationTypedData } from '../lib/redeemAuthorization.js';

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

// Receipt status is normalized across providers: viem uses 'success'/'reverted', raw JSON-RPC uses 1/0 or '0x1'/'0x0'.
function isSuccess(receipt) { return !!receipt && (receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1'); }
function isReverted(receipt) { return !!receipt && (receipt.status === 'reverted' || receipt.status === 0 || receipt.status === '0x0'); }

// DemoSaveExecutor — the executor seam for SAVE_MODE=demo. Verifies the user's ERC-3009 authorization
// against the persisted quote, has the relayer submit MockVault.depositWithAuthorization, waits for the
// receipt, and records a real SAVE operation (CREATED → SUBMITTED → SAVED) with the on-chain tx hash.
// No fabricated numbers: shares recorded are read back from the vault after settlement.
export class DemoSaveExecutor {
  constructor({ store, config, identityService, vault = realVault, chain = null, verify = null, receiptPoll = null } = {}) {
    this.store = store;
    this.config = config;
    this.identities = identityService;
    this.vault = vault;
    this.chain = chain ?? chainProvider();
    this.verify = verify; // test seam; defaults to real verifyTypedData below
    this.receiptPoll = receiptPoll ?? { tries: 20, delayMs: 500 }; // test seam: keep bounds small for fast tests
  }

  // Bounded receipt poll. Returns the first non-null receipt or null on timeout. Returns immediately when
  // the receipt is already available (test fakes return one on the first call, so no sleeping occurs).
  async _awaitReceipt(txHash) {
    const { tries, delayMs } = this.receiptPoll;
    for (let i = 0; i < tries; i++) {
      const receipt = await this.chain.getTransactionReceipt(txHash).catch(() => null);
      if (receipt) return receipt;
      if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
  }

  async submitDeposit({ prismId, quoteId, signature }) {
    if (this.config.save.mode !== 'demo') throw httpError(409, 'demo Save is not enabled');
    const quote = (this.store.read().saveQuotes ?? {})[quoteId];
    if (!quote || quote.prismId !== prismId || quote.kind !== 'SAVE') throw httpError(404, 'save quote not found');
    if (Math.floor(Date.now() / 1000) >= quote.deadline) throw httpError(409, 'this quote has expired — request a new one');

    const account = getAddress(quote.account);
    const vault = getAddress(quote.vault);
    const typed = receiveAuthorizationTypedData({
      from: account, to: vault, value: quote.amountAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce
    });
    const ok = this.verify ? await this.verify(typed, account, signature) : await verifyTypedData(typed, account, signature);
    if (!ok) throw httpError(400, 'authorization signature does not match');

    const { v, r, s } = splitSignature(signature);
    const positionId = `save_${account.toLowerCase()}`;

    // Record the operation BEFORE submit so a lost relayer response is still reconcilable.
    let op = buildSaveOperation({
      positionId, kind: 'SAVE', state: 'SUBMITTED',
      inputUSDC: quote.amountAtomic, quoteId, routeProvider: 'demo-vault',
      minimumShares: quote.minimumShares, submittedAt: new Date().toISOString()
    });
    this.store.mutate((data) => { data.saveOperations ??= {}; data.saveOperations[op.operationId] = op; });

    const txHash = await this.vault.submitDeposit({
      from: account, amount: quote.amountAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce, v, r, s
    });

    // Wait for the tx to actually mine before deciding state — a single immediate read returns null on
    // real testnet (op stuck CONFIRMING) and never catches a revert. Only read shares AFTER confirmation.
    const receipt = await this._awaitReceipt(txHash);
    const confirmed = isSuccess(receipt);
    const reverted = isReverted(receipt);
    const sharesReceived = confirmed ? await this.vault.sharesOf(account) : null; // canonical readback, post-confirmation only

    this.store.mutate((data) => {
      const rec = data.saveOperations[op.operationId];
      rec.transactionHash = txHash;
      rec.blockNumber = receipt?.blockNumber ? Number(receipt.blockNumber) : null;
      rec.sharesReceived = sharesReceived;
      rec.actualAUSD = confirmed ? quote.amountAtomic : null; // demo: USDC == asset, 1:1 into the vault's unit
      rec.state = confirmed ? 'SAVED' : (reverted ? 'FAILED' : 'CONFIRMING');
      rec.failureReason = reverted ? 'deposit transaction reverted on-chain' : null;
      rec.confirmedAt = confirmed ? new Date().toISOString() : null;
      rec.completedAt = confirmed ? new Date().toISOString() : null;
      op = rec;
    });

    return { operationId: op.operationId, txHash, state: op.state };
  }

  async submitWithdraw({ prismId, quoteId, signature }) {
    if (this.config.save.mode !== 'demo') throw httpError(409, 'demo Save is not enabled');
    const quote = (this.store.read().saveQuotes ?? {})[quoteId];
    if (!quote || quote.prismId !== prismId || quote.kind !== 'WITHDRAW_INSTANT') throw httpError(404, 'withdraw quote not found');
    if (Math.floor(Date.now() / 1000) >= quote.deadline) throw httpError(409, 'this quote has expired — request a new one');

    const account = getAddress(quote.account);
    const params = { owner: account, shares: quote.sharesAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce, vault: getAddress(quote.vault), chainId: Number(this.config.chain.chainId) };
    const typed = redeemAuthorizationTypedData(params);
    const ok = this.verify ? await this.verify(typed, account, signature) : await verifyTypedData(typed, account, signature);
    if (!ok) throw httpError(400, 'authorization signature does not match');

    const { v, r, s } = splitSignature(signature);
    const positionId = `save_${account.toLowerCase()}`;
    let op = buildSaveOperation({
      positionId, kind: 'WITHDRAW_INSTANT', state: 'REDEEMING',
      sharesRedeemed: quote.sharesAtomic, quoteId, routeProvider: 'demo-vault', submittedAt: new Date().toISOString()
    });
    this.store.mutate((data) => { data.saveOperations ??= {}; data.saveOperations[op.operationId] = op; });

    const txHash = await this.vault.submitRedeem({
      owner: account, shares: quote.sharesAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce, v, r, s
    });
    // Wait for the redeem to mine before deciding state — never report AVAILABLE off an unmined/reverted tx.
    const receipt = await this._awaitReceipt(txHash);
    const confirmed = isSuccess(receipt);
    const reverted = isReverted(receipt);
    const outputUSDC = confirmed ? (quote.estimatedUSDC ?? await this.vault.convertToAssets(quote.sharesAtomic)) : null;

    this.store.mutate((data) => {
      const rec = data.saveOperations[op.operationId];
      rec.transactionHash = txHash;
      rec.blockNumber = receipt?.blockNumber ? Number(receipt.blockNumber) : null;
      rec.outputUSDC = outputUSDC;
      rec.state = confirmed ? 'AVAILABLE' : (reverted ? 'FAILED' : 'CONFIRMING');
      rec.failureReason = reverted ? 'redeem transaction reverted on-chain' : null;
      rec.confirmedAt = confirmed ? new Date().toISOString() : null;
      rec.completedAt = confirmed ? new Date().toISOString() : null;
      op = rec;
    });
    return { operationId: op.operationId, txHash, state: op.state };
  }
}
