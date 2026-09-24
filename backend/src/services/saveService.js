import { randomHex } from '../lib/crypto.js';
import { buildPreviewPlan, verifySaveExecutionPlan } from '../lib/saveRoute.js';
import { withdrawModes } from '../lib/saveWithdraw.js';
import { SaveStrategyRegistry } from '../lib/saveStrategy.js';
import { SaveEligibilityService, realSaveEnabled } from './saveEligibilityService.js';
import { logger } from '../lib/logger.js';
import { DemoVaultSaveRouteProvider } from '../lib/demoSaveProviders.js';
import { mockVault } from '../chain/mockVault.js';

// V1 "optimized yield" — the ONLY promise Prism makes about where savings go. Deposits land in the one
// approved strategy (earnAUSD), whose curator reallocates within its own policy. Prism never chases the
// numerically highest APY across arbitrary protocols. This copy is the source of truth for the product;
// clients render it verbatim. Never "highest yield" / "best APY" / "guaranteed returns".
export const SAVE_MANAGED_COPY = Object.freeze({
  headline: 'Save once. The underlying strategy manages where your savings earn.',
  detail: 'Your savings are automatically managed across approved yield strategies by the underlying earnAUSD vault.'
});

// Prism Save — put USDC already held in a Prism account to work in AUSD's earnAUSD vault. The consumer
// sees only: USDC → Save → amount → rate → approve → done. The substrate (AUSD/earnAUSD) is hidden.
//
// STATUS: the earnAUSD deposit ABI is not yet independently verified, and the vault lives on Monad
// mainnet (143) while Prism runs on testnet (10143) — see docs/SAVE_DEPENDENCY_AUDIT.md. So this ships
// as an ANNOUNCED preview: quotes and the flow work, the client independently verifies the plan, but no
// real deposit is produced, no APY is invented, and NO financial state is written. A real
// SaveRouteProvider drops in behind the same seam once the substrate is verified.

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

/** The route-provider seam (Phase 2). `quoteSaveRoute` returns a SaveQuote. */
export class DevSaveRouteProvider {
  constructor(config) { this.config = config; }
  get name() { return 'dev-preview'; }

  quoteSaveRoute({ account, amountAtomic }) {
    const s = this.config.save;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    // Two $1 stables ⇒ a ~1:1 illustration for the review, explicitly flagged. No slippage/min/shares are
    // invented: preview cannot guarantee them, so they stay null/0 and the plan verifies as NOT executable.
    const plan = buildPreviewPlan({
      chainId: s.substrateChainId, account, usdc: s.substrateUsdc, ausd: s.ausd,
      earnAusdVault: s.earnAusdVault, swapRouter: s.swapRouter, inputAmount: amountAtomic, minAusd: '0', deadline
    });
    return {
      quoteId: `save_${randomHex(16).slice(2)}`,
      provider: this.name,
      live: false,
      substrateVerified: false,
      notLiveReason: 'earnAUSD is not connected on this deployment (mainnet-only substrate, deposit ABI unverified)',
      expiresAt: new Date(deadline * 1000).toISOString(),
      inputAsset: 'USDC',
      inputAmount: String(amountAtomic),
      intermediateAsset: 'AUSD',
      estimatedAUSD: String(amountAtomic),   // illustrative 1:1 (both are $1 stables)
      estimatedAUSDIllustrative: true,
      minimumAUSD: null,
      vault: s.earnAusdVault,
      estimatedShares: null,
      minimumShares: null,
      swapFee: null,
      priceImpact: null,
      vaultFee: null,
      networkFeeSponsored: true,
      rate: { available: false, apyBps: null, reason: 'Rate is set when Save connects to earnAUSD' },
      // The consumer review surface. Money-safe integer base units + the fields the user sees before
      // Face ID/PIN. In preview the invested amount is an illustrative 1:1 (both are $1 stables), the
      // conversion cost is 0, minimums/APY are unavailable — all explicitly flagged, never invented.
      review: {
        youSaveAtomic: String(amountAtomic),
        estimatedInvestedAtomic: String(amountAtomic),
        estimatedInvestedIllustrative: true,
        conversionCostAtomic: String(BigInt(amountAtomic) - BigInt(amountAtomic)),  // 0 in the 1:1 preview
        conversionCostBps: 0,
        minimumInvestedAtomic: null,
        apy: { available: false, apyBps: null },
        expiresInSeconds: 300,
        live: false
      },
      transactionPlan: plan
    };
  }
}

export class SaveService {
  constructor({ store, config, identityService, routeProvider, eligibilityService, strategyRegistry }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.routeProvider = routeProvider ?? (config.save.mode === 'demo'
      ? new DemoVaultSaveRouteProvider(config, mockVault)
      : new DevSaveRouteProvider(config));
    this.eligibility = eligibilityService ?? new SaveEligibilityService({ config });
    // Only the approved earnAUSD strategy is registered and enabled in V1.
    this.strategies = strategyRegistry ?? new SaveStrategyRegistry();
  }

  /** The strategy V1 deposits into — always the approved earnAUSD strategy, never a computed "best APY". */
  activeStrategy() {
    const s = this.strategies.active();
    return s && { strategyId: s.strategyId, name: s.name, positionAsset: s.positionAsset, riskTier: s.riskTier, curator: s.curator };
  }

