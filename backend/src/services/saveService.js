import { randomHex } from '../lib/crypto.js';
import { buildPreviewPlan, verifySaveExecutionPlan } from '../lib/saveRoute.js';
import { withdrawModes } from '../lib/saveWithdraw.js';
import { logger } from '../lib/logger.js';

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
  constructor({ store, config, identityService, routeProvider }) {
    this.store = store;
    this.config = config;
    this.identityService = identityService;
    this.routeProvider = routeProvider ?? new DevSaveRouteProvider(config);
  }

  /** The Save home surface. No stored position — reads only, always honest that it is not live yet. */
  state(prismId) {
    const s = this.config.save;
    return {
      enabled: s.enabled,
      live: s.substrateVerified,
      substrateVerified: s.substrateVerified,
      notLiveReason: s.substrateVerified ? null : 'Save is a preview — it goes live once earnAUSD is connected',
      // A preview never shows a position it cannot prove from chain truth.
      position: { shares: '0', valueAtomic: '0', currency: 'USDC' },
      rate: { available: false, apyBps: null, reason: 'Variable rate, shown when Save connects to earnAUSD' }
    };
  }

  /** Quote a Save. Validates the amount, resolves the user's own account as the share receiver, and
   *  returns a money-safe SaveQuote. Writes NOTHING. */
  quote({ prismId, amountAtomic }) {
    if (!this.config.save.enabled) throw httpError(404, 'Save is not enabled on this deployment');
    if (!/^[0-9]+$/.test(String(amountAtomic))) throw httpError(400, 'amount must be an integer base-unit string');
    const amount = BigInt(amountAtomic);
    if (amount <= 0n) throw httpError(400, 'amount must be positive');
    if (amount > BigInt(this.config.save.maxSaveAtomic)) throw httpError(400, 'amount exceeds the Save limit');

    const identity = this.identityService.get(prismId);
    if (!identity?.accountAddress) throw httpError(409, 'no Prism account for this user');

    const quote = this.routeProvider.quoteSaveRoute({ account: identity.accountAddress, amountAtomic: String(amount) });
    // Self-check the plan against the same verifier the client runs — a preview plan is expected to fail
    // executability (no share floor), which is the honest not-live signal, never a silent pass.
    const verification = verifySaveExecutionPlan(quote.transactionPlan, {
      chainId: this.config.save.substrateChainId, account: identity.accountAddress,
      usdc: this.config.save.substrateUsdc, ausd: this.config.save.ausd,
      earnAusdVault: this.config.save.earnAusdVault, swapRouter: this.config.save.swapRouter,
      inputAmount: String(amount)
    });
    logger.info('save.quote', { prismId, provider: quote.provider, live: quote.live, executable: verification.ok });
    return { ...quote, planExecutable: verification.ok };
  }

  /** Withdraw-mode quote: earnAUSD → AUSD → USDC, back to the user's spendable balance. In preview neither
   *  mode's economics are observable, so both are unavailable (fees are never invented as "free"). */
  withdrawQuote({ prismId, sharesAtomic }) {
    if (!this.config.save.enabled) throw httpError(404, 'Save is not enabled on this deployment');
    if (!/^[0-9]+$/.test(String(sharesAtomic ?? ''))) throw httpError(400, 'shares must be an integer base-unit string');
    const identity = this.identityService.get(prismId);
    if (!identity?.accountAddress) throw httpError(409, 'no Prism account for this user');
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
