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
//   createSecp256k1SigningSession – a warm signing session whose key is zeroed on end()
//   toViemAccount               – official EVM address + EIP-191/712 signing adapter

import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  createSecp256k1SigningSession,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { privateKeyToAccount } from 'viem/accounts';

const RELYING_PARTY = { name: 'Prism', id: location.hostname };

// iOS 18.7 — the last OS for A12 devices (iPhone XR / XS Max) — crashes during passkey creation when
// the WebAuthn PRF extension is requested without a fixed authenticator attachment. With attachment
// unspecified, WebKit also prepares a cross-platform (security-key) registration request and calls
// `setPrf:` on it — a selector that class lacks on that OS:
//   -[ASAuthorizationSecurityKeyPublicKeyCredentialRegistrationRequest setPrf:]: unrecognized selector
// That is a native SIGABRT the JS try/catch below can never catch. Prism only uses platform
// (device / iCloud) passkeys, so pin the attachment to "platform": WebKit then never builds the
// security-key request and sets PRF only on the platform request, which supports it. On any OS where
// platform PRF is also unavailable this degrades to the handled PRF_UNAVAILABLE path, never a crash.
// Harmless on newer OSes (iOS 26+) that never hit the bug. Scoped to PRF creation calls only.
(function pinPasskeyCreationToPlatform() {
  const creds = globalThis.navigator?.credentials;
  const nativeCreate = creds?.create?.bind(creds);
  if (!nativeCreate) return;
  creds.create = function (options) {
    const publicKey = options?.publicKey;
    if (publicKey?.extensions?.prf) {
      publicKey.authenticatorSelection = {
        ...(publicKey.authenticatorSelection || {}),
        authenticatorAttachment: 'platform',
      };
    }
    return nativeCreate(options);
  };
})();

let session = null; // Mera Secp256k1SigningSession, owns and zeroes its key
let account = null; // Official viem adapter over the live Mera session

// Dev mode is active whenever a dev seed is supplied (per-call by Swift) or the global flag is set.
function isDev(params) { return !!(params && params.devPk) || !!window.PRISM_MERA_DEV; }

async function createAccount(params) {
  if (isDev(params)) return { address: devAccount(params).address };
  assertCredentialFocus();
  const { prfOutput } = await createPasskeyWithPrfOutput({
    rp: RELYING_PARTY, user: { name: 'prism', displayName: 'Prism' },
  });
  return openSession(prfOutput);
}

async function restoreAccount(params) {
  if (isDev(params)) return { address: devAccount(params).address };
  assertCredentialFocus();
  const { prfOutput } = await getPasskeyPrfOutput({ rpId: RELYING_PARTY.id });
  return openSession(prfOutput);
}

function assertCredentialFocus() {
  if (globalThis.document?.hasFocus() === false) {
    const error = new Error('Passkey document lacks focus');
    error.code = 'PASSKEY_DOCUMENT_NOT_FOCUSED';
    throw error;
  }
}

function openSession(prfOutput) {
  try {
    // Mera 0.2 accepts the PRF bytes as privateKey and copies them into its session.
    // Its official viem adapter derives the address from session.publicKey and hashes
    // EIP-191/712 payloads before calling signDigest. The session itself has no such methods.
    const nextSession = createSecp256k1SigningSession({ privateKey: prfOutput });
    let nextAccount;
    try { nextAccount = toViemAccount(nextSession); }
    catch (error) { nextSession.end(); throw error; }
    if (session) session.end();
    session = nextSession;
    account = nextAccount;
    return { address: account.address };
  } finally {
    // The session owns its copy. Do not retain the temporary secret returned by WebAuthn.
    prfOutput.fill(0);
  }
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
  account = null;
  return true;
}

async function signer() {
  if (account) return account;
  await restoreAccount();
  if (!account) throw new Error('Mera signing session unavailable');
  return account;
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
      post({ id, ok: false, error: errorMessage(e) });
    }
  },
};

function errorMessage(error) {
  // Preserve known diagnostic categories, never raw platform error text or secret material.
  const code = error?.code;
  if (code === 'PASSKEY_DOCUMENT_NOT_FOCUSED') {
    return 'Prism could not focus the passkey request. Keep Prism open and try again. (PASSKEY_DOCUMENT_NOT_FOCUSED)';
  }
  if (code === 'PRF_UNAVAILABLE') {
    return 'This passkey provider does not support Prism account creation. Use iCloud Passwords on an updated iPhone. (PRF_UNAVAILABLE)';
  }
  if (code === 'PASSKEY_OPERATION_FAILED') {
    const cause = error.cause?.name;
    if (cause === 'SecurityError') {
      return 'Passkey access was blocked for app.getprism.xyz. (PASSKEY_OPERATION_FAILED, SecurityError)';
    }
    if (cause === 'NotAllowedError') {
      return 'Passkey request was blocked or dismissed. Keep Prism open and try again. (PASSKEY_OPERATION_FAILED, NotAllowedError)';
    }
    if (cause === 'AbortError') {
      return `Passkey approval was cancelled or timed out. Try again. (PASSKEY_OPERATION_FAILED, ${cause})`;
    }
    if (cause === 'TypeError' || cause === 'NotSupportedError' || cause === 'InvalidStateError') {
      return `Passkey setup failed. (PASSKEY_OPERATION_FAILED, ${cause})`;
    }
    return 'Passkey approval failed. Check your iPhone passkey settings and try again. (PASSKEY_OPERATION_FAILED)';
  }
  if (code === 'INPUT_INVALID' || code === 'CRYPTO_UNAVAILABLE' || code === 'SESSION_ENDED') {
    return `Prism account signing failed. Restart Prism and try again. (${code})`;
  }
  return 'Prism account signing failed. Try again.';
}

function post(msg) {
  window.webkit.messageHandlers.prism.postMessage(msg);
}
