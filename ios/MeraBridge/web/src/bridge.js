// Prism ⇄ Mera bridge glue.
//
// This runs inside the offscreen WKWebView hosted by WKWebViewMeraBridge.swift. It wires the
// OFFICIAL @category-labs/mera library: Prism never re-implements Mera's account derivation or
// signing. Only public addresses and signatures are posted back to Swift; the passkey and its
// derived root never leave this context and are never sent to the Prism backend.
//
// Official Mera entry points used (see https://mera.category.xyz):
//   createPasskeyWithPrfOutput  – create a passkey and obtain its PRF output (account creation)
//   getPasskeyPrfOutput         – re-derive the PRF output from an existing passkey (restore)
//   getEvmAddress               – deterministic EVM address from the PRF output
//   createSecp256k1SigningSession – a warm signing session whose key is zeroed on end()

import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  getEvmAddress,
  createSecp256k1SigningSession,
} from '@category-labs/mera';
import { privateKeyToAccount } from 'viem/accounts';

const RELYING_PARTY = { name: 'Prism', id: location.hostname };

let session = null; // Secp256k1SigningSession (real) or a viem dev signer
let address = null;

// Dev mode is active whenever a dev seed is supplied (per-call by Swift) or the global flag is set.
function isDev(params) { return !!(params && params.devPk) || !!window.PRISM_MERA_DEV; }

async function createAccount(params) {
  if (isDev(params)) return { address: devAccount(params).address };
  const prf = await createPasskeyWithPrfOutput({ relyingParty: RELYING_PARTY, user: { name: 'prism' } });
  address = await getEvmAddress(prf);
  session = await createSecp256k1SigningSession({ prfOutput: prf });
  return { address };
}

async function restoreAccount(params) {
  if (isDev(params)) return { address: devAccount(params).address };
  const prf = await getPasskeyPrfOutput({ relyingParty: RELYING_PARTY });
  address = await getEvmAddress(prf);
  session = await createSecp256k1SigningSession({ prfOutput: prf });
  return { address };
}

async function signMessage(params) {
  if (isDev(params)) return devAccount(params).signMessage({ message: params.message });
  const s = await signer();
  return s.signMessage({ message: params.message });
}

async function signTypedData(params) {
  if (isDev(params)) return devAccount(params).signTypedData(params.typedData);
  const s = await signer();
  return s.signTypedData(params.typedData);
}

// The session is created alongside the account. Scope/TTL policy is enforced on the Swift side;
// revoke zeroes the warm key so the next signature re-derives from the passkey.
async function createSession() { return true; }
async function revokeSession() {
  if (session && typeof session.end === 'function') session.end();
  session = null;
  return true;
}

async function signer() {
  if (session) return session;
  await restoreAccount();
  if (!session) throw new Error('Mera signing session unavailable');
  return session;
}

// Stateless dev signer for simulator/testnet demos. Uses viem's vetted secp256k1 with the seed Swift
// passes on every call (cached once, persisted in Keychain) — a real EVM account, just not
// passkey-derived. Being stateless, it derives the SAME account regardless of any JS/WebView state.
function devAccount(params) {
  const pk = params.devPk || window.PRISM_DEV_SEED;
  if (!pk) throw new Error('dev seed missing');
  return privateKeyToAccount(pk);
}

const handlers = { createAccount, restoreAccount, signMessage, signTypedData, createSession, revokeSession };

window.prismMera = {
  async dispatch({ id, method, params }) {
    try {
      const handler = handlers[method];
      if (!handler) throw new Error(`unknown method ${method}`);
      const result = await handler(params || {});
      post({ id, ok: true, result });
    } catch (e) {
      post({ id, ok: false, error: String((e && e.message) || e) });
    }
  },
};

function post(msg) {
  window.webkit.messageHandlers.prism.postMessage(msg);
}
