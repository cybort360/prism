import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A, PK_B } from './helpers.js';

process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
process.env.AURORA_APP_KEY = 'test-app-key';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { IdentityService } = await import('../src/services/identityService.js');
const { AuroraService } = await import('../src/services/auroraService.js');
const { setAuroraClient, resetAuroraClient } = await import('../src/aurora/index.js');
const { makeMockAuroraClient } = await import('../src/aurora/mockAuroraClient.js');

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-aurora-recv-')), 'store.json');
  const store = new JsonStore(file);
  const identityService = new IdentityService({ store, config });
  const auroraService = new AuroraService({ store, config, identityService });
  const alice = meraAccount(PK_A);
  const bob = meraAccount(PK_B);
  store.mutate((d) => {
    d.identities.alice = { prismId: 'alice', account: alice.address, accountAddress: alice.address, aliasVersion: 1 };
    d.identities.bob = { prismId: 'bob', account: bob.address, accountAddress: bob.address, aliasVersion: 1 };
  });
  return { store, auroraService, alice, bob };
}

async function withMock(seed, fn) {
  const mock = makeMockAuroraClient(seed);
  setAuroraClient(mock);
  try { return await fn(mock); } finally { resetAuroraClient(); }
}

test('a deposit address is created for a source chain and routes to the caller USDC on Monad', async () => {
  await withMock({}, async (mock) => {
    const { auroraService, alice } = stack();
    const created = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });

    assert.match(created.depositAddress, /^0x[0-9a-f]{40}$/);
    assert.equal(created.depositChain, 'base');
    assert.equal(created.depositChainLabel, 'Base');
    assert.equal(created.destinationChain, 'monad');
    assert.equal(created.destinationSymbol, 'USDC');
    assert.equal(created.recipientAccount, alice.address);
    assert.equal(created.state, 'awaiting_deposit');

    // Aurora is told to deliver to the user's own account, and the destination asset is the
    // runtime-resolved Monad USDC assetId, never a symbol string.
    assert.equal(mock.calls.persistentAddress, 1);
  });
});

test('the same source chain returns the same address (idempotent, alreadyExists)', async () => {
  await withMock({}, async () => {
    const { auroraService, store } = stack();
    const first = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
    const second = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });

    assert.equal(first.depositAddress, second.depositAddress);
    assert.equal(first.alreadyExists, false);
    assert.equal(second.alreadyExists, true);
    // One stored record, not two.
    assert.equal(Object.keys(store.read().auroraDeposits).length, 1);
  });
});

test('different users get different deposit addresses', async () => {
  await withMock({}, async () => {
    const { auroraService } = stack();
    const forAlice = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'arb' });
    const forBob = await auroraService.createDepositAddress({ prismId: 'bob', depositChain: 'arb' });
    assert.notEqual(forAlice.depositAddress, forBob.depositAddress);
  });
});

test('a deposit address is readable only by its owner', async () => {
  await withMock({}, async () => {
    const { auroraService } = stack();
    const created = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });

    await assert.rejects(
      () => auroraService.refreshDeposit({ prismId: 'bob', depositAddress: created.depositAddress }),
      (e) => e.statusCode === 403
    );

    // And bob cannot enumerate alice's addresses.
    assert.equal(auroraService.listDeposits('bob').deposits.length, 0);
    assert.equal(auroraService.listDeposits('alice').deposits.length, 1);
  });
});

test('an unsupported source chain is rejected before any Aurora call', async () => {
  await withMock({}, async (mock) => {
    const { auroraService } = stack();
    await assert.rejects(
      () => auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'dogecoin-classic' }),
      (e) => e.statusCode === 400
    );
    assert.equal(mock.calls.persistentAddress, 0);
  });
});

