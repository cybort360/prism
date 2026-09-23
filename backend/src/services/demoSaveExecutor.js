import { getAddress } from 'viem';
import { splitSignature, verifyTypedData, receiveAuthorizationTypedData } from '../chain/eth.js';
import { chainProvider } from '../providers/index.js';
import { mockVault as realVault } from '../chain/mockVault.js';
import { buildSaveOperation } from '../domain/savePosition.js';
import { redeemAuthorizationTypedData } from '../lib/redeemAuthorization.js';

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

// DemoSaveExecutor — the executor seam for SAVE_MODE=demo. Verifies the user's ERC-3009 authorization
// against the persisted quote, has the relayer submit MockVault.depositWithAuthorization, waits for the
// receipt, and records a real SAVE operation (CREATED → SUBMITTED → SAVED) with the on-chain tx hash.
// No fabricated numbers: shares recorded are read back from the vault after settlement.
export class DemoSaveExecutor {
  constructor({ store, config, identityService, vault = realVault, chain = null, verify = null } = {}) {
    this.store = store;
    this.config = config;
    this.identities = identityService;
    this.vault = vault;
    this.chain = chain ?? chainProvider();
    this.verify = verify; // test seam; defaults to real verifyTypedData below
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

    const receipt = await this.chain.getTransactionReceipt(txHash).catch(() => null);
    const confirmed = receipt && (receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1');
    const sharesReceived = await this.vault.sharesOf(account); // canonical readback

    this.store.mutate((data) => {
      const rec = data.saveOperations[op.operationId];
      rec.transactionHash = txHash;
      rec.blockNumber = receipt?.blockNumber ? Number(receipt.blockNumber) : null;
      rec.sharesReceived = sharesReceived;
      rec.actualAUSD = quote.amountAtomic;      // demo: USDC == asset, 1:1 into the vault's unit
      rec.state = confirmed ? 'SAVED' : 'CONFIRMING';
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
    const params = { owner: account, shares: quote.sharesAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce, vault: getAddress(quote.vault), chainId: this.config.save.substrateChainId };
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
    const receipt = await this.chain.getTransactionReceipt(txHash).catch(() => null);
    const confirmed = receipt && (receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1');
    const outputUSDC = quote.estimatedUSDC ?? await this.vault.convertToAssets(quote.sharesAtomic);

    this.store.mutate((data) => {
      const rec = data.saveOperations[op.operationId];
      rec.transactionHash = txHash;
      rec.blockNumber = receipt?.blockNumber ? Number(receipt.blockNumber) : null;
      rec.outputUSDC = outputUSDC;
      rec.state = confirmed ? 'AVAILABLE' : 'CONFIRMING';
      rec.confirmedAt = confirmed ? new Date().toISOString() : null;
      rec.completedAt = confirmed ? new Date().toISOString() : null;
      op = rec;
    });
    return { operationId: op.operationId, txHash, state: op.state };
  }
}
