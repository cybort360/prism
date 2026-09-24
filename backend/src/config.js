import path from 'node:path';

function env(name, fallback = '') { return process.env[name] ?? fallback; }
function requiredHex32(name, fallback) {
  const value = env(name, fallback);
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be 64 hex chars`);
  return value.toLowerCase();
}
function bigintEnv(name, fallback) {
  const value = env(name, fallback);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  return BigInt(value);
}

// Canonical Circle USDC deployments. The backend re-verifies the EIP-712 domain against the live
// contract before relaying in production.
export const USDC_KNOWN = {
  143: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  10143: '0x534b2f3A21130d7a60830c2Df862319e593943A3'
};
export const USDC_DOMAIN = { name: 'USDC', version: '2' };

// Safe Allowance Module releases BEFORE v1.0.0 carry a `uint16` allowance-nonce overflow that lets
// past delegate transfers be replayed. v0.1.1 is deployed on Monad at the address below, and the
// official deployments package hands it to any caller who does not pin a version — so pointing
// Circles at it is the accident this constant exists to make impossible.
export const VULNERABLE_ALLOWANCE_MODULES = new Set([
  '0xaa46724893dedd72658219405185fb0fc91e091c'   // AllowanceModule v0.1.1 (v0.1.0 shares the bug)
]);

// Safe's canonical Allowance Module v1.0.0: the release that fixed the replay. `codeHash` is
// keccak256 of its runtime bytecode, captured byte-identical from two independent chains — see
// contracts/vendor/safe-allowances-v1.0.0/PROVENANCE.md. A module is accepted on CODE, not address:
// a Prism-deployed copy at a different address is fine if its bytecode matches, and the canonical
// address with different bytecode is not.
export const CANONICAL_ALLOWANCE_MODULE_ADDRESS = '0x691f59471Bfd2B7d639DCF74671a2d648ED1E331';
export const CANONICAL_ALLOWANCE_MODULE_CODEHASH =
  '0xfafc86ce3000fbdc8ad155875c0b3b5a20d17662e7c2cdbf3e95f15945a46657';
export const MINIMUM_ALLOWANCE_MODULE_VERSION = '1.0.0';
export const USDC_DECIMALS = 6;

const chainId = BigInt(env('MONAD_CHAIN_ID', '10143'));
function resolveUsdc() {
  const override = env('USDC_ADDRESS');
  if (override) return override;
  const known = USDC_KNOWN[Number(chainId)];
  if (known) return known;
  throw new Error(`USDC_ADDRESS required for unknown chainId ${chainId}`);
}

const usdc = {
  symbol: 'USDC',
  name: 'USD Coin',
  address: resolveUsdc(),
  decimals: USDC_DECIMALS,
  domain: USDC_DOMAIN
};

export const config = {
  port: Number(env('PORT', '8787')),
  nodeEnv: env('NODE_ENV', 'development'),
  storePath: path.resolve(env('STORE_PATH', './data/store.json')),
  sessionSecret: env('SESSION_SECRET', 'dev-session-secret-change-me'),
  resolverPepper: env('RESOLVER_PEPPER', 'dev-resolver-pepper-change-me'),
  dataEncryptionKeyHex: requiredHex32('DATA_ENCRYPTION_KEY', '11'.repeat(32)),
  // Encrypts the backend-internal resolver attestation signer (not a consumer/spending key).
  serviceKeyEncryptionKeyHex: requiredHex32('SERVICE_KEY_ENCRYPTION_KEY', '22'.repeat(32)),
  devOtpCode: env('DEV_OTP_CODE', '123456'),
  // Explicit OTP provider. Defaults to twilio when a Twilio SID is present, otherwise dev. Production
  // must be 'twilio' (enforced in assertSafeConfig) so a prod boot can never accept the dev OTP code.
  otpProvider: env('OTP_PROVIDER', env('TWILIO_ACCOUNT_SID') ? 'twilio' : 'dev'),
  limits: {
    // 10,000 stablecoin units for normal transfers, 1,000 for pre-user claims.
    maxPaymentAtomic: bigintEnv('MAX_PAYMENT_ATOMIC', '10000000000'),
    maxClaimAtomic: bigintEnv('MAX_CLAIM_ATOMIC', '1000000000')
  },
  // Prism Circles: shared USDC accounts governed by a Safe Smart Account on Monad.
  circles: {
    // Verified Safe v1.4.1 deployment on Monad. Every address below had its codehash checked
    // against @safe-global/safe-deployments on-chain — see docs/CIRCLES_DEPENDENCY_AUDIT.md.
    safeSingleton: env('SAFE_SINGLETON', '0x41675C099F32341bf84BFc5382aF534df5C7461a'),
    safeProxyFactory: env('SAFE_PROXY_FACTORY', '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'),
    safeFallbackHandler: env('SAFE_FALLBACK_HANDLER', '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'),
    // Per-member spending limits need Safe's Allowance Module at **v1.0.0 or newer** — the release
    // that fixed an allowance-nonce overflow allowing past delegate transfers to be replayed.
    //
    // As of the last audit no v1.0.0 deployment exists on either Monad network (the canonical
    // address has no code there), and the only Allowance Module that IS deployed on Monad is the
    // vulnerable v0.1.1. So this ships false. Turning it on requires naming a module that passes
    // BOTH gates: `tools/circles/verify-allowance-module.mjs` before the fact, and
    // `AllowanceModuleGate` inside the running server, which re-reads the chain and fails closed.
    // `contracts/script/DeployAllowanceModuleV1.s.sol` deploys Safe's exact upstream runtime if you
    // need one. Never point this at v0.1.x — see `assertCircleLimitsAreSafe`.
    limitsEnabled: env('CIRCLE_LIMITS_ENABLED', 'false') === 'true',
    allowanceModule: env('CIRCLE_ALLOWANCE_MODULE', ''),
    // The codeHash any configured module must have. Overridable only so a future audited release
    // can be adopted deliberately; it is never inferred from whatever happens to be deployed.
    allowanceModuleCodeHash: env('CIRCLE_ALLOWANCE_MODULE_CODEHASH', CANONICAL_ALLOWANCE_MODULE_CODEHASH),
    // Safe Transaction Service: shared storage for pending proposals so co-admins on other devices
    // can see them. Never trusted for authority — every confirmation it returns is re-verified
    // against the digest and the live owner set. Unset = proposals stay local to Prism.
    txServiceUrl: env('SAFE_TX_SERVICE_URL', '')
  },
  twilio: {
    accountSid: env('TWILIO_ACCOUNT_SID'),
    authToken: env('TWILIO_AUTH_TOKEN'),
    verifyServiceSid: env('TWILIO_VERIFY_SERVICE_SID')
  },
  chain: {
    // Production RPC is Alchemy's Monad endpoint; falls back to the public node.
    rpcUrl: env('MONAD_RPC_URL', 'https://testnet-rpc.monad.xyz/'),
    chainId,
    usdc: usdc.address,
    usdcDomain: USDC_DOMAIN,
    usdcDecimals: USDC_DECIMALS,
    paymentRouter: env('PRISM_PAYMENT_ROUTER'),
    claimVault: env('PRISM_CLAIM_VAULT'),
    // MON-funded relayer that submits gasless ERC-3009 transfers so users can hold MON = 0.
    // Production alternative: Alchemy Gas Manager sponsorship.
    relayerPrivateKey: env('RELAYER_PRIVATE_KEY'),
    // Isolated secp256k1 key that authorizes pre-user claim collection (KMS/HSM in production).
    claimAuthorizerPrivateKey: env('CLAIM_AUTHORIZER_PRIVATE_KEY'),
    // Alchemy webhook (Address Activity / Mined Transaction) HMAC signing key for fast live confirmation.
    alchemyWebhookSigningKey: env('ALCHEMY_WEBHOOK_SIGNING_KEY'),
    // Public block explorer base for judge-inspectable transaction links.
    explorerUrl: env('MONAD_EXPLORER_URL', 'https://testnet.monadexplorer.com')
  },
  // Prism Save (USDC → AUSD → earnAUSD). The substrate (AUSD + earnAUSD) is Agora/Upshift on Monad
  // MAINNET (143); Prism's contracts are on testnet (10143), and the earnAUSD deposit ABI is NOT yet
  // independently verified (see docs/SAVE_DEPENDENCY_AUDIT.md). So Save ships as an ANNOUNCED preview:
  // the flow and quotes work, but no real deposit is produced and no yield/APY is invented.
  // `substrateVerified` stays false until the real Teller/deposit ABI is verified; only then may a
  // route provider return an executable plan.
  save: {
    enabled: env('SAVE_ENABLED', 'true') === 'true',
    // Demo mode runs Save end-to-end on TESTNET against MockVault with real USDC + real shares.
    // 'preview' (default) = quotes only, no execution; 'demo' = MockVault on testnet; 'live' = real
    // mainnet earnAUSD (future). Only 'live' is real money on mainnet.
    mode: (() => { const m = env('SAVE_MODE', 'preview'); if (!['preview', 'demo', 'live'].includes(m)) throw new Error("SAVE_MODE must be 'preview', 'demo', or 'live'"); return m; })(),
    demo: env('SAVE_MODE', 'preview') === 'demo',
    mockVault: env('SAVE_MOCK_VAULT', ''),
    substrateVerified: env('SAVE_SUBSTRATE_VERIFIED') === 'true',
    substrateChainId: Number(env('SAVE_SUBSTRATE_CHAIN_ID', '143')),
    inputToken: usdc.address,                 // Save's input is the user's Prism USDC (unchanged asset)
    inputDecimals: USDC_DECIMALS,
    ausd: env('SAVE_AUSD_ADDRESS', '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a'),   // verified Monad-143
    ausdDecimals: 6,
    earnAusdVault: env('SAVE_EARNAUSD_VAULT', '0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA'), // verified 143
    // Swap router (USDC→AUSD) is undecided (no proven route yet); no target is allowlisted until one is.
    swapRouter: env('SAVE_SWAP_ROUTER', ''),
    // The contract a SaveIntent is bound to (EIP-712 verifyingContract) — the batch-capable Prism account
    // or a PrismSaveExecutor once one is deployed. Zero address until then; execution stays gated.
    executor: env('SAVE_EXECUTOR', '0x0000000000000000000000000000000000000000'),
    // Execution policy caps. Economics beyond these must NOT execute.
    maxSlippageBps: Number(env('SAVE_MAX_SLIPPAGE_BPS', '50')),      // 0.50%
    maxPriceImpactBps: Number(env('SAVE_MAX_PRICE_IMPACT_BPS', '100')), // 1.00%
    // USDC on the substrate chain (143), distinct from Prism's testnet USDC mock.
    substrateUsdc: env('SAVE_SUBSTRATE_USDC', '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
    maxSaveAtomic: bigintEnv('MAX_SAVE_ATOMIC', '10000000000')  // 10,000 USDC, mirrors payment cap
  },
  // The developer/judge proof surface is enabled outside production, or explicitly via PROOF_ENABLED.
  proofEnabled: env('NODE_ENV', 'development') !== 'production' || env('PROOF_ENABLED') === 'true',
  envio: {
    // Envio HyperIndex GraphQL endpoint for the reconciled activity/indexing layer.
    graphqlUrl: env('ENVIO_GRAPHQL_URL')
  },
  aurora: {
    // Aurora Intents Deposits. Routes any-chain deposits into USDC on Monad, and USDC on Monad out
    // to any token on any chain. The appKey is public by design (studio.aurora.dev) but is still
    // held server-side so the client never carries integrator credentials.
    appKey: env('AURORA_APP_KEY'),
    apiBaseUrl: env('AURORA_API_BASE_URL', 'https://intents-api.aurora.dev'),
    // preview: quotes are requested with `dry: true` and routes are labelled unsettled. NEAR Intents
    // only carries Monad MAINNET (143); Prism's contracts are on testnet (10143), so a quoted route
    // cannot actually settle against this deployment. preview keeps that honest instead of implying
    // a delivery that never happens. See docs/AURORA_INTENTS.md.
    mode: auroraMode(),
    demo: env('AURORA_MODE', 'preview') === 'demo',
    // Integrator fee in basis points, 0-100. Aurora takes max(2bps, 40% of this) on top.
    integratorFeeBps: Number(env('AURORA_INTEGRATOR_FEE_BPS', '0')),
    // Chain that inbound deposits are routed to, and that outbound routes are funded from.
    destinationChain: env('AURORA_DESTINATION_CHAIN', 'monad')
  }
};

function auroraMode() {
  const mode = env('AURORA_MODE', 'preview');
  if (!['preview', 'demo', 'live'].includes(mode)) throw new Error("AURORA_MODE must be 'preview', 'demo', or 'live'");
  return mode;
}

// Relayer allowlist: the relayer only touches these exact Prism contracts.
// Stored lowercased; compared case-insensitively at the call site.
config.chain.contractAllowlist = [config.chain.paymentRouter, config.chain.claimVault]
  .filter(Boolean).map((a) => a.toLowerCase());

// Aurora caps the integrator fee at 100bps; reject a misconfiguration at boot rather than letting
// every quote fail with an opaque upstream 400.
if (!Number.isInteger(config.aurora.integratorFeeBps) || config.aurora.integratorFeeBps < 0 || config.aurora.integratorFeeBps > 100) {
  throw new Error('AURORA_INTEGRATOR_FEE_BPS must be an integer between 0 and 100');
}
export function usdcToken() { return { ...usdc }; }

export function assertSafeConfig() {
  // The spending-limit gate is not a production-only concern: a dev server pointed at the
  // vulnerable module would teach a spending model that can never ship. It runs everywhere.
  const limits = assertCircleLimitsAreSafe([]);
  if (limits.length) throw new Error(`unsafe Circle spending-limit configuration: ${limits.join(', ')}`);

  if (config.nodeEnv !== 'production') return;
  const bad = [];
  if (config.sessionSecret === 'dev-session-secret-change-me' || config.sessionSecret.length < 32) bad.push('SESSION_SECRET');
  if (config.resolverPepper === 'dev-resolver-pepper-change-me' || config.resolverPepper.length < 32) bad.push('RESOLVER_PEPPER');
  if (config.dataEncryptionKeyHex === '11'.repeat(32)) bad.push('DATA_ENCRYPTION_KEY');
  if (config.serviceKeyEncryptionKeyHex === '22'.repeat(32)) bad.push('SERVICE_KEY_ENCRYPTION_KEY');
  if (!config.chain.relayerPrivateKey) bad.push('RELAYER_PRIVATE_KEY');
  if (!config.chain.paymentRouter) bad.push('PRISM_PAYMENT_ROUTER');
  if (!config.chain.claimVault) bad.push('PRISM_CLAIM_VAULT');
  if (!config.chain.claimAuthorizerPrivateKey) bad.push('CLAIM_AUTHORIZER_PRIVATE_KEY');
  // OTP must fail closed in production: no dev code, and real Twilio credentials required.
  if (config.otpProvider !== 'twilio') bad.push('OTP_PROVIDER (production must be twilio)');
  if (config.otpProvider === 'twilio' && (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.verifyServiceSid)) {
    bad.push('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_VERIFY_SERVICE_SID');
  }
  // A production boot that claims live cross-chain routing must actually have an Aurora key.
  if (config.aurora.mode === 'live' && !config.aurora.appKey) bad.push('AURORA_APP_KEY (required when AURORA_MODE=live)');
  if (bad.length) throw new Error(`unsafe production configuration: ${bad.join(', ')}`);
}

/// Circle spending limits must never be switched on against a pre-v1.0.0 Allowance Module.
///
/// This is the static half of the gate: what can be decided from configuration alone, at boot,
/// before a single RPC call. It runs in EVERY environment, not only production, because a
/// development server pointed at the vulnerable module would teach the whole team a spending model
/// that cannot ship. The live half — is there really canonical v1.0.0 bytecode at that address on
/// this chain? — is `AllowanceModuleGate`, which the server runs at boot and again before every
/// allowance spend.
///
/// Exported so the rule is testable without a production boot.
export function assertCircleLimitsAreSafe(bad = []) {
  const { limitsEnabled, allowanceModule, allowanceModuleCodeHash } = config.circles;
  if (!limitsEnabled) return bad;

  if (!allowanceModule) {
    bad.push('CIRCLE_ALLOWANCE_MODULE (required when CIRCLE_LIMITS_ENABLED=true)');
    return bad;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(allowanceModule)) {
    bad.push('CIRCLE_ALLOWANCE_MODULE must be an address');
    return bad;
  }
  if (VULNERABLE_ALLOWANCE_MODULES.has(allowanceModule.toLowerCase())) {
    bad.push(
      `CIRCLE_ALLOWANCE_MODULE points at Safe Allowance Module v0.1.1, whose allowance nonce can ` +
      `overflow and replay past delegate transfers; Circles requires v${MINIMUM_ALLOWANCE_MODULE_VERSION} or newer ` +
      'and must otherwise stay threshold-only'
    );
  }
  // The codeHash is what actually identifies the module. Blanking it would turn the live gate into
  // a no-op, so an empty or malformed value is a configuration error rather than a default.
  if (!/^0x[0-9a-fA-F]{64}$/.test(allowanceModuleCodeHash ?? '')) {
    bad.push('CIRCLE_ALLOWANCE_MODULE_CODEHASH must be a 32-byte hash identifying the audited module build');
  }
  return bad;
}
