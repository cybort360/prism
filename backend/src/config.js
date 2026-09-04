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

// Canonical Monad deployments from Agora and Circle. The backend re-verifies every configured
// EIP-712 domain against the live contract before relaying in production.
export const STABLECOIN_KNOWN = {
  AUSD: {
    name: 'Agora Dollar', decimals: 6, domain: { name: 'Agora Dollar', version: '1' },
    addresses: {
      143: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
      10143: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC'
    }
  },
  USDC: {
    name: 'USD Coin', decimals: 6, domain: { name: 'USDC', version: '2' },
    addresses: {
      143: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      10143: '0x534b2f3A21130d7a60830c2Df862319e593943A3'
    }
  }
};

export const AUSD_KNOWN = STABLECOIN_KNOWN.AUSD.addresses;
export const AUSD_DOMAIN = STABLECOIN_KNOWN.AUSD.domain;
export const AUSD_DECIMALS = STABLECOIN_KNOWN.AUSD.decimals;

const chainId = BigInt(env('MONAD_CHAIN_ID', '10143'));
function resolveStablecoin(symbol) {
  const definition = STABLECOIN_KNOWN[symbol];
  const override = env(`${symbol}_ADDRESS`);
  if (override) return override;
  const known = definition.addresses[Number(chainId)];
  if (known) return known;
  throw new Error(`${symbol}_ADDRESS required for unknown chainId ${chainId}`);
}

const stablecoins = Object.fromEntries(Object.entries(STABLECOIN_KNOWN).map(([symbol, definition]) => [
  symbol,
  { symbol, name: definition.name, address: resolveStablecoin(symbol), decimals: definition.decimals, domain: definition.domain }
]));

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
    tokens: stablecoins,
    ausd: stablecoins.AUSD.address,
    usdc: stablecoins.USDC.address,
    ausdDomain: AUSD_DOMAIN,
    ausdDecimals: AUSD_DECIMALS,
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

// Relayer allowlists: the relayer may only ever touch these exact contracts and this exact token.
// Stored lowercased; compared case-insensitively at the call site.
config.chain.contractAllowlist = [config.chain.paymentRouter, config.chain.claimVault]
  .filter(Boolean).map((a) => a.toLowerCase());
config.chain.tokenAllowlist = Object.values(config.chain.tokens).map(token => token.address.toLowerCase());

export function supportedToken(value = 'AUSD') {
  const needle = String(value).toLowerCase();
  const token = Object.values(config.chain.tokens).find(candidate =>
    candidate.symbol.toLowerCase() === needle || candidate.address.toLowerCase() === needle
  );
  if (!token) {
    const error = new Error('unsupported token');
    error.statusCode = 400;
    throw error;
  }
  return token;
}

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
