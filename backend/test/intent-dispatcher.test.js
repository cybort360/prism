import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';
import { RequestService } from '../src/services/requestService.js';
import { IntentDispatcherService } from '../src/services/intentDispatcherService.js';
import { meraAccount, PK_A, PK_B } from './helpers.js';

const USDC = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const config = {
  limits: { maxPaymentAtomic: 10_000_000_000n },
  chain: { usdc: USDC }
};

function requestFixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-')), 'store.json');
  const store = new JsonStore(file);
  const a = meraAccount(PK_A), b = meraAccount(PK_B);
  store.mutate(d => {
    d.identities.a = { prismId: 'a', account: a.address, accountAddress: a.address };
    d.identities.b = { prismId: 'b', account: b.address, accountAddress: b.address };
  });
  const identityService = { get: id => store.read().identities[id] ?? null };
  return { store, a, b, requests: new RequestService({ store, identityService, config }) };
}

function stubCircles({ route = 'ALLOWANCE', overLimit = false } = {}) {
  const calls = [];
  return {
    calls,
    async previewPayment({ circleId, actorPrismId, amountAtomic }) {
      calls.push(['previewPayment', { circleId, actorPrismId, amountAtomic }]);
      if (route === 'ALLOWANCE') {
        return { circleId, amountAtomic, route: 'ALLOWANCE', requiresApproval: false, reason: null, limit: { availableAtomic: '100000000' } };
      }
      return {
        circleId, amountAtomic, route: 'THRESHOLD', requiresApproval: true,
        overLimit, reason: 'This is above your $100.00 daily limit.',
        prompt: 'Request approval from the Circle?',
        requiredApprovals: 2, limit: { availableAtomic: '10000000' }
      };
    },
    async prepareSpend(args) {
      calls.push(['prepareSpend', args]);
      return { spend: { spendId: 'spd_test', status: 'PREPARED', ...args }, transferHash: '0xhash', limit: {} };
    },
    async proposePayment(args) {
      calls.push(['proposePayment', args]);
      // Ordinary threshold proposal: approvals counted from owner signatures later.
      // The stub mirrors the real shape — threshold comes from chain authority,
      // never from the memo.
      return { proposalId: 'prp_test', kind: 'PAYMENT', status: 'APPROVAL_PENDING', requiredApprovals: 2, memo: args.memo ?? '', safeTxHash: '0xtx' };
    }
  };
}

function stubAurora() {
  const calls = [];
  return {
    calls,
    async quoteSend(args) {
      calls.push(['quoteSend', args]);
      return { routeId: 'route_test', state: 'quoted', ...args, minAmountOut: '9900000' };
    },
    async prepareSend({ prismId, routeId }) {
      calls.push(['prepareSend', { prismId, routeId }]);
      return { paymentId: 'pay_test', state: 'prepared', routeHash: '0xroutehash', route: { routeId, state: 'quoted' } };
    }
  };
}

function dispatcher({ circles, requests, aurora } = {}) {
  const rf = requests ?? requestFixture().requests;
  return new IntentDispatcherService({
    circleService: circles ?? stubCircles(),
    requestService: rf,
    auroraService: aurora ?? stubAurora(),
    config
  });
}

const RESOLUTION = { prismId: 'b', requestId: 'req_1' };

// --- SPEND: within limit vs Graceful Overflow --------------------------------

test('SPEND within limit delegates to allowance prepare (no overflow)', async () => {
  const circles = stubCircles({ route: 'ALLOWANCE' });
  const svc = dispatcher({ circles });
  const out = await svc.prepareIntent({
    kind: 'SPEND', circleId: 'c1', actorPrismId: 'a',
    resolution: RESOLUTION, amountAtomic: '5000000'
  });
  assert.equal(out.route, 'ALLOWANCE');
  assert.equal(out.requiresApproval, false);
  assert.equal(out.overflow, false);
  assert.ok(circles.calls.some(([n]) => n === 'prepareSpend'));
  assert.ok(!circles.calls.some(([n]) => n === 'proposePayment'));
});

test('SPEND over limit overflows to a threshold proposal with context-only memo', async () => {
  const circles = stubCircles({ route: 'THRESHOLD', overLimit: true });
  const svc = dispatcher({ circles });
  const out = await svc.prepareIntent({
    kind: 'SPEND', circleId: 'c1', actorPrismId: 'a',
    resolution: RESOLUTION, amountAtomic: '140000000',
    overflowMessage: 'Need extra for venue deposit, event is Friday'
  });
  assert.equal(out.route, 'THRESHOLD');
  assert.equal(out.overflow, true);
  assert.equal(out.overLimit, true);
  assert.equal(out.requiredApprovals, 2);
  const [, args] = circles.calls.find(([n]) => n === 'proposePayment');
  // Context travels as display memo only...
  assert.equal(args.memo, 'Need extra for venue deposit, event is Friday');
  // ...and never as authority: no threshold/approval/digest field is settable.
  assert.ok(!('threshold' in args) && !('requiredApprovals' in args) && !('approvals' in args));
  // The proposal itself is pending approvals, never completed by the facade.
  assert.equal(out.proposal.status, 'APPROVAL_PENDING');
  assert.notEqual(out.proposal.status, 'COMPLETED');
});

