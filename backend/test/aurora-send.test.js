import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A, PK_B } from './helpers.js';

// AURORA_MODE=live so quotes are non-dry and Aurora issues a deposit address. Preview mode is
// covered separately below — it is a real product state, not just an absence of this one.
process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
process.env.AURORA_APP_KEY = 'test-app-key';
process.env.AURORA_MODE = 'live';

const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { KeyService } = await import('../src/services/keyService.js');
const { IdentityService } = await import('../src/services/identityService.js');
const { ResolverService } = await import('../src/services/resolverService.js');
const { RequestService } = await import('../src/services/requestService.js');
const { ClaimService } = await import('../src/services/claimService.js');
const { PaymentService } = await import('../src/services/paymentService.js');
const { AuroraService } = await import('../src/services/auroraService.js');
const { setAuroraClient, resetAuroraClient } = await import('../src/aurora/index.js');
const { makeMockAuroraClient } = await import('../src/aurora/mockAuroraClient.js');
const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { makeMockChainProvider } = await import('../src/providers/mockChainProvider.js');
const { paymentEnvelopeTypedData, receiveAuthorizationTypedData, routeHash, checksum } = await import('../src/chain/eth.js');

const ARB_ETH = 'nep141:arb.omft.near';
const THEIR_ARB_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-aurora-send-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  const auroraService = new AuroraService({ store, config, identityService, paymentService });

  const alice = meraAccount(PK_A);
  const bob = meraAccount(PK_B);
  store.mutate((d) => {
    d.identities.alice = { prismId: 'alice', account: alice.address, accountAddress: alice.address, aliasVersion: 1 };
    d.identities.bob = { prismId: 'bob', account: bob.address, accountAddress: bob.address, aliasVersion: 1 };
  });
  return { store, auroraService, paymentService, alice, bob };
}

async function withMocks(fn, { seed = {} } = {}) {
  const aurora = makeMockAuroraClient(seed);
  const chain = makeMockChainProvider();
  setAuroraClient(aurora);
  setChainProvider(chain);
  try { return await fn({ aurora, chain }); } finally { resetAuroraClient(); resetChainProvider(); }
}

/** Quote a $50 → ETH-on-Arbitrum route, the worked example from the design. */
function quote(auroraService, overrides = {}) {
  return auroraService.quoteSend({
    prismId: 'alice',
    destinationChain: 'arb',
    destinationAsset: ARB_ETH,
    destinationAddress: THEIR_ARB_ADDRESS,
    amountAtomic: '50000000',
    ...overrides
  });
}

/** Sign both payloads exactly as the app does. */
async function sign(signer, prepared) {
  return {
    prismSignature: await signer.signTypedData(paymentEnvelopeTypedData(prepared.envelope)),
    tokenSignature: await signer.signTypedData(receiveAuthorizationTypedData({
      from: prepared.envelope.payer, to: checksum(config.chain.paymentRouter),
      value: prepared.envelope.amount, validAfter: 0,
      validBefore: prepared.envelope.validBefore, nonce: prepared.envelope.nonce
    }))
  };
}

// MARK: quoting

test('a route is quoted with the right shape and Aurora is asked the right question', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService } = stack();
    const route = await quote(auroraService);

    assert.equal(route.state, 'quoted');
    assert.equal(route.amountInAtomic, '50000000');
    assert.equal(route.origin.chain, 'monad');
    assert.equal(route.origin.symbol, 'USDC');
    assert.equal(route.destination.chain, 'arb');
    assert.equal(route.destination.chainLabel, 'Arbitrum');
    assert.equal(route.destination.address, THEIR_ARB_ADDRESS);
    assert.equal(route.fundable, true);
    assert.match(route.depositAddress, /^0x[0-9a-f]{40}$/);
    assert.ok(route.minAmountOut, 'the user is shown a guaranteed floor, not just an estimate');

    const [request] = aurora.quotes;
    assert.equal(request.dry, false);
    assert.equal(request.swapType, 'EXACT_INPUT');
    assert.equal(request.depositType, 'ORIGIN_CHAIN');
    assert.equal(request.recipientType, 'DESTINATION_CHAIN');
    assert.equal(request.recipient, THEIR_ARB_ADDRESS);
    assert.equal(request.destinationAsset, ARB_ETH);
    assert.equal(request.originAsset, 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx');
    assert.equal(request.refundType, 'ORIGIN_CHAIN');
  });
});

