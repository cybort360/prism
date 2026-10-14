import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress, recoverTypedDataAddress } from 'viem';

// Run the shipped bridge and real Mera SDK. Only the platform credential boundary is a
// test double. This exercises the device branch, which the simulator signer bypasses.
const bundle = buildSync({
  entryPoints: [new URL('../src/bridge.js', import.meta.url).pathname],
  bundle: true, format: 'iife', platform: 'browser', write: false,
}).outputFiles[0].text;
const rpId = 'app.getprism.xyz';
const testKey = `0x${'01'.repeat(32)}`;
const expectedAddress = privateKeyToAccount(testKey).address;
const credentialId = new Uint8Array([1, 2, 3, 4]);
const prfBytes = () => new Uint8Array(32).fill(1);

function credential({ enabled = true, output = true } = {}) {
  return {
    type: 'public-key', rawId: credentialId.buffer.slice(0),
    response: { getTransports: () => ['internal'] },
    getClientExtensionResults: () => ({
      prf: { enabled, ...(output ? { results: { first: prfBytes().buffer } } : {}) },
    }),
  };
}

function harness({ create, get, focused = true } = {}) {
  const calls = [];
  const messages = [];
  const navigator = { credentials: {
    async create({ publicKey }) {
      calls.push({ method: 'create', publicKey });
      // Required WebAuthn fields. Real WebKit rejects these before showing a prompt.
      assert.equal(publicKey.rp?.id, rpId);
      assert.equal(publicKey.rp?.name, 'Prism');
      assert.equal(publicKey.user.displayName, 'Prism');
      assert.equal(publicKey.user.id.length, 32);
      assert.equal(publicKey.authenticatorSelection.userVerification, 'required');
      assert.equal(publicKey.extensions.prf.eval.first.length, 32);
      return create ? create(publicKey) : credential();
    },
    async get({ publicKey }) {
      calls.push({ method: 'get', publicKey });
      assert.equal(publicKey.rpId, rpId);
      assert.equal(publicKey.userVerification, 'required');
      assert.equal(publicKey.extensions.prf.eval.first.length, 32);
      return get ? get(publicKey) : credential();
    },
  } };
  const window = { webkit: { messageHandlers: { prism: {
    postMessage: message => messages.push(message),
  } } } };
  vm.runInNewContext(bundle, {
    window, navigator, location: { hostname: rpId }, crypto: webcrypto,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, console,
    document: { hasFocus: () => focused },
  });
  return {
    calls,
    async dispatch(method, params = {}) {
      await window.prismMera.dispatch({ id: String(messages.length), method, params });
      return messages.at(-1);
    },
  };
}

test('device creation supplies WebAuthn inputs and derives the expected real EVM account', async () => {
  const bridge = harness();
  const response = await bridge.dispatch('createAccount');
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.address, expectedAddress);
  assert.deepEqual(Object.keys(response.result), ['address']);
  assert.deepEqual(bridge.calls.map(c => c.method), ['create']);
});

test('creation pins platform authenticator attachment (iOS 18 A12 setPrf crash guard)', async () => {
  // Without authenticatorAttachment, WebKit on iOS 18.7 (the last OS for A12 devices like iPhone
  // XR / XS Max) also builds a cross-platform security-key registration request and calls setPrf:
  // on it, a selector that class lacks there, aborting the app. Pinning to "platform" stops WebKit
  // from building that request. See the pinPasskeyCreationToPlatform shim in bridge.js.
  const bridge = harness();
  await bridge.dispatch('createAccount');
  const createCall = bridge.calls.find(c => c.method === 'create');
  assert.equal(createCall.publicKey.authenticatorSelection.authenticatorAttachment, 'platform');
})

test('creation falls back to an assertion restricted to the newly created credential', async () => {
  const bridge = harness({ create: () => credential({ output: false }) });
  const response = await bridge.dispatch('createAccount');
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.address, expectedAddress);
  assert.deepEqual(bridge.calls.map(c => c.method), ['create', 'get']);
  assert.deepEqual(Array.from(bridge.calls[1].publicKey.allowCredentials[0].id), Array.from(credentialId));
});