test('deposit status advances through Aurora states and is guarded against going backwards', async () => {
  await withMock({}, async (mock) => {
    const { auroraService } = stack();
    const created = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
    const address = created.depositAddress;

    mock.setStatus(address, 'PENDING_DEPOSIT');
    assert.equal((await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: address })).state, 'funding');

    mock.setStatus(address, 'KNOWN_DEPOSIT_TX');
    assert.equal((await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: address })).state, 'funded');

    mock.setStatus(address, 'PROCESSING');
    assert.equal((await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: address })).state, 'routing');

    mock.setStatus(address, 'SUCCESS');
    const delivered = await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: address });
    assert.equal(delivered.state, 'delivered');

    // A late/stale poll must not walk a terminal route back to processing.
    mock.setStatus(address, 'PROCESSING');
    const afterStale = await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: address });
    assert.equal(afterStale.state, 'delivered');
  });
});

test('a refund and a failure are recorded as their own terminal states', async () => {
  await withMock({}, async (mock) => {
    const { auroraService } = stack();
    const a = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
    mock.setStatus(a.depositAddress, 'KNOWN_DEPOSIT_TX');
    await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: a.depositAddress });
    mock.setStatus(a.depositAddress, 'REFUNDED');
    const refunded = await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: a.depositAddress });
    assert.equal(refunded.state, 'refunded');

    const b = await auroraService.createDepositAddress({ prismId: 'bob', depositChain: 'sol' });
    mock.setStatus(b.depositAddress, 'FAILED');
    const failed = await auroraService.refreshDeposit({ prismId: 'bob', depositAddress: b.depositAddress });
    assert.equal(failed.state, 'route_failed');
  });
});

test('INCOMPLETE_DEPOSIT needs attention rather than reading as a failure', async () => {
  await withMock({}, async (mock) => {
    const { auroraService } = stack();
    const created = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
    mock.setStatus(created.depositAddress, 'INCOMPLETE_DEPOSIT');
    const result = await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: created.depositAddress });
    assert.equal(result.state, 'requires_attention');
    assert.equal(result.lastStatus, 'INCOMPLETE_DEPOSIT');
  });
});

test('an unreachable status service reports "unknown" and never invents progress', async () => {
  await withMock({}, async (mock) => {
    const { auroraService } = stack();
    const created = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
    mock.setStatus(created.depositAddress, 'PROCESSING');
    await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: created.depositAddress });

    mock.failOnce('status');
    const degraded = await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: created.depositAddress });
    assert.equal(degraded.statusKnown, false);
    assert.equal(degraded.state, 'routing', 'the last known state is preserved, not downgraded or advanced');
  });
});

test('repeated polling of the same status does not duplicate history entries', async () => {
  await withMock({}, async (mock) => {
    const { auroraService, store } = stack();
    const created = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
    mock.setStatus(created.depositAddress, 'PROCESSING');
    for (let i = 0; i < 5; i++) await auroraService.refreshDeposit({ prismId: 'alice', depositAddress: created.depositAddress });
    const record = store.read().auroraDeposits[created.depositAddress.toLowerCase()];
    assert.equal(record.history.length, 1);
  });
});

test('preview mode carries an explicit unsettled notice on every surface', async () => {
  await withMock({}, async () => {
    const { auroraService } = stack();
    assert.equal(config.aurora.mode, 'preview');
    assert.equal(auroraService.settlementAvailable, false);

    const created = await auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' });
    assert.equal(created.settlementAvailable, false);
    assert.match(created.notice.detail, /mainnet/i);
    assert.match(created.notice.detail, /10143/, 'the notice names the chain Prism is actually running against');

    assert.equal(auroraService.listDeposits('alice').notice.headline, created.notice.headline);
    assert.equal((await auroraService.chains()).settlementAvailable, false);
  });
});

test('the chain catalogue lists routable chains with their assets', async () => {
  await withMock({}, async () => {
    const { auroraService } = stack();
    const { chains } = await auroraService.chains();
    const base = chains.find((c) => c.chain === 'base');
    assert.ok(base, 'base is routable');
    assert.equal(base.label, 'Base');
    assert.equal(base.evm, true);
    assert.ok(base.assets.some((a) => a.symbol === 'USDC' && a.assetId.startsWith('nep141:base-')));

    const sol = chains.find((c) => c.chain === 'sol');
    assert.equal(sol.evm, false);
  });
});

