import { auroraClient } from '../aurora/index.js';
import { routableChains, resolveAsset, validateDestinationAddress, chainLabel, knownChain, isEvmChain } from '../aurora/assets.js';
import { assertRouteTransition, routeStateForStatus, AURORA_TERMINAL_STATES } from '../lib/lifecycle.js';
import { routeHash } from '../chain/eth.js';
import { randomHex } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { envioIndexer } from '../indexers/index.js';
import { chainProvider } from '../providers/index.js';

// How long a quote stays good. Aurora prices a route for a short window; long enough for a person to
// read the numbers and approve with Face ID, short enough that they are never funding a stale price.
const QUOTE_WINDOW_MS = 3 * 60_000;
// 1%. Sent to Aurora as the slippage bound; the quote's minAmountOut is what the user is shown and
// what gets bound into their signature.
const SLIPPAGE_BPS = 100;

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
  constructor({ store, config, identityService, paymentService, chain = null }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.paymentService = paymentService;
    this.chain = chain ?? chainProvider();
  }

  get mode() { return this.config.aurora.mode; }

  /** Whether the routed leg can actually settle against this deployment's chain. */
  get settlementAvailable() { return this.mode === 'live' || this.mode === 'demo'; }

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
   * A mode-aware notice the client renders verbatim next to any address or route. Kept here rather
   * than in the app so the reason can never drift from the configuration that caused it.
   */
  _modeNotice() {
    if (this.mode === 'live') return null;
    if (this.mode === 'demo') return {
      mode: 'demo',
      headline: 'Demo — cross-chain receive is simulated',
      detail: 'The deposit event is simulated; the USDC credited to your balance is real testnet USDC.'
    };
    // preview (unchanged copy):
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
      notice: this._modeNotice(),
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
      notice: this._modeNotice(),
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
      notice: this._modeNotice(),
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

  // Minimal MockUSDC mint ABI — demo delivery credits real testnet USDC to the user's own account.
  static get MINT_ABI() {
    return [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }];
  }

  /**
   * Demo-only: simulate an inbound cross-chain deposit. The relayer mints real testnet USDC to the
   * caller's own account (a genuine on-chain credit — money-truth holds) and the deposit advances to
   * `delivered`. Only the "a deposit arrived on chain X" event is simulated; the money is real.
   */
  async simulateInboundDeposit({ prismId, depositAddress, sourceChain, amountAtomic }) {
    if (this.mode !== 'demo') throw httpError(409, 'demo deposits are only available in AURORA_MODE=demo');
    if (!/^\d+$/.test(String(amountAtomic)) || BigInt(amountAtomic) <= 0n) throw httpError(400, 'amount must be a positive integer');
    const key = String(depositAddress ?? '').toLowerCase();
    const existing = (this.store.read().auroraDeposits ?? {})[key];
    if (!existing) throw httpError(404, 'deposit address not found');
    if (existing.prismId !== prismId) throw httpError(403, 'deposit address belongs to another account');
    const account = this._account(prismId);

    // Real on-chain credit: mint testnet USDC to the user. (If this deployment's USDC is not the
    // mintable mock, replace with a transfer from a funded relayer balance — same shape.)
    const { getAddress } = await import('viem');
    const txHash = await this.chain.writeContract({
      address: getAddress(this.config.chain.usdc), abi: AuroraService.MINT_ABI, functionName: 'mint',
      args: [getAddress(account), BigInt(amountAtomic)]
    });
    await this.chain.getTransactionReceipt(txHash).catch(() => null);

    // Advance the deposit to delivered through the existing status machine ('SUCCESS' -> 'delivered').
    const updated = this._applyStatus(key, { status: 'SUCCESS', swapDetails: { sourceChain, amountAtomic, demo: true, txHash } });
    logger.info('aurora.demo.deposit', { prismId, sourceChain, amountAtomic });
    return { txHash, deposit: this._publicDeposit(updated) };
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

  // ---- send / spend: outbound routes ---------------------------------------

  /**
   * Quote a route out of USDC on Monad into any asset on any chain.
   *
   * Nothing is committed here — this only reserves a route record and returns Aurora's real pricing
   * so the user can see the deal before approving it. The destination address is validated BEFORE
   * quoting, so a malformed address is rejected while it is still cheap to fix rather than after a
   * signature exists.
   */
  async quoteSend({ prismId, destinationChain, destinationAsset, destinationAddress, amountAtomic, contractAddress = null }) {
    this._assertAvailable();
    const chain = String(destinationChain ?? '').trim().toLowerCase();
    if (!knownChain(chain)) throw httpError(400, `unsupported destination chain '${chain}'`);

    const address = String(destinationAddress ?? '').trim();
    const validity = validateDestinationAddress(chain, address);
    if (!validity.ok) throw httpError(400, validity.reason);

    if (!/^\d+$/.test(String(amountAtomic)) || BigInt(amountAtomic) <= 0n) throw httpError(400, 'amount must be positive');
    if (BigInt(amountAtomic) > this.config.limits.maxPaymentAtomic) throw httpError(400, 'amount exceeds the Prism limit');

    const originChain = this.config.aurora.destinationChain;
    const origin = await resolveAsset(originChain, 'USDC');
    if (!origin.ok) throw httpError(503, `cannot resolve USDC on ${chainLabel(originChain)}: ${origin.reason}`);
    const destination = await resolveAsset(chain, destinationAsset, { contractAddress });
    if (!destination.ok) throw httpError(400, destination.reason, destination.options);

    const sender = this._account(prismId);
    const deadline = new Date(Date.now() + QUOTE_WINDOW_MS).toISOString();
    const quoted = await auroraClient().quote({
      // preview quotes are dry: real routing and real pricing, but Aurora issues no deposit address,
      // so the route can be shown and cannot be funded. That is the intended behaviour on testnet.
      dry: !this.settlementAvailable,
      swapType: 'EXACT_INPUT',
      depositType: 'ORIGIN_CHAIN',
      amount: String(amountAtomic),
      originAsset: origin.asset.assetId,
      destinationAsset: destination.asset.assetId,
      slippageTolerance: SLIPPAGE_BPS,
      recipient: address,
      recipientType: 'DESTINATION_CHAIN',
      // A failed route refunds to the sender's own Prism account, so their money comes back to the
      // balance they already have rather than somewhere they have to go and retrieve it.
      refundTo: sender,
      refundType: 'ORIGIN_CHAIN',
      deadline
    });
    if (!quoted?.quote) throw httpError(502, 'Aurora could not quote this route');

    const routeId = randomHex(16);
    const record = {
      routeId,
      prismId,
      senderAccount: sender,
      state: 'quoted',
      amountInAtomic: String(amountAtomic),
      origin: { chain: originChain, assetId: origin.asset.assetId, symbol: origin.asset.symbol, decimals: origin.asset.decimals },
      destination: {
        chain, chainLabel: chainLabel(chain), address,
        assetId: destination.asset.assetId, symbol: destination.asset.symbol,
        decimals: destination.asset.decimals, addressVerified: validity.strict
      },
      depositAddress: quoted.quote.depositAddress ?? null,
      depositMemo: quoted.quote.depositMemo ?? null,
      amountOut: quoted.quote.amountOut ?? null,
      minAmountOut: quoted.quote.minAmountOut ?? null,
      timeEstimateSeconds: quoted.quote.timeEstimate ?? null,
      quoteDeadline: quoted.quote.deadline ?? deadline,
      // Aurora's own signature over the quote. Stored so "this deposit address came from this signed
      // quote" is checkable after the fact rather than merely asserted by us.
      quoteSignature: quoted.signature ?? null,
      correlationId: quoted.correlationId ?? null,
      settlementAvailable: this.settlementAvailable,
      paymentId: null,
      depositNotified: false,
      createdAt: new Date().toISOString(),
      history: []
    };
    this.store.mutate((data) => { data.auroraRoutes ??= {}; data.auroraRoutes[routeId] = record; });
    logger.info('aurora.route.quoted', { routeId, prismId, destinationChain: chain, dry: !this.settlementAvailable });
    return this._publicRoute(record);
  }

  /**
   * Freeze a quoted route into a signable payment.
   *
   * The whole route — deposit address, destination chain, destination asset, recipient, guaranteed
   * minimum, quote expiry — is folded into `routeHash` and placed in the envelope's opaque hash
   * slot. The payer's single signature therefore covers the entire promise, not just "send N USDC to
   * this address". Rewriting any of it afterwards invalidates the signature and the transaction
   * reverts.
   */
  async prepareSend({ prismId, routeId }) {
    this._assertAvailable();
    const route = this._ownedRoute(routeId, prismId);
    if (route.state !== 'quoted') throw httpError(409, `route is already ${route.state}`);
    // Preparing twice must not mint a second envelope against one quote — both would be signable,
    // and only one of them is the payment anyone is tracking. A retry returns the same payload.
    if (route.paymentId) {
      const resumed = this.paymentService.resumePrepared(route.paymentId, prismId);
      if (!resumed) throw httpError(409, 'this route already has a payment in flight');
      return { ...resumed, route: this._publicRoute(route) };
    }
    if (!route.depositAddress) {
      throw httpError(409, 'this route was quoted in preview mode and has no deposit address, so it cannot be funded');
    }
    this._assertQuoteFresh(route);

    const bound = routeHash({
      routeId: route.routeId,
      depositAddress: route.depositAddress,
      destinationChain: route.destination.chain,
      destinationAssetId: route.destination.assetId,
      destinationRecipient: route.destination.address,
      minAmountOut: route.minAmountOut ?? '0',
      quoteDeadline: Math.floor(Date.parse(route.quoteDeadline) / 1000)
    });

    const prepared = await this.paymentService.prepareExternalSend({
      senderPrismId: prismId,
      recipientAddress: route.depositAddress,
      amountAtomic: route.amountInAtomic,
      boundHash: bound,
      kind: 'aurora-send',
      intent: { routeId: route.routeId, entryMethod: 'anyChain' }
    });

    this.store.mutate((data) => {
      const r = data.auroraRoutes[routeId];
      r.paymentId = prepared.paymentId;
      r.routeHash = bound;
    });
    return { ...prepared, route: this._publicRoute(this._route(routeId)) };
  }

  /**
   * Relay the Monad leg. The quote deadline is re-checked here rather than only at prepare: a user
   * can sit on an approval sheet, and funding a lapsed quote would send real money into a route
   * Aurora may no longer honour at the price they were shown.
   */
  async submitSend({ prismId, routeId, prismSignature, tokenSignature }) {
    this._assertAvailable();
    const route = this._ownedRoute(routeId, prismId);
    if (!route.paymentId) throw httpError(409, 'route has not been prepared');
    this._assertQuoteFresh(route);

    const result = await this.paymentService.submitPayment({
      paymentId: route.paymentId, prismSignature, tokenSignature, actorPrismId: prismId
    });
    // The Monad leg is away; the routed leg has not started until Aurora sees the deposit.
    this._transitionRoute(routeId, 'funding', { status: null });
    return { ...result, route: this._publicRoute(this._route(routeId)) };
  }

  /**
   * Reconcile both legs: the Monad payment from chain truth, then the routed leg from Aurora.
   *
   * The two are deliberately independent. A confirmed Monad transaction does not mean delivery, and
   * this never lets one imply the other — the route only advances on what Aurora actually reports.
   */
  async reconcileRoute({ prismId, routeId }) {
    this._assertAvailable();
    let route = this._ownedRoute(routeId, prismId);

    let payment = null;
    if (route.paymentId) {
      payment = await this.paymentService.reconcile(route.paymentId, prismId).catch(() => null);
    }

    // The funding transaction reverted, so nothing was ever deposited and no route exists to track.
    if (payment?.state === 'failed') {
      route = this._transitionRoute(routeId, 'route_failed', { status: 'FUNDING_REVERTED' });
      return { route: this._publicRoute(route), payment };
    }

    if (payment?.state === 'completed') {
      // Best-effort accelerant: tell Aurora which transaction funded the address. It detects the
      // deposit on its own regardless, so a failure here is not an error and carries no state.
      if (!route.depositNotified) {
        const notified = await auroraClient().submitDeposit({
          txHash: payment.transactionHash ?? payment.txHash, depositAddress: route.depositAddress, memo: route.depositMemo
        });
        this.store.mutate((data) => { data.auroraRoutes[routeId].depositNotified = Boolean(notified); });
      }
      const status = await auroraClient().status({ depositAddress: route.depositAddress, depositMemo: route.depositMemo });
      if (status?.status) {
        const next = routeStateForStatus(status.status);
        if (next) route = this._transitionRoute(routeId, next, { status: status.status, swapDetails: status.swapDetails });
        else logger.warn('aurora.status.unknown', { status: status.status });
        return { route: this._publicRoute(this._route(routeId)), payment, statusKnown: true };
      }
      return { route: this._publicRoute(this._route(routeId)), payment, statusKnown: false };
    }

    return { route: this._publicRoute(route), payment, statusKnown: false };
  }

  listRoutes(prismId) {
    const all = this.store.read().auroraRoutes ?? {};
    const mine = Object.values(all)
      .filter((r) => r.prismId === prismId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      mode: this.mode,
      settlementAvailable: this.settlementAvailable,
      notice: this._modeNotice(),
      routes: mine.map((r) => this._publicRoute(r))
    };
  }

  // ---- route internals -----------------------------------------------------

  _route(routeId) {
    const route = (this.store.read().auroraRoutes ?? {})[routeId];
    if (!route) throw httpError(404, 'route not found');
    return route;
  }

  _ownedRoute(routeId, prismId) {
    const route = this._route(routeId);
    if (route.prismId !== prismId) throw httpError(403, 'route belongs to another caller');
    return route;
  }

  /** A lapsed quote is refused outright — never silently re-quoted into a price the user never saw. */
  _assertQuoteFresh(route) {
    const deadline = Date.parse(route.quoteDeadline);
    if (Number.isFinite(deadline) && deadline <= Date.now()) {
      this._transitionRoute(route.routeId, 'expired', { status: 'QUOTE_EXPIRED' });
      throw httpError(409, 'this quote has expired — request a new one');
    }
  }

  _transitionRoute(routeId, next, { status = null, swapDetails = null } = {}) {
    return this.store.mutate((data) => {
      const route = data.auroraRoutes[routeId];
      if (route.state === next) return route;
      if (AURORA_TERMINAL_STATES.includes(route.state)) return route;
      assertRouteTransition(route.state, next);
      route.state = next;
      if (status) route.lastStatus = status;
      if (swapDetails) route.swapDetails = swapDetails;
      route.lastCheckedAt = new Date().toISOString();
      route.history.push({ state: next, status, at: new Date().toISOString() });
      return route;
    });
  }

  _publicRoute(route) {
    return {
      routeId: route.routeId,
      state: route.state,
      lastStatus: route.lastStatus ?? null,
      amountInAtomic: route.amountInAtomic,
      origin: route.origin,
      destination: route.destination,
      depositAddress: route.depositAddress,
      amountOut: route.amountOut,
      minAmountOut: route.minAmountOut,
      timeEstimateSeconds: route.timeEstimateSeconds,
      quoteDeadline: route.quoteDeadline,
      quoteSignature: route.quoteSignature,
      correlationId: route.correlationId,
      paymentId: route.paymentId,
      createdAt: route.createdAt,
      history: route.history ?? [],
      // False when the quote was dry: the route is real and priced, but has no deposit address and
      // cannot be funded against this deployment.
      fundable: Boolean(route.depositAddress),
      settlementAvailable: this.settlementAvailable,
      notice: this._modeNotice()
    };
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
      notice: this._modeNotice()
    };
  }
}

function httpError(statusCode, message, options = null) {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (options) e.options = options;
  return e;
}