test('a failed route refunds to the sender own Prism account', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService, alice } = stack();
    await quote(auroraService);
    // Their money comes back to the balance they already have, not somewhere they must go retrieve it.
    assert.equal(aurora.quotes[0].refundTo, alice.address);
  });
});

test('a malformed destination address is rejected before Aurora is ever called', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService } = stack();
    await assert.rejects(
      () => quote(auroraService, { destinationAddress: 'definitely-not-an-address' }),
      (e) => e.statusCode === 400 && /not a valid Arbitrum address/.test(e.message)
    );
    assert.equal(aurora.calls.quote, 0, 'no quote is spent on an address that cannot receive');
  });
});

test('an unsupported chain, an unknown asset and a bad amount are all refused', async () => {
  await withMocks(async () => {
    const { auroraService } = stack();
    await assert.rejects(() => quote(auroraService, { destinationChain: 'fakechain' }), (e) => e.statusCode === 400);
    await assert.rejects(() => quote(auroraService, { destinationAsset: 'NOTATOKEN' }), (e) => e.statusCode === 400);
    await assert.rejects(() => quote(auroraService, { amountAtomic: '0' }), (e) => e.statusCode === 400);
    await assert.rejects(() => quote(auroraService, { amountAtomic: '-5' }), (e) => e.statusCode === 400);
    await assert.rejects(
      () => quote(auroraService, { amountAtomic: String(config.limits.maxPaymentAtomic + 1n) }),
      (e) => e.statusCode === 400
    );
  });
});

// MARK: preparing — the binding that makes this safe

test('prepare pays the deposit address and binds the whole route into the envelope', async () => {
  await withMocks(async () => {
    const { auroraService, alice } = stack();
    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });

    assert.equal(prepared.envelope.payer, checksum(alice.address));
    assert.equal(prepared.envelope.recipient, checksum(route.depositAddress));
    assert.equal(prepared.envelope.amount, '50000000');

    const expected = routeHash({
      routeId: route.routeId,
      depositAddress: route.depositAddress,
      destinationChain: 'arb',
      destinationAssetId: ARB_ETH,
      destinationRecipient: THEIR_ARB_ADDRESS,
      minAmountOut: route.minAmountOut,
      quoteDeadline: Math.floor(Date.parse(route.quoteDeadline) / 1000)
    });
    assert.equal(prepared.envelope.resolutionHash, expected);
  });
});

/**
 * The security claim of the whole feature: the payer's one signature covers the destination, not
 * merely the address the money passes through. Change any part of the promise and the signature
 * stops matching.
 */
