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

// Verified against Agora's live contract deployments (docs.agora.finance) on 2026-09-02.
// The backend re-verifies the on-chain EIP-712 domain separator at runtime before it will
// relay, so these constants can never silently drift from the real token.
export const AUSD_KNOWN = {
  143: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',    // Monad mainnet
  10143: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC'   // Monad testnet
};
export const AUSD_DOMAIN = { name: 'Agora Dollar', version: '1' };
export const AUSD_DECIMALS = 6;

const chainId = BigInt(env('MONAD_CHAIN_ID', '10143'));
function resolveAusd() {
  const override = env('AUSD_ADDRESS');
  if (override) return override;
  const known = AUSD_KNOWN[Number(chainId)];
  if (known) return known;
  throw new Error(`AUSD_ADDRESS required for unknown chainId ${chainId}`);
}

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
    // 10,000 AUSD at 6 decimals for normal transfers; 1,000 AUSD for pre-user claims.
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
    ausd: resolveAusd(),
    ausdDomain: AUSD_DOMAIN,
    ausdDecimals: AUSD_DECIMALS,
    paymentRouter: env('PRISM_PAYMENT_ROUTER'),
    claimVault: env('PRISM_CLAIM_VAULT'),
    // MON-funded relayer that submits gasless AUSD transfers so users can hold MON = 0.
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
config.chain.tokenAllowlist = [config.chain.ausd].filter(Boolean).map((a) => a.toLowerCase());

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