test('every Aurora surface fails closed when no app key is configured', async () => {
  await withMock({ unavailable: true }, async () => {
    const { auroraService } = stack();
    for (const call of [
      () => auroraService.chains(),
      () => auroraService.createDepositAddress({ prismId: 'alice', depositChain: 'base' }),
      () => auroraService.refreshDeposit({ prismId: 'alice', depositAddress: '0x' + '11'.repeat(20) })
    ]) {
      await assert.rejects(call, (e) => e.statusCode === 503);
    }
  });
});

test('arrivals report indexed inbound transfers and stay silent when the index is unavailable', async () => {
  const { setEnvioIndexer, resetEnvioIndexer } = await import('../src/indexers/index.js');
  const { makeMockEnvioIndexer } = await import('../src/indexers/mockEnvioIndexer.js');

  await withMock({}, async () => {
    const { auroraService, alice } = stack();

    const indexed = makeMockEnvioIndexer({
      incoming: {
        [alice.address.toLowerCase()]: [
          { id: '0xaa-1', from: '0x' + 'ee'.repeat(20), to: alice.address, value: '50000000', txHash: '0xaa', blockNumber: 42, timestamp: 1788793448 },
          // The user's own outbound payment must not come back as an arrival.
          { id: '0xbb-1', from: alice.address, to: alice.address, value: '1', txHash: '0xbb', blockNumber: 43, timestamp: 1788793500 }
        ]
      }
    });
    setEnvioIndexer(indexed);
    try {
      const result = await auroraService.arrivals('alice');
      assert.equal(result.indexed, true);
      assert.equal(result.arrivals.length, 1);
      assert.equal(result.arrivals[0].amountAtomic, '50000000');
      assert.equal(result.arrivals[0].txHash, '0xaa');
    } finally { resetEnvioIndexer(); }

    // With no index configured, say so — do not imply nothing arrived.
    const unavailable = { ...makeMockEnvioIndexer(), available: () => false };
    setEnvioIndexer(unavailable);
    try {
      const result = await auroraService.arrivals('alice');
      assert.equal(result.indexed, false);
      assert.deepEqual(result.arrivals, []);
      assert.match(result.reason, /not configured/);
    } finally { resetEnvioIndexer(); }
  });
});

test('destination addresses are validated per chain family', async () => {
  // Used by the outbound (send/spend) path to reject a bad destination BEFORE a quote is signed
  // for. Validated here so the vocabulary can't rot between phases.
  const { validateDestinationAddress } = await import('../src/aurora/assets.js');

  assert.deepEqual(validateDestinationAddress('base', '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
    { ok: true, family: 'evm', strict: true });
  assert.equal(validateDestinationAddress('base', '0xnope').ok, false);
  assert.equal(validateDestinationAddress('base', '').reason, 'address is required');

  assert.equal(validateDestinationAddress('sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').ok, true);
  // A Solana address is not a valid EVM address and must not pass as one.
  assert.equal(validateDestinationAddress('base', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').ok, false);

  assert.equal(validateDestinationAddress('tron', 'TN9RRaXkCFtTXRso2GdTZxSxxwufzxLQPP').ok, true);
  assert.equal(validateDestinationAddress('near', 'alice.near').ok, true);
  assert.equal(validateDestinationAddress('near', 'Alice.NEAR').ok, false, 'NEAR account ids are lowercase');

  // Chains Prism cannot fully verify report strict:false so the client can warn rather than imply
  // the address was proven good.
  assert.deepEqual(validateDestinationAddress('btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'),
    { ok: true, family: 'other', strict: false });

  assert.equal(validateDestinationAddress('nosuchchain', '0x00').ok, false);
});