test('changing any part of the route after signing invalidates the signature', async () => {
  await withMocks(async () => {
    const { auroraService } = stack();
    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    const signed = prepared.envelope.resolutionHash;

    const base = {
      routeId: route.routeId,
      depositAddress: route.depositAddress,
      destinationChain: 'arb',
      destinationAssetId: ARB_ETH,
      destinationRecipient: THEIR_ARB_ADDRESS,
      minAmountOut: route.minAmountOut,
      quoteDeadline: Math.floor(Date.parse(route.quoteDeadline) / 1000)
    };
    assert.equal(routeHash(base), signed, 'the unchanged route reproduces the signed hash');

    const tampered = {
      'redirected to another chain': { destinationChain: 'base' },
      'swapped the destination token': { destinationAssetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near' },
      'redirected to an attacker address': { destinationRecipient: '0x000000000000000000000000000000000000dEaD' },
      'lowered the guaranteed minimum': { minAmountOut: '1' },
      'extended the quote deadline': { quoteDeadline: base.quoteDeadline + 3600 },
      'pointed at a different deposit address': { depositAddress: '0x' + 'ab'.repeat(20) }
    };
    for (const [what, change] of Object.entries(tampered)) {
      assert.notEqual(routeHash({ ...base, ...change }), signed, `${what} must not reproduce the signed hash`);
    }
  });
});

test('the destination address casing does not change the binding', async () => {
  const base = {
    routeId: 'r1', depositAddress: '0x' + '11'.repeat(20), destinationChain: 'arb',
    destinationAssetId: ARB_ETH, destinationRecipient: THEIR_ARB_ADDRESS,
    minAmountOut: '100', quoteDeadline: 1788793448
  };
  assert.equal(
    routeHash(base),
    routeHash({ ...base, destinationRecipient: THEIR_ARB_ADDRESS.toLowerCase() }),
    'the same address pasted with different casing is the same destination'
  );
});

test('preparing a route twice resumes the same payment, never mints a second envelope', async () => {
  await withMocks(async () => {
    const { auroraService, store } = stack();
    const route = await quote(auroraService);
    const first = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    // A client that lost the first response asks again; it must get the same signable payload back.
    const retry = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });

    assert.equal(retry.paymentId, first.paymentId);
    assert.deepEqual(retry.envelope, first.envelope);
    const mine = Object.values(store.read().operations).filter((o) => o.intent?.routeId === route.routeId);
    assert.equal(mine.length, 1, 'exactly one signable envelope exists for one quote');
  });
});

test('a route with a payment already in flight cannot be prepared again', async () => {
  await withMocks(async () => {
    const { auroraService, alice } = stack();
    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    await auroraService.submitSend({ prismId: 'alice', routeId: route.routeId, ...(await sign(alice, prepared)) });

    await assert.rejects(
      () => auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId }),
      (e) => e.statusCode === 409
    );
  });
});

test('a route cannot be prepared by another caller', async () => {
  await withMocks(async () => {
    const { auroraService } = stack();
    const route = await quote(auroraService);
    await assert.rejects(
      () => auroraService.prepareSend({ prismId: 'bob', routeId: route.routeId }),
      (e) => e.statusCode === 403
    );
  });
});

// MARK: submitting

test('submit relays through the existing router path and moves the route to funding', async () => {
  await withMocks(async ({ chain }) => {
    const { auroraService, store, alice } = stack();
    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    const result = await auroraService.submitSend({ prismId: 'alice', routeId: route.routeId, ...(await sign(alice, prepared)) });

    assert.equal(result.state, 'submitted');
    assert.ok(result.txHash);
    assert.equal(result.route.state, 'funding');
    // The money leg is an ordinary operation record, so it inherits reconcile/idempotency/recovery.
    const op = store.read().operations[prepared.paymentId];
    assert.equal(op.kind, 'aurora-send');
    assert.equal(op.intent.routeId, route.routeId);
    assert.ok(chain.calls.writeContract >= 1, 'the existing relayer path did the work');
  });
});

test('a wrong signature is refused and nothing is relayed', async () => {
  await withMocks(async ({ chain }) => {
    const { auroraService, alice, bob } = stack();
    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    const before = chain.calls.writeContract;

    // Bob signs a payment that says Alice is the payer.
    const wrongSignatures = await sign(bob, prepared);
    await assert.rejects(
      () => auroraService.submitSend({ prismId: 'alice', routeId: route.routeId, ...wrongSignatures }),
      (e) => e.statusCode === 401
    );
    assert.equal(chain.calls.writeContract, before, 'nothing reached the network');
  });
});