// --- RECEIVE: destination validation ------------------------------------------

test('RECEIVE PRIMARY drafts a request; signable envelope is untouched', async () => {
  const svc = dispatcher();
  const out = await svc.prepareIntent({
    kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: 'b',
    amountAtomic: '15000000', memo: 'Dinner', destination: 'PRIMARY'
  });
  assert.equal(out.destination, 'PRIMARY');
  assert.equal(out.request.status, 'DRAFT');
  // Zero-regression: the signed payload carries exactly the requestService fields.
  assert.deepEqual(
    Object.keys(JSON.parse(out.signable)).sort(),
    ['amountAtomic', 'createdAt', 'expiresAt', 'memo', 'payerPrismId', 'requestId', 'requesterPrismId', 'token', 'tokenSymbol'].sort()
  );
});

test('RECEIVE SAVINGS and CIRCLE validate destination', async () => {
  const svc = dispatcher();
  const savings = await svc.prepareIntent({
    kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: 'b',
    amountAtomic: '15000000', destination: 'SAVINGS'
  });
  assert.equal(savings.destination, 'SAVINGS');
  assert.ok(savings.savingsNote);

  const circle = await svc.prepareIntent({
    kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: 'b',
    amountAtomic: '15000000', destination: 'CIRCLE', circleId: 'c1'
  });
  assert.equal(circle.circleId, 'c1');

  await assert.rejects(
    () => svc.prepareIntent({ kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', destination: 'CIRCLE' }),
    /circleId is required/
  );
  await assert.rejects(
    () => svc.prepareIntent({ kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '15000000', destination: 'MARS' }),
    /unknown destination/
  );
});

// --- CROSS_CHAIN ---------------------------------------------------------------

test('CROSS_CHAIN quotes by default and prepares with routeId', async () => {
  const aurora = stubAurora();
  const svc = dispatcher({ aurora });
  const quoted = await svc.prepareIntent({
    kind: 'CROSS_CHAIN', prismId: 'a', destinationChain: 'arbitrum',
    destinationAsset: 'ETH', destinationAddress: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    amountAtomic: '20000000'
  });
  assert.equal(quoted.step, 'quoted');
  assert.equal(quoted.route.routeId, 'route_test');
  assert.match(quoted.binding, /routeHash/);

  const prepared = await svc.prepareIntent({ kind: 'CROSS_CHAIN', prismId: 'a', routeId: 'route_test' });
  assert.equal(prepared.step, 'prepared');
  assert.ok(prepared.routeHash);
});

// --- Guardrails: privacy, kinds, no transitions ---------------------------------

test('phone numbers are rejected in memo, message, and nested params (INV-P1)', async () => {
  const svc = dispatcher();
  await assert.rejects(
    () => svc.prepareIntent({ kind: 'SPEND', circleId: 'c1', actorPrismId: 'a', resolution: RESOLUTION, amountAtomic: '1000', overflowMessage: 'call me on +15551234567' }),
    /INV-P1/
  );
  await assert.rejects(
    () => svc.prepareIntent({ kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '1000', memo: 'reach me at 415-555-1234' }),
    /INV-P1/
  );
  await assert.rejects(
    () => svc.prepareIntent({ kind: 'RECEIVE', requesterPrismId: 'a', payerPrismId: 'b', amountAtomic: '1000', memo: { note: 'tel:+15551234567' } }),
    /must be a string|INV-P1/
  );
});

test('unknown kinds are rejected and the facade exposes no submit/execute surface', async () => {
  const svc = dispatcher();
  await assert.rejects(() => svc.prepareIntent({ kind: 'SEND' }), /unknown intent kind/);
  await assert.rejects(() => svc.prepareIntent({}), /unknown intent kind/);
  for (const m of ['submitIntent', 'executeIntent', 'completeIntent', 'reconcileIntent', 'submitSpend', 'submitPayment']) {
    assert.equal(typeof svc[m], 'undefined', `${m} must not exist on the facade`);
  }
  assert.deepEqual(svc.kinds().sort(), ['CROSS_CHAIN', 'RECEIVE', 'SPEND']);
});

test('non-positive amounts are rejected before any delegation', async () => {
  const circles = stubCircles();
  const svc = dispatcher({ circles });
  await assert.rejects(
    () => svc.prepareIntent({ kind: 'SPEND', circleId: 'c1', actorPrismId: 'a', resolution: RESOLUTION, amountAtomic: '0' }),
    /positive integer/
  );
  assert.equal(circles.calls.length, 0, 'no delegate was touched');
});
