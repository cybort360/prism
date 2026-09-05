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
  limits: {
    // 10,000 stablecoin units for normal transfers, 1,000 for pre-user claims.
    maxPaymentAtomic: bigintEnv('MAX_PAYMENT_ATOMIC', '10000000000'),
    maxClaimAtomic: bigintEnv('MAX_CLAIM_ATOMIC', '1000000000')
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
    alchemyWebhookSigningKey: env('ALCHEMY_WEBHOOK_SIGNING_KEY')
  },
  // The developer/judge proof surface is enabled outside production, or explicitly via PROOF_ENABLED.
  proofEnabled: env('NODE_ENV', 'development') !== 'production' || env('PROOF_ENABLED') === 'true',
  envio: {
    // Envio HyperIndex GraphQL endpoint for the reconciled activity/indexing layer.
    graphqlUrl: env('ENVIO_GRAPHQL_URL')
  }
};

// Relayer allowlist: the relayer only touches these exact Prism contracts.
// Stored lowercased; compared case-insensitively at the call site.
config.chain.contractAllowlist = [config.chain.paymentRouter, config.chain.claimVault]
  .filter(Boolean).map((a) => a.toLowerCase());
export function usdcToken() { return { ...usdc }; }

export function assertSafeConfig() {
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
  if (bad.length) throw new Error(`unsafe production configuration: ${bad.join(', ')}`);
}