test('an expired quote is refused at submit rather than silently re-quoted', async () => {
  await withMocks(async () => {
    const { auroraService, store, alice } = stack();
    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    const signed = await sign(alice, prepared);

    // The user sat on the approval sheet until the price went stale.
    store.mutate((d) => { d.auroraRoutes[route.routeId].quoteDeadline = new Date(Date.now() - 1000).toISOString(); });

    await assert.rejects(
      () => auroraService.submitSend({ prismId: 'alice', routeId: route.routeId, ...signed }),
      (e) => e.statusCode === 409 && /expired/.test(e.message)
    );
    assert.equal(store.read().auroraRoutes[route.routeId].state, 'expired');
  });
});

test('a route belongs to its owner at every step', async () => {
  await withMocks(async () => {
    const { auroraService, alice } = stack();
    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    const signed = await sign(alice, prepared);

    await assert.rejects(
      () => auroraService.submitSend({ prismId: 'bob', routeId: route.routeId, ...signed }),
      (e) => e.statusCode === 403
    );
    await assert.rejects(
      () => auroraService.reconcileRoute({ prismId: 'bob', routeId: route.routeId }),
      (e) => e.statusCode === 403
    );
    assert.equal(auroraService.listRoutes('bob').routes.length, 0);
    assert.equal(auroraService.listRoutes('alice').routes.length, 1);
  });
});

// MARK: reconciling both legs

async function fundedRoute(auroraService, alice) {
  const route = await quote(auroraService);
  const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
  await auroraService.submitSend({ prismId: 'alice', routeId: route.routeId, ...(await sign(alice, prepared)) });
  return route;
}

test('a confirmed Monad transaction does not by itself mean delivery', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService, alice } = stack();
    const route = await fundedRoute(auroraService, alice);

    // Monad leg confirms, but Aurora has not reported anything yet.
    aurora.setStatus(route.depositAddress, 'PENDING_DEPOSIT');
    const result = await auroraService.reconcileRoute({ prismId: 'alice', routeId: route.routeId });

    assert.equal(result.payment.state, 'completed', 'the money left the account');
    assert.equal(result.route.state, 'funding', 'but the route has not delivered');
    assert.notEqual(result.route.state, 'delivered');
  });
});

test('the route follows Aurora through to delivery', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService, alice } = stack();
    const route = await fundedRoute(auroraService, alice);

    for (const [status, expected] of [['KNOWN_DEPOSIT_TX', 'funded'], ['PROCESSING', 'routing'], ['SUCCESS', 'delivered']]) {
      aurora.setStatus(route.depositAddress, status);
      const result = await auroraService.reconcileRoute({ prismId: 'alice', routeId: route.routeId });
      assert.equal(result.route.state, expected);
    }

    // A late poll cannot walk a delivered route backwards.
    aurora.setStatus(route.depositAddress, 'PROCESSING');
    const after = await auroraService.reconcileRoute({ prismId: 'alice', routeId: route.routeId });
    assert.equal(after.route.state, 'delivered');
  });
});

test('a refunded route says refunded, and a failed one says failed', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService, alice } = stack();
    const a = await fundedRoute(auroraService, alice);
    aurora.setStatus(a.depositAddress, 'REFUNDED');
    assert.equal((await auroraService.reconcileRoute({ prismId: 'alice', routeId: a.routeId })).route.state, 'refunded');

    const b = await fundedRoute(auroraService, alice);
    aurora.setStatus(b.depositAddress, 'FAILED');
    assert.equal((await auroraService.reconcileRoute({ prismId: 'alice', routeId: b.routeId })).route.state, 'route_failed');
  });
});

test('an unreachable status service reports unknown and holds the last known state', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService, alice } = stack();
    const route = await fundedRoute(auroraService, alice);
    aurora.setStatus(route.depositAddress, 'PROCESSING');
    await auroraService.reconcileRoute({ prismId: 'alice', routeId: route.routeId });

    aurora.failOnce('status');
    const degraded = await auroraService.reconcileRoute({ prismId: 'alice', routeId: route.routeId });
    assert.equal(degraded.statusKnown, false);
    assert.equal(degraded.route.state, 'routing', 'the last known state stands, neither advanced nor downgraded');
  });
});