test('restore, binding proof, and ERC-3009 typed signing use the same account', async () => {
  const bridge = harness();
  const restored = await bridge.dispatch('restoreAccount');
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.result.address, expectedAddress);
  const message = JSON.stringify({ action: 'bind_account', account: expectedAddress.toLowerCase(), nonce: 'test-challenge' });
  const signed = await bridge.dispatch('signMessage', { message });
  assert.equal(signed.ok, true, signed.error);
  assert.equal(await recoverMessageAddress({ message, signature: signed.result }), expectedAddress);

  const typedData = {
    domain: { name: 'USDC', version: '2', chainId: 10143, verifyingContract: '0x534b2f3A21130d7a60830c2Df862319e593943A3' },
    types: { ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: expectedAddress, to: '0x0000000000000000000000000000000000000002', value: '1000000', validAfter: '0', validBefore: '2000000000', nonce: `0x${'ab'.repeat(32)}` },
  };
  const typed = await bridge.dispatch('signTypedData', { typedData });
  assert.equal(typed.ok, true, typed.error);
  assert.equal(await recoverTypedDataAddress({ ...typedData, signature: typed.result }), expectedAddress);
  // Ending the session must discard the signer and require another platform assertion.
  assert.equal((await bridge.dispatch('revokeSession')).ok, true);
  const afterRevocation = await bridge.dispatch('signMessage', { message });
  assert.equal(afterRevocation.ok, true, afterRevocation.error);
  assert.equal(await recoverMessageAddress({ message, signature: afterRevocation.result }), expectedAddress);
  assert.deepEqual(bridge.calls.map(c => c.method), ['get', 'get']);
});

test('unsupported PRF fails without returning an account or signature', async () => {
  const bridge = harness({ create: () => credential({ enabled: false, output: false }) });
  const response = await bridge.dispatch('createAccount');
  assert.equal(response.ok, false);
  assert.match(response.error, /PRF_UNAVAILABLE/);
  assert.equal(response.result, undefined);
});

test('passkey errors preserve a safe SDK code and platform cause without leaking error details', async () => {
  const bridge = harness({ create: () => {
    const error = new Error('sensitive diagnostic must not cross the bridge');
    error.name = 'SecurityError';
    throw error;
  } });
  const response = await bridge.dispatch('createAccount');
  assert.equal(response.ok, false);
  assert.match(response.error, /PASSKEY_OPERATION_FAILED/);
  assert.match(response.error, /SecurityError/);
  assert.doesNotMatch(response.error, /sensitive diagnostic/);
});

test('simulator development signing still produces a real recoverable signature', async () => {
  const bridge = harness();
  const response = await bridge.dispatch('createAccount', { devPk: testKey });
  assert.equal(response.result.address, expectedAddress);
  const message = 'development signer test';
  const signed = await bridge.dispatch('signMessage', { devPk: testKey, message });
  assert.equal(await recoverMessageAddress({ message, signature: signed.result }), expectedAddress);
  assert.equal(bridge.calls.length, 0);
});

test('unfocused document stops create and restore with a specific diagnostic', async () => {
  const bridge = harness({ focused: false });
  for (const method of ['createAccount', 'restoreAccount']) {
    const response = await bridge.dispatch(method);
    assert.equal(response.ok, false);
    assert.match(response.error, /PASSKEY_DOCUMENT_NOT_FOCUSED/);
    assert.doesNotMatch(response.error, /cancelled|timed out/);
  }
  assert.equal(bridge.calls.length, 0);
});

test('NotAllowedError does not claim the user cancelled an unseen request', async () => {
  const bridge = harness({ create: () => {
    const error = new Error('platform-specific details');
    error.name = 'NotAllowedError';
    throw error;
  } });
  const response = await bridge.dispatch('createAccount');
  assert.equal(response.ok, false);
  assert.match(response.error, /NotAllowedError/);
  assert.doesNotMatch(response.error, /cancelled|timed out|platform-specific details/);
});