  /** The Save home surface. No stored position — reads only, always honest that it is not live yet. */
  state(prismId) {
    const s = this.config.save;
    const eligibility = this.eligibility.snapshot();
    return {
      enabled: s.enabled,
      live: s.substrateVerified,
      demo: s.mode === 'demo',
      substrateVerified: s.substrateVerified,
      // Real-money Save requires BOTH a verified substrate AND an ELIGIBLE determination.
      realMoneyEnabled: realSaveEnabled({ substrateVerified: s.substrateVerified, eligibility: eligibility.status }),
      notLiveReason: s.substrateVerified ? null : (s.mode === 'demo'
        ? 'Demo — simulated yield on testnet, not real earnAUSD'
        : 'Save is a preview — it goes live once earnAUSD is connected'),
      // How savings are managed. Verbatim consumer copy — never "highest yield" or "guaranteed".
      managed: SAVE_MANAGED_COPY,
      strategy: this.activeStrategy(),
      eligibility,
      // A preview never shows a position it cannot prove from chain truth.
      position: { shares: '0', valueAtomic: '0', currency: 'USDC' },
      rate: { available: false, apyBps: null, reason: 'Variable rate, shown when Save connects to earnAUSD' }
    };
  }

  /** Per-user eligibility for the dedicated endpoint. Async — consults the compliance provider. */
  async checkEligibility(prismId) {
    return this.eligibility.check(prismId);
  }

  /** Quote a Save. Validates the amount, resolves the user's own account as the share receiver, and
   *  returns a money-safe SaveQuote. Writes NOTHING. */
  async quote({ prismId, amountAtomic }) {
    if (!this.config.save.enabled) throw httpError(404, 'Save is not enabled on this deployment');
    if (!/^[0-9]+$/.test(String(amountAtomic))) throw httpError(400, 'amount must be an integer base-unit string');
    const amount = BigInt(amountAtomic);
    if (amount <= 0n) throw httpError(400, 'amount must be positive');
    if (amount > BigInt(this.config.save.maxSaveAtomic)) throw httpError(400, 'amount exceeds the Save limit');

    const identity = this.identityService.get(prismId);
    if (!identity?.accountAddress) throw httpError(409, 'no Prism account for this user');

    const quote = await this.routeProvider.quoteSaveRoute({ account: identity.accountAddress, amountAtomic: String(amount) });

    let planExecutable = true;
    if (this.config.save.mode !== 'demo') {
      // Self-check the plan against the same verifier the client runs — a preview plan is expected to fail
      // executability (no share floor), which is the honest not-live signal, never a silent pass.
      const verification = verifySaveExecutionPlan(quote.transactionPlan, {
        chainId: this.config.save.substrateChainId, account: identity.accountAddress,
        usdc: this.config.save.substrateUsdc, ausd: this.config.save.ausd,
        earnAusdVault: this.config.save.earnAusdVault, swapRouter: this.config.save.swapRouter,
        inputAmount: String(amount)
      });
      planExecutable = verification.ok;
    }

    if (this.config.save.mode === 'demo') {
      this.store.mutate((data) => {
        data.saveQuotes ??= {};
        data.saveQuotes[quote.quoteId] = {
          quoteId: quote.quoteId, kind: 'SAVE', prismId, account: identity.accountAddress,
          amountAtomic: String(amount), vault: quote.vault, nonce: quote.nonce, deadline: quote.deadline,
          minimumShares: quote.minimumShares, estimatedShares: quote.estimatedShares, createdAt: new Date().toISOString()
        };
      });
    }

    logger.info('save.quote', { prismId, provider: quote.provider, live: quote.live, executable: planExecutable });
    return { ...quote, managed: SAVE_MANAGED_COPY, strategy: this.activeStrategy(), planExecutable };
  }

  /** Withdraw-mode quote: earnAUSD → AUSD → USDC, back to the user's spendable balance. In preview neither
   *  mode's economics are observable, so both are unavailable (fees are never invented as "free"). */
  async withdrawQuote({ prismId, sharesAtomic }) {
    if (!this.config.save.enabled) throw httpError(404, 'Save is not enabled on this deployment');
    if (!/^[0-9]+$/.test(String(sharesAtomic ?? ''))) throw httpError(400, 'shares must be an integer base-unit string');
    const identity = this.identityService.get(prismId);
    if (!identity?.accountAddress) throw httpError(409, 'no Prism account for this user');

    if (this.config.save.mode === 'demo') {
      const { redeemAuthorizationTypedData } = await import('../lib/redeemAuthorization.js');
      const vault = this.config.save.mockVault;
      const estimatedUSDC = await mockVault.convertToAssets(String(sharesAtomic));
      const nonce = randomHex(32);
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const quoteId = `wd_${randomHex(16).slice(2)}`;
      this.store.mutate((data) => {
        data.saveQuotes ??= {};
        data.saveQuotes[quoteId] = { quoteId, kind: 'WITHDRAW_INSTANT', prismId, account: identity.accountAddress, sharesAtomic: String(sharesAtomic), vault, nonce, deadline, estimatedUSDC };
      });
      return {
        quoteId, demo: true, live: false, returnsTo: 'USDC', estimatedUSDC,
        notLiveReason: 'Demo — simulated yield on testnet, not real earnAUSD',
        authorization: redeemAuthorizationTypedData({ owner: identity.accountAddress, shares: String(sharesAtomic), validAfter: 0, validBefore: deadline, nonce, vault, chainId: Number(this.config.chain.chainId) }),
        nonce, deadline
      };
    }

    const live = this.config.save.substrateVerified === true;
    return {
      quoteId: `wd_${randomHex(16).slice(2)}`,
      live,
      notLiveReason: live ? null : 'earnAUSD is not connected on this deployment (mainnet-only substrate, deposit ABI unverified)',
      // Normal Prism money is USDC — a withdrawal returns to USDC, not AUSD.
      returnsTo: 'USDC',
      modes: withdrawModes({ sharesAtomic: String(sharesAtomic), live })
    };
  }
}
