import { auroraClient } from './index.js';
import { config } from '../config.js';

/**
 * Chain and asset vocabulary for Aurora routes.
 *
 * Asset ids are NEVER hardcoded — they are resolved at runtime from Aurora's live token list, which
 * is the only authority on what is currently routable. The single pinned fallback is USDC on Monad,
 * because that is Prism's own asset and every route has it on one end; if the token list is
 * unreachable we would rather fail a quote than guess a counterparty asset.
 */

// Verified against the live token list: USDC on Monad mainnet (143), 6 decimals, contract
// 0x754704bc059f8c67012fed69bc8a327a5aafb603 — the same address README lists as Monad mainnet USDC.
export const MONAD_USDC_FALLBACK = {
  assetId: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx',
  decimals: 6,
  blockchain: 'monad',
  symbol: 'USDC',
  contractAddress: '0x754704bc059f8c67012fed69bc8a327a5aafb603'
};

/**
 * Address families, so a destination address is validated before it is ever quoted or signed for.
 * `strict: false` means Prism can check shape but not fully verify the address — the client is
 * expected to warn the user rather than imply the address was proven good.
 */
const EVM = { family: 'evm', strict: true, test: (a) => /^0x[0-9a-fA-F]{40}$/.test(a) };
const SOLANA = { family: 'solana', strict: true, test: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) };
const NEAR = {
  family: 'near',
  strict: true,
  test: (a) => /^[0-9a-f]{64}$/.test(a) || /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/.test(a)
};
const TRON = { family: 'tron', strict: true, test: (a) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) };
const HEXISH = { family: 'hex', strict: true, test: (a) => /^0x[0-9a-fA-F]{1,128}(::[A-Za-z0-9_:]+)?$/.test(a) };
// Deliberately loose: correct shape, no checksum verification. Used for chains whose address formats
// Prism does not implement in full. Never claim these are verified.
const UNVERIFIED = { family: 'other', strict: false, test: (a) => /^[A-Za-z0-9:._-]{16,128}$/.test(a) };

const CHAINS = {
  eth: { label: 'Ethereum', addr: EVM, evm: true },
  arb: { label: 'Arbitrum', addr: EVM, evm: true },
  base: { label: 'Base', addr: EVM, evm: true },
  op: { label: 'Optimism', addr: EVM, evm: true },
  pol: { label: 'Polygon', addr: EVM, evm: true },
  bsc: { label: 'BNB Smart Chain', addr: EVM, evm: true },
  avax: { label: 'Avalanche', addr: EVM, evm: true },
  gnosis: { label: 'Gnosis', addr: EVM, evm: true },
  scroll: { label: 'Scroll', addr: EVM, evm: true },
  bera: { label: 'Berachain', addr: EVM, evm: true },
  monad: { label: 'Monad', addr: EVM, evm: true },
  plasma: { label: 'Plasma', addr: EVM, evm: true },
  xlayer: { label: 'X Layer', addr: EVM, evm: true },
  abs: { label: 'Abstract', addr: EVM, evm: true },
  adi: { label: 'ADI', addr: EVM, evm: true },
  hypercore: { label: 'Hyperliquid', addr: EVM, evm: true },
  aurora: { label: 'Aurora', addr: EVM, evm: true },
  sol: { label: 'Solana', addr: SOLANA },
  fogo: { label: 'Fogo', addr: SOLANA },
  near: { label: 'NEAR', addr: NEAR },
  tron: { label: 'Tron', addr: TRON },
  sui: { label: 'Sui', addr: HEXISH },
  aptos: { label: 'Aptos', addr: HEXISH },
  movement: { label: 'Movement', addr: HEXISH },
  starknet: { label: 'Starknet', addr: HEXISH },
  btc: { label: 'Bitcoin', addr: UNVERIFIED },
  bch: { label: 'Bitcoin Cash', addr: UNVERIFIED },
  ltc: { label: 'Litecoin', addr: UNVERIFIED },
  doge: { label: 'Dogecoin', addr: UNVERIFIED },
  dash: { label: 'Dash', addr: UNVERIFIED },
  zec: { label: 'Zcash', addr: UNVERIFIED },
  xrp: { label: 'XRP Ledger', addr: UNVERIFIED },
  ton: { label: 'TON', addr: UNVERIFIED },
  stellar: { label: 'Stellar', addr: UNVERIFIED },
  cardano: { label: 'Cardano', addr: UNVERIFIED },
  aleo: { label: 'Aleo', addr: UNVERIFIED }
};

