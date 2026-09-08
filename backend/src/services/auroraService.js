import { auroraClient } from '../aurora/index.js';
import { routableChains, resolveAsset, chainLabel, knownChain, isEvmChain } from '../aurora/assets.js';
import { assertRouteTransition, routeStateForStatus, AURORA_TERMINAL_STATES } from '../lib/lifecycle.js';
import { logger } from '../lib/logger.js';
import { envioIndexer } from '../indexers/index.js';

/**
 * Aurora Intents integration: receive from any chain, send/spend to any chain.
 *
 * Receive is a persistent deposit address per (user, source chain). Aurora watches that address on
 * the source chain, routes whatever arrives through NEAR Intents, and delivers USDC on Monad to the
 * user's Mera account. Prism holds no custody at any point and signs nothing for an inbound deposit
 * — the address belongs to the user's own account.
 *
 * Two honesty rules run through this whole service:
 *   1. Aurora status is reported, never inferred. If the status call fails we say we don't know.
 *   2. In `preview` mode nothing claims delivery. NEAR Intents carries Monad MAINNET (143) while
 *      Prism's contracts are on testnet (10143), so a route quoted here cannot settle against this
 *      deployment, and a deposit address routes to the user's account on mainnet rather than to the
 *      balance this app reads. Both facts are surfaced to the client, not smoothed over.
 */
export class AuroraService {
  constructor({ store, config, identityService }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
  }

  get mode() { return this.config.aurora.mode; }

  /** Whether the routed leg can actually settle against this deployment's chain. */
  get settlementAvailable() { return this.mode === 'live'; }

  _assertAvailable() {
    if (!auroraClient().available()) {
      throw httpError(503, 'cross-chain routing is not configured (AURORA_APP_KEY)');
    }
  }

  _account(prismId) {
    const identity = this.identityService.get(prismId);
    if (!identity?.accountAddress) throw httpError(409, 'account not ready');
    return identity.accountAddress;
  }

  /**
   * A preview-mode notice the client renders verbatim next to any address or route. Kept here rather
   * than in the app so the reason can never drift from the configuration that caused it.
   */
  _previewNotice() {
    if (this.settlementAvailable) return null;
    return {
      mode: this.mode,
      headline: 'Preview — routes are quoted, not settled',
      detail: `Aurora routes to Monad mainnet. Prism is running against chain ${this.config.chain.chainId}, so a deposit reaches your account on mainnet and will not appear in the balance shown here.`
    };
  }

  // ---- catalogue -----------------------------------------------------------

  /** Source chains and assets Prism can receive from, or route out to. */
  async chains() {
    this._assertAvailable();
    const chains = await routableChains();
    if (!chains) throw httpError(503, 'the Aurora asset directory is unavailable');
    return {
      mode: this.mode,
      settlementAvailable: this.settlementAvailable,
      notice: this._previewNotice(),
      destinationChain: this.config.aurora.destinationChain,
      chains
    };
  }

  // ---- receive: persistent deposit addresses -------------------------------

  /**
   * Create (or return) the caller's permanent deposit address for a source chain. Aurora derives the
   * address deterministically from (recipient, depositChain, destinationChain, destinationAsset), so
   * repeat calls are free and return the same address with `alreadyExists: true`. All EVM chains
   * share one address, which is exactly what the picker should communicate.
   */
  async createDepositAddress({ prismId, depositChain }) {
    this._assertAvailable();
    const chain = String(depositChain ?? '').trim().toLowerCase();
    if (!chain) throw httpError(400, 'depositChain is required');
    if (!knownChain(chain)) throw httpError(400, `unsupported source chain '${chain}'`);

    const recipient = this._account(prismId);
    const destinationChain = this.config.aurora.destinationChain;
    const destination = await resolveAsset(destinationChain, 'USDC');
    if (!destination.ok) throw httpError(503, `cannot resolve USDC on ${chainLabel(destinationChain)}: ${destination.reason}`);

    const created = await auroraClient().persistentAddress({
      recipient,
      // Attribution only. This is the user's EVM account address — never a phone number, never a
      // phone-derived value, never a Prism identifier.
      sender: recipient,
      depositChain: chain,
      destinationChain,
      destinationAsset: destination.asset.assetId
    });
    if (!created?.depositAddress) throw httpError(502, 'Aurora did not return a deposit address');

    const record = this.store.mutate((data) => {
      data.auroraDeposits ??= {};
      const key = created.depositAddress.toLowerCase();
      const existing = data.auroraDeposits[key];
      if (existing) {
        // A deposit address is derived from the recipient account, so a collision across identities
        // should be impossible. If it ever happens, refuse rather than hand one user another's address.
        if (existing.prismId !== prismId) throw httpError(409, 'deposit address belongs to another account');
        existing.lastSeenAt = new Date().toISOString();
        return existing;
      }
      const fresh = {
        depositAddress: created.depositAddress,
        memo: created.memo ?? null,
        prismId,
        recipientAccount: recipient,
        depositChain: chain,
        depositChainLabel: chainLabel(chain),
        sharedAcrossEvmChains: isEvmChain(chain),
        destinationChain,
        destinationAssetId: destination.asset.assetId,
        destinationSymbol: destination.asset.symbol,
        correlationId: created.correlationId ?? null,
        state: 'awaiting_deposit',
        lastStatus: null,
        lastCheckedAt: null,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        history: []
      };
      data.auroraDeposits[key] = fresh;
      return fresh;
    });

    logger.info('aurora.deposit.address', { prismId, depositChain: chain, alreadyExists: Boolean(created.alreadyExists) });
    return { ...this._publicDeposit(record), alreadyExists: Boolean(created.alreadyExists) };
  }