test('Aurora is told which transaction funded the deposit, exactly once', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService, alice } = stack();
    const route = await fundedRoute(auroraService, alice);
    aurora.setStatus(route.depositAddress, 'PROCESSING');

    for (let i = 0; i < 4; i++) await auroraService.reconcileRoute({ prismId: 'alice', routeId: route.routeId });
    assert.equal(aurora.calls.submitDeposit, 1, 'the accelerant is not re-sent on every poll');
    assert.equal(aurora.deposits[0].depositAddress, route.depositAddress);
    assert.ok(aurora.deposits[0].txHash);
  });
});

test('repeated polling does not duplicate route history', async () => {
  await withMocks(async ({ aurora }) => {
    const { auroraService, store, alice } = stack();
    const route = await fundedRoute(auroraService, alice);
    aurora.setStatus(route.depositAddress, 'PROCESSING');
    for (let i = 0; i < 5; i++) await auroraService.reconcileRoute({ prismId: 'alice', routeId: route.routeId });

    const states = store.read().auroraRoutes[route.routeId].history.map((h) => h.state);
    assert.deepEqual(states, ['funding', 'routing']);
  });
});

// MARK: the send has to be visible afterwards

test('a cross-chain send appears in the activity feed with its destination', async () => {
  await withMocks(async () => {
    const { auroraService, store, alice } = stack();
    const { ActivityService } = await import('../src/services/activityService.js');
    const { IdentityService } = await import('../src/services/identityService.js');
    const activityService = new ActivityService({ store, identityService: new IdentityService({ store, config }) });

    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    await auroraService.submitSend({ prismId: 'alice', routeId: route.routeId, ...(await sign(alice, prepared)) });

    const items = activityService.list('alice');
    const entry = items.find((i) => i.kind === 'cross-chain-sent');
    assert.ok(entry, 'the send is in the feed — it has no Prism recipient, so it needs its own branch');
    assert.equal(entry.amountAtomic, '50000000');
    assert.equal(entry.destinationChain, 'Arbitrum');
    assert.equal(entry.destinationSymbol, 'ETH');
    assert.equal(entry.memo, 'To ETH on Arbitrum');
    assert.equal(entry.routeId, route.routeId);
    // The Monad leg and the routed leg are reported separately, never collapsed.
    assert.equal(entry.routeState, 'funding');

    // And it is not visible to anyone else.
    assert.equal(activityService.list('bob').length, 0);
  });
});

test('the canonical payment carries where the money is going', async () => {
  await withMocks(async () => {
    const { auroraService, paymentService, alice } = stack();
    const route = await quote(auroraService);
    const prepared = await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId });
    await auroraService.submitSend({ prismId: 'alice', routeId: route.routeId, ...(await sign(alice, prepared)) });

    const { payment } = paymentService.canonicalFor(prepared.paymentId, 'alice');
    assert.equal(payment.kind, 'crossChainSend');
    assert.equal(payment.route.destinationChainLabel, 'Arbitrum');
    assert.equal(payment.route.destinationSymbol, 'ETH');
    assert.equal(payment.route.destinationAddress, THEIR_ARB_ADDRESS);
    assert.ok(payment.route.minAmountOut, 'the guaranteed floor travels with the receipt');
    // The route's state is its own; the payment's lifecycleState describes only the Monad leg.
    assert.equal(payment.route.state, 'funding');
  });
});

test('an ordinary payment carries no route', async () => {
  await withMocks(async () => {
    const { paymentService, store } = stack();
    store.mutate((d) => {
      d.operations.plain = {
        operationId: 'plain', kind: 'payment', state: 'prepared',
        intent: { kind: 'payment', senderPrismId: 'alice', recipientPrismId: 'bob', amountAtomic: '1000000' },
        events: [], createdAt: new Date().toISOString()
      };
    });
    const { payment } = paymentService.canonicalFor('plain', 'alice');
    assert.equal(payment.route, null);
  });
});
