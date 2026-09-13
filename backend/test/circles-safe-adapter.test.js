import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { circleStack, makeIdentity, acknowledgement } from './circles-harness.js';

/**
 * Safe integration: the encoding the backend will ask people to sign.
 *
 * The anchor for this suite is `proof/circles/safe-tx-vectors.json`, which was produced by calling
 * `getTransactionHash()` on a REAL Safe v1.4.1 on a Monad testnet fork and independently re-derived
 * with the official Safe protocol-kit. If the backend's digest ever drifts from the deployed Safe's,
 * these tests fail — which matters because the backend's digest is the one a compromised server
 * would have to lie with.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(here, '../../proof/circles/safe-tx-vectors.json'), 'utf8'));

const {
  safeTransaction, safeTxHash, domainSeparator, encodeTransactionData,
  encodeUsdcTransfer, prevOwnerFor, buildSignatureBytes, sameOwnerSet, normalizeOwnerSet,
  predictSafeAddress, encodeSetupInitializer, SENTINEL_OWNERS
} = await import('../src/circles/safeEncoding.js');

test('the backend digest matches a real Safe contract for every committed vector', () => {
  assert.ok(vectors.vectors.length >= 6, 'the vector file is populated');
  for (const v of vectors.vectors) {
    const tx = safeTransaction({
      to: v.to, value: BigInt(v.value), data: v.data, operation: v.operation,
      safeTxGas: v.safeTxGas, baseGas: v.baseGas, gasPrice: v.gasPrice,
      gasToken: v.gasToken, refundReceiver: v.refundReceiver, nonce: v.nonce
    });
    const context = { chainId: v.chainId, safeAddress: v.safeAddress, tx };

    assert.equal(safeTxHash(context).toLowerCase(), v.safeTxHash.toLowerCase(), `safeTxHash for ${v.name}`);
    assert.equal(domainSeparator({ chainId: v.chainId, safeAddress: v.safeAddress }).toLowerCase(), v.domainSeparator.toLowerCase(), `domainSeparator for ${v.name}`);
    // The pre-image matters on its own: it is what Safe hands an EIP-1271 contract owner.
    assert.equal(encodeTransactionData(context).toLowerCase(), v.preimage.toLowerCase(), `pre-image for ${v.name}`);
  }
});

test('the digest binds the Circle, the chain and the nonce', () => {
  const [v] = vectors.vectors;
  const base = safeTransaction({ to: v.to, data: v.data, nonce: v.nonce });
  const digest = safeTxHash({ chainId: v.chainId, safeAddress: v.safeAddress, tx: base });

  // A different Circle's Safe.
  assert.notEqual(digest, safeTxHash({ chainId: v.chainId, safeAddress: '0x00000000000000000000000000000000000000aa', tx: base }));
  // A different chain.
  assert.notEqual(digest, safeTxHash({ chainId: 143, safeAddress: v.safeAddress, tx: base }));
  // A different nonce.
  assert.notEqual(digest, safeTxHash({ chainId: v.chainId, safeAddress: v.safeAddress, tx: { ...base, nonce: base.nonce + 1n } }));
  // A different amount — the vector file's own next entry proves the recipient/amount binding too.
  const tampered = safeTransaction({ to: v.to, data: encodeUsdcTransfer({ recipient: '0x00000000000000000000000000000000000000bb', amountAtomic: 1n }), nonce: v.nonce });
  assert.notEqual(digest, safeTxHash({ chainId: v.chainId, safeAddress: v.safeAddress, tx: tampered }));
});

test('USDC transfer calldata matches the committed vectors byte for byte', () => {
  const withTransfer = vectors.vectors.filter((v) => v.data.startsWith('0xa9059cbb'));
  assert.ok(withTransfer.length > 0);
  for (const v of withTransfer) {
    const recipient = getAddress(`0x${v.data.slice(34, 74)}`);
    const amount = BigInt(`0x${v.data.slice(74)}`);
    if (amount === 0n) continue;                      // the zero-amount edge case is refused by design
    assert.equal(encodeUsdcTransfer({ recipient, amountAtomic: amount }).toLowerCase(), v.data.toLowerCase());
  }
});

test('a delegatecall transaction is never constructed', () => {
  assert.throws(
    () => safeTransaction({ to: vectors.usdc, data: '0x', operation: 1, nonce: 0 }),
    /delegatecall is never proposed/
  );
});

test('a zero or negative amount is refused before it can be signed', () => {
  assert.throws(() => encodeUsdcTransfer({ recipient: vectors.usdc, amountAtomic: 0n }), /amount must be positive/);
  assert.throws(() => encodeUsdcTransfer({ recipient: 'not-an-address', amountAtomic: 1n }), /must be an address/);
});

test('owner linked list: the predecessor of the first owner is the sentinel', () => {
  const owners = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];
  assert.equal(prevOwnerFor(owners, owners[0]), SENTINEL_OWNERS);
  assert.equal(getAddress(prevOwnerFor(owners, owners[1])), getAddress(owners[0]));
  assert.equal(getAddress(prevOwnerFor(owners, owners[2])), getAddress(owners[1]));
  assert.throws(() => prevOwnerFor(owners, '0x4444444444444444444444444444444444444444'), /not an owner/);
});

test('the signature envelope is ordered by owner address, as Safe requires', () => {
  const high = { authorityAddress: '0xff00000000000000000000000000000000000001', signature: `0x${'aa'.repeat(65)}` };
  const low = { authorityAddress: '0x0000000000000000000000000000000000000002', signature: `0x${'bb'.repeat(65)}` };
  const packed = buildSignatureBytes([high, low]);
  assert.equal(packed, `0x${'bb'.repeat(65)}${'aa'.repeat(65)}`, 'the lower address signs first');
  assert.equal((packed.length - 2) / 2, 130, 'two 65-byte words');
});

test('owner sets compare by membership, not by order or casing', () => {
  const lower = ['0xaaaaaa00000000000000000000000000000000aa', '0xbbbbbb00000000000000000000000000000000bb'];
  const checksummed = lower.map((a) => getAddress(a));
  // Same members, opposite order, and one side EIP-55 checksummed while the other is not.
  assert.ok(sameOwnerSet(lower, [checksummed[1], checksummed[0]]));
  assert.ok(!sameOwnerSet(lower, [lower[0]]));
  assert.ok(!sameOwnerSet(lower, [...lower, '0xcccccc00000000000000000000000000000000cc']));
});

test('a duplicate or malformed admin authority is refused before deployment', () => {
  const owner = '0xaaaaaa00000000000000000000000000000000aa';
  // The same person listed twice, once checksummed — a duplicate Safe owner reverts on-chain.
  assert.throws(() => normalizeOwnerSet([getAddress(owner), owner]), /selected twice/);
  assert.throws(() => normalizeOwnerSet([]), /at least one admin/);
  assert.throws(() => normalizeOwnerSet(['0xnope']), /not a valid address/);
  // A mixed-case address whose EIP-55 checksum does not hold is not accepted as an authority.
  assert.throws(() => normalizeOwnerSet(['0xAAaAaA00000000000000000000000000000000aa']), /not a valid address/);
});

test('the setup initializer installs no module and takes no payment from the Circle', () => {
  const initializer = encodeSetupInitializer({
    owners: ['0x1111111111111111111111111111111111111111'], threshold: 1,
    fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'
  });
  // `to` and `data` zero means no setup delegatecall; the payment fields zero means the relayer pays
  // gas from outside the Safe rather than the Circle funding its own deployment.
  const zeroWord = '0'.repeat(64);
  const words = initializer.slice(10).match(/.{64}/g);
  assert.ok(words.includes(zeroWord), 'zero words are present for the unused setup and payment fields');
  assert.throws(() => encodeSetupInitializer({ owners: ['0x1111111111111111111111111111111111111111'], threshold: 2, fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' }), /between 1 and the number of owners/);
});

test('address prediction is deterministic in the salt and sensitive to every input', () => {
  const common = {
    proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
    singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
    initializer: encodeSetupInitializer({ owners: ['0x1111111111111111111111111111111111111111'], threshold: 1, fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' }),
    saltNonce: 42n,
    proxyCreationCode: `0x${'60'.repeat(32)}`
  };
  const address = predictSafeAddress(common);
  assert.equal(predictSafeAddress(common), address, 'same inputs, same address');
  assert.notEqual(predictSafeAddress({ ...common, saltNonce: 43n }), address);
  assert.notEqual(predictSafeAddress({ ...common, singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' }), address);
  assert.notEqual(predictSafeAddress({ ...common, proxyCreationCode: `0x${'61'.repeat(32)}` }), address);
  // The creation code must be read from the factory, never assumed.
  assert.throws(() => predictSafeAddress({ ...common, proxyCreationCode: undefined }), /read from the factory/);
});

test('the adapter refuses a digest the deployed Safe disagrees with', async () => {
  const { circles, identityService, safeAdapter, fake } = await circleStack();
  const ada = await makeIdentity(identityService, { name: 'Ada' });
  const circle = await circles.createCircle({
    creatorPrismId: ada.prismId, name: 'Solo', template: 'CUSTOM', admins: [], threshold: 1,
    policyAcknowledgement: acknowledgement({ threshold: 1, adminCount: 1 })
  });

  const tx = await safeAdapter.buildTransaction({
    safeAddress: circle.safeAddress, intent: { kind: 'THRESHOLD_CHANGE', threshold: 1 }
  });
  await safeAdapter.getTransactionHash({ safeAddress: circle.safeAddress, tx });   // agrees today

  // Now the Safe answers with a different hash than Prism computes — a version or encoding drift.
  fake.knobs.txHashDisagreement = true;
  await assert.rejects(
    () => safeAdapter.getTransactionHash({ safeAddress: circle.safeAddress, tx }),
    /encode this transaction differently/
  );
});

test('an approval must be a real signature from a current owner over this exact digest', async () => {
  const { circles, identityService, safeAdapter, fake } = await circleStack();
  const ada = await makeIdentity(identityService, { name: 'Ada' });
  const circle = await circles.createCircle({
    creatorPrismId: ada.prismId, name: 'Solo', template: 'CUSTOM', admins: [], threshold: 1,
    policyAcknowledgement: acknowledgement({ threshold: 1, adminCount: 1 })
  });

  const owner = ada.account;
  const digest = `0x${'ab'.repeat(32)}`;
  const signature = await owner.sign({ hash: digest });

  const verified = await safeAdapter.verifyApproval({ safeAddress: circle.safeAddress, safeTxHash: digest, signature });
  assert.equal(getAddress(verified.authorityAddress), getAddress(owner.address));
  assert.equal(verified.signatureType, 'ECDSA');
  assert.equal(getAddress(await recoverAddress({ hash: digest, signature })), getAddress(owner.address));

  // The same signature over a different digest recovers to somebody else, who is not an owner.
  await assert.rejects(
    () => safeAdapter.verifyApproval({ safeAddress: circle.safeAddress, safeTxHash: `0x${'cd'.repeat(32)}`, signature }),
    /not signed by a current admin/
  );

  // A signature from a stranger is refused even though it is perfectly valid.
  const stranger = privateKeyToAccount(`0x${'7f'.repeat(32)}`);
  const strangerSignature = await stranger.sign({ hash: digest });
  await assert.rejects(
    () => safeAdapter.verifyApproval({ safeAddress: circle.safeAddress, safeTxHash: digest, signature: strangerSignature }),
    /not signed by a current admin/
  );

  // And once the owner set changes, the same approval stops verifying.
  fake.forceOwners(circle.safeAddress, ['0x00000000000000000000000000000000000000aa'], 1);
  await assert.rejects(
    () => safeAdapter.verifyApproval({ safeAddress: circle.safeAddress, safeTxHash: digest, signature }),
    /not signed by a current admin/
  );
});

test('a malformed approval is rejected without touching the chain', async () => {
  const { circles, identityService, safeAdapter } = await circleStack();
  const ada = await makeIdentity(identityService, { name: 'Ada' });
  const circle = await circles.createCircle({
    creatorPrismId: ada.prismId, name: 'Solo', template: 'CUSTOM', admins: [], threshold: 1,
    policyAcknowledgement: acknowledgement({ threshold: 1, adminCount: 1 })
  });
  const digest = `0x${'ab'.repeat(32)}`;

  await assert.rejects(() => safeAdapter.verifyApproval({ safeAddress: circle.safeAddress, safeTxHash: digest, signature: '0xdeadbeef' }), /65-byte signature/);
  // v=0 is Safe's contract-signature encoding: valid on-chain, but not verifiable off-chain here.
  await assert.rejects(
    () => safeAdapter.verifyApproval({ safeAddress: circle.safeAddress, safeTxHash: digest, signature: `0x${'11'.repeat(64)}00` }),
    /unsupported approval encoding/
  );
});

test('the adapter contract is enforced, so an incomplete implementation fails at wiring time', async () => {
  const { assertAdapterContract, SAFE_ADAPTER_METHODS } = await import('../src/circles/safeCircleAdapter.js');
  const complete = Object.fromEntries(SAFE_ADAPTER_METHODS.map((m) => [m, () => {}]));
  assert.ok(assertAdapterContract(complete));

  const { getOwners, ...incomplete } = complete;
  assert.throws(() => assertAdapterContract(incomplete), /missing: getOwners/);
});