  /** Every deposit address the caller has generated. */
  listDeposits(prismId) {
    const all = this.store.read().auroraDeposits ?? {};
    const mine = Object.values(all)
      .filter((d) => d.prismId === prismId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      mode: this.mode,
      settlementAvailable: this.settlementAvailable,
      notice: this._previewNotice(),
      deposits: mine.map((d) => this._publicDeposit(d))
    };
  }

  /**
   * USDC that has actually arrived at the caller's account on Monad, from Envio's index.
   *
   * A routed deposit lands as an ordinary token transfer touching no Prism contract, so there is no
   * Prism event to key off and the index is the only way to attribute it. It is a projection, never
   * a ledger: `indexed: false` means we cannot say what arrived, not that nothing did, and the
   * balance the app shows still comes from an on-chain read.
   */
  async arrivals(prismId, { limit = 25 } = {}) {
    const account = this._account(prismId);
    const indexer = envioIndexer();
    if (!indexer.available()) {
      return { indexed: false, reason: 'the activity index is not configured', account, arrivals: [] };
    }
    const transfers = await indexer.getIncomingTransfers(account, limit);
    // A user's own outbound payments come back through the router, so exclude transfers they sent.
    const inbound = transfers.filter((t) => String(t.from ?? '').toLowerCase() !== account.toLowerCase());
    return {
      indexed: true,
      account,
      settlementAvailable: this.settlementAvailable,
      notice: this._previewNotice(),
      arrivals: inbound.map((t) => ({
        from: t.from,
        amountAtomic: String(t.value),
        symbol: 'USDC',
        txHash: t.txHash,
        blockNumber: t.blockNumber ?? null,
        timestamp: t.timestamp ?? null,
        // Whether this specific transfer came from an Aurora route is not knowable from the token
        // event alone — say so rather than labelling every inbound transfer as cross-chain.
        source: 'monad'
      }))
    };
  }

  /**
   * Refresh one deposit address against Aurora's live status API.
   * An unreachable status service leaves the stored state untouched and says so — it never degrades
   * a known state into a guess.
   */
  async refreshDeposit({ prismId, depositAddress }) {
    this._assertAvailable();
    const key = String(depositAddress ?? '').toLowerCase();
    const existing = (this.store.read().auroraDeposits ?? {})[key];
    if (!existing) throw httpError(404, 'deposit address not found');
    if (existing.prismId !== prismId) throw httpError(403, 'deposit address belongs to another account');

    const status = await auroraClient().status({ depositAddress: existing.depositAddress, depositMemo: existing.memo });
    if (!status?.status) {
      // No deposit has been seen yet, or the status service is down. Both are "nothing new", and
      // neither is grounds for inventing progress.
      return { ...this._publicDeposit(existing), statusKnown: false };
    }

    const updated = this._applyStatus(key, status);
    return { ...this._publicDeposit(updated), statusKnown: true };
  }

  /**
   * Fold an Aurora status into a stored deposit record. Guarded by AURORA_TRANSITIONS so a late or
   * out-of-order status poll can never walk a terminal route backwards.
   */
  _applyStatus(key, status) {
    const next = routeStateForStatus(status.status);
    return this.store.mutate((data) => {
      const record = data.auroraDeposits[key];
      record.lastStatus = status.status;
      record.lastCheckedAt = new Date().toISOString();
      if (!next) {
        // An status value Aurora added after this build. Record it, do not act on it.
        logger.warn('aurora.status.unknown', { status: status.status });
        return record;
      }
      const from = record.state === 'awaiting_deposit' ? 'quoted' : record.state;
      if (AURORA_TERMINAL_STATES.includes(record.state) && record.state !== next) return record;
      assertRouteTransition(from, next);
      if (record.state !== next) {
        record.state = next;
        record.history.push({ state: next, status: status.status, at: new Date().toISOString() });
      }
      if (status.swapDetails) record.swapDetails = status.swapDetails;
      return record;
    });
  }

  _publicDeposit(record) {
    return {
      depositAddress: record.depositAddress,
      memo: record.memo,
      depositChain: record.depositChain,
      depositChainLabel: record.depositChainLabel,
      sharedAcrossEvmChains: record.sharedAcrossEvmChains,
      destinationChain: record.destinationChain,
      destinationSymbol: record.destinationSymbol,
      recipientAccount: record.recipientAccount,
      state: record.state,
      lastStatus: record.lastStatus,
      lastCheckedAt: record.lastCheckedAt,
      createdAt: record.createdAt,
      history: record.history ?? [],
      settlementAvailable: this.settlementAvailable,
      notice: this._previewNotice()
    };
  }
}

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