export function chainLabel(slug) { return CHAINS[slug]?.label ?? slug; }
export function isEvmChain(slug) { return Boolean(CHAINS[slug]?.evm); }
export function knownChain(slug) { return Object.hasOwn(CHAINS, slug); }

/**
 * Validate a destination address for a chain.
 * Returns { ok, family, strict, reason? }. A false `strict` means the shape passed but Prism cannot
 * fully verify the address — surface that to the user, do not swallow it.
 */
export function validateDestinationAddress(chain, address) {
  const meta = CHAINS[chain];
  if (!meta) return { ok: false, family: null, strict: false, reason: `unsupported chain '${chain}'` };
  const value = String(address ?? '').trim();
  if (!value) return { ok: false, family: meta.addr.family, strict: meta.addr.strict, reason: 'address is required' };
  if (!meta.addr.test(value)) {
    return { ok: false, family: meta.addr.family, strict: meta.addr.strict, reason: `not a valid ${meta.label} address` };
  }
  return { ok: true, family: meta.addr.family, strict: meta.addr.strict };
}

/** Every chain Aurora currently lists a routable token for, with its assets. */
export async function routableChains() {
  const tokens = await auroraClient().listTokens();
  if (!tokens) return null;
  const byChain = new Map();
  for (const token of tokens) {
    const slug = token.blockchain;
    if (!slug) continue;
    if (!byChain.has(slug)) {
      byChain.set(slug, { chain: slug, label: chainLabel(slug), evm: isEvmChain(slug), known: knownChain(slug), assets: [] });
    }
    byChain.get(slug).assets.push(publicAsset(token));
  }
  return [...byChain.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Resolve one asset on one chain. `symbolOrAssetId` accepts either a symbol ('USDC') or a full
 * assetId. `contractAddress` disambiguates chains that list the same symbol more than once
 * (Hyperliquid lists two USDCs); without it an ambiguous symbol is rejected rather than guessed.
 */
export async function resolveAsset(chain, symbolOrAssetId, { contractAddress = null } = {}) {
  const wanted = String(symbolOrAssetId ?? '').trim();
  if (!wanted) return { ok: false, reason: 'asset is required' };

  const tokens = await auroraClient().listTokens();
  if (!tokens) {
    // Only Prism's own asset has a pinned fallback; anything else fails closed.
    if (chain === MONAD_USDC_FALLBACK.blockchain && matchesAsset(MONAD_USDC_FALLBACK, wanted)) {
      return { ok: true, asset: publicAsset(MONAD_USDC_FALLBACK), pinned: true };
    }
    return { ok: false, reason: 'asset directory unavailable' };
  }

  let candidates = tokens.filter((t) => t.blockchain === chain && matchesAsset(t, wanted));
  if (contractAddress) {
    const target = String(contractAddress).toLowerCase();
    candidates = candidates.filter((t) => String(t.contractAddress ?? '').toLowerCase() === target);
  }
  if (candidates.length === 0) return { ok: false, reason: `no routable ${wanted} on ${chainLabel(chain)}` };
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `${wanted} is ambiguous on ${chainLabel(chain)} — specify contractAddress`,
      options: candidates.map(publicAsset)
    };
  }
  return { ok: true, asset: publicAsset(candidates[0]), pinned: false };
}

/** The USDC-on-Monad asset both directions route through. */
export function monadUsdc() {
  return resolveAsset(config.aurora.destinationChain, 'USDC');
}

function matchesAsset(token, wanted) {
  return token.assetId === wanted || String(token.symbol ?? '').toUpperCase() === wanted.toUpperCase();
}

/** Public projection of a token. Prices are advisory and always carry the time they were set. */
function publicAsset(token) {
  return {
    assetId: token.assetId,
    symbol: token.symbol,
    decimals: token.decimals,
    chain: token.blockchain,
    chainLabel: chainLabel(token.blockchain),
    contractAddress: token.contractAddress ?? null,
    priceUsd: typeof token.price === 'number' ? token.price : null,
    priceUpdatedAt: token.priceUpdatedAt ?? null
  };
}
