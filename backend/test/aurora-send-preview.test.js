import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import crypto from 'node:crypto';
import { meraAccount, PK_A } from './helpers.js';

/**
 * Preview mode is a real product state, not merely the absence of live mode. On testnet a route can
 * be genuinely quoted — real pricing, real routing — but Aurora issues no deposit address, so it
 * cannot be funded. These tests pin that the app is told exactly that, and never handed something
 * that looks fundable when it is not.
 *
 * Also covers the privacy boundary for the outbound path: a destination address the user typed is
 * not a Prism identity, and nothing about the sender's identity may travel with it.
 */

process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
process.env.AURORA_APP_KEY = 'preview-app-key';
process.env.AURORA_MODE = 'preview';

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
const { phoneLookupKey } = await import('../src/lib/crypto.js');

const PHONE = '+2348100000000';
const THEIR_ARB_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';

function stack() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-aurora-preview-')), 'store.json');
  const store = new JsonStore(file);
  const keyService = new KeyService(store, config);
  const identityService = new IdentityService({ store, config });
  const resolverService = new ResolverService({ store, config, keyService, identityService });
  const requestService = new RequestService({ store, identityService, config });
  const claimService = new ClaimService({ store, config, identityService });
  const paymentService = new PaymentService({ store, config, identityService, claimService, resolverService, requestService });
  const auroraService = new AuroraService({ store, config, identityService, paymentService });

  const alice = meraAccount(PK_A);
  store.mutate((d) => {
    d.identities.alice = {
      prismId: 'alice', account: alice.address, accountAddress: alice.address, aliasVersion: 1,
      handle: 'alice', displayName: 'Alice Example',
      phoneLookupKey: phoneLookupKey(PHONE, config.resolverPepper), phoneVerified: true
    };
  });
  return { store, auroraService, alice };
}

async function withMock(fn) {
  const mock = makeMockAuroraClient();
  setAuroraClient(mock);
  try { return await fn(mock); } finally { resetAuroraClient(); }
}

function quote(auroraService) {
  return auroraService.quoteSend({
    prismId: 'alice', destinationChain: 'arb', destinationAsset: 'nep141:arb.omft.near',
    destinationAddress: THEIR_ARB_ADDRESS, amountAtomic: '50000000'
  });
}

test('a preview quote is real pricing but is not fundable, and says so', async () => {
  await withMock(async (mock) => {
    const route = await quote(stack().auroraService);

    assert.equal(mock.quotes[0].dry, true, 'preview asks Aurora for a dry quote');
    assert.equal(route.state, 'quoted');
    assert.ok(route.minAmountOut, 'the user still sees a real guaranteed floor');
    assert.equal(route.depositAddress, null);
    assert.equal(route.fundable, false);
    assert.equal(route.settlementAvailable, false);
    assert.match(route.notice.detail, /mainnet/i);
    assert.match(route.notice.detail, /10143/, 'the notice names the chain Prism actually runs against');
  });
});

test('a preview route refuses to prepare, with a reason rather than a generic error', async () => {
  await withMock(async () => {
    const { auroraService } = stack();
    const route = await quote(auroraService);
    await assert.rejects(
      () => auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId }),
      (e) => e.statusCode === 409 && /preview mode/.test(e.message) && /no deposit address/.test(e.message)
    );
  });
});

test('no payment operation is created for a route that cannot be funded', async () => {
  await withMock(async () => {
    const { auroraService, store } = stack();
    const route = await quote(auroraService);
    await auroraService.prepareSend({ prismId: 'alice', routeId: route.routeId }).catch(() => {});
    assert.equal(Object.keys(store.read().operations).length, 0);
    assert.equal(store.read().auroraRoutes[route.routeId].paymentId, null);
  });
});

test('the outbound path leaks no phone-derived value and no Prism identity to Aurora', async () => {
  await withMock(async (mock) => {
    const { auroraService, alice } = stack();
    await quote(auroraService);

    const digits = PHONE.replace(/\D/g, '');
    const needles = new Set([PHONE, digits, phoneLookupKey(PHONE, config.resolverPepper)]);
    for (const form of [PHONE, digits]) {
      for (const algo of ['sha256', 'sha1', 'md5']) needles.add(crypto.createHash(algo).update(form).digest('hex'));
    }

    const sent = JSON.stringify(mock.quotes).toLowerCase();
    for (const needle of needles) {
      assert.equal(sent.includes(needle.toLowerCase()), false, `phone-derived value leaked: ${needle.slice(0, 24)}…`);
    }
    // The only identifying value Aurora receives is the account address, as the refund destination.
    for (const identifying of ['alice example', 'prismid', '"alice"']) {
      assert.equal(sent.includes(identifying), false, `${identifying} leaked to Aurora`);
    }
    assert.equal(mock.quotes[0].refundTo, alice.address);
  });
});

test('the app key never reaches a client through any route surface', async () => {
  await withMock(async () => {
    const { auroraService } = stack();
    const responses = [await quote(auroraService), auroraService.listRoutes('alice'), await auroraService.chains()];
    for (const response of responses) {
      assert.equal(JSON.stringify(response).includes(config.aurora.appKey), false);
    }
  });
});
