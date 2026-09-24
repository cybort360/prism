import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';

// Fully-wired backend (config reads env at load).
process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;

function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-sweep-')), 'store.json')); }

test('prepareExternalSend honors an explicit validBefore', async () => {
  const { PaymentService } = await import('../src/services/paymentService.js');
  const store = tmpStore();
  const identityService = { get: () => ({ prismId: 'p1', accountAddress: '0x00000000000000000000000000000000000000A1', account: '0x00000000000000000000000000000000000000A1', aliasVersion: 1 }) };
  const config = (await import('../src/config.js')).config;
  const svc = new PaymentService({ store, config, identityService });
  const far = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const prepared = await svc.prepareExternalSend({
    senderPrismId: 'p1', recipientAddress: '0x000000000000000000000000000000000000dEaD',
    amountAtomic: '1000000', boundHash: '0x' + '00'.repeat(32), kind: 'sweep-test', validBefore: far
  });
  // The prepared authorization must carry the far deadline, not now+AUTH_WINDOW.
  assert.equal(Math.floor(Date.parse(prepared.expiresAt) / 1000), far);
});

test('SweepService.prepareForDraft builds a CIRCLE contribution authorization with far validBefore', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  const request = { requestId: 'req_1', requesterPrismId: 'p1', amountAtomic: '1000000', destination: 'CIRCLE', circleId: 'circle_1', expiresAt };
  store.mutate((d) => { d.requests = { req_1: request }; });
  let seenValidBefore = null;
  const circleService = {
    prepareContribution: async ({ circleId, prismId, amountAtomic, validBefore }) => {
      seenValidBefore = validBefore;
      return { typedData: { envelope: { primaryType: 'X' }, tokenAuthorization: { primaryType: 'ReceiveWithAuthorization' } }, contribution: { contributionId: 'ctb_1' } };
    }
  };
  const svc = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });
  const sweep = await svc.prepareForDraft(store.read().requests.req_1);
  assert.equal(sweep.destination, 'CIRCLE');
  assert.equal(sweep.preparedId, 'ctb_1');
  assert.equal(seenValidBefore, Math.floor(Date.parse(expiresAt) / 1000));
  assert.ok(sweep.authorization.tokenAuthorization, 'returns signable contribution typed data');
  assert.equal(store.read().requests.req_1.sweep.state, 'PREPARING');
});

test('draft -> prepareForDraft -> attachSignatures stores a PENDING sweep with signatures', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const { RequestService } = await import('../src/services/requestService.js');
  const store = tmpStore();
  const config = (await import('../src/config.js')).config;
  const identityService = { get: (prismId) => (prismId === 'p1' ? { prismId: 'p1', accountAddress: '0x00000000000000000000000000000000000000A1' } : null) };
  const requestService = new RequestService({ store, identityService, config });

  let seenValidBefore = null;
  const circleService = {
    prepareContribution: async ({ circleId, prismId, amountAtomic, validBefore }) => {
      seenValidBefore = validBefore;
      return { typedData: { envelope: { primaryType: 'X' }, tokenAuthorization: { primaryType: 'ReceiveWithAuthorization' } }, contribution: { contributionId: 'ctb_2' } };
    }
  };
  const sweepService = new SweepService({ store, circleService, saveService: null, config });

  const drafted = requestService.draft({ requesterPrismId: 'p1', amountAtomic: '1000000', destination: 'CIRCLE', circleId: 'circle_1' });
  const sweep = await sweepService.prepareForDraft(drafted.request);
  assert.equal(sweep.destination, 'CIRCLE');
  assert.equal(sweep.preparedId, 'ctb_2');
  assert.ok(seenValidBefore);
  assert.equal(store.read().requests[drafted.request.requestId].sweep.state, 'PREPARING');

  const sweepSignatures = { envelope: '0xenvelopesig', tokenAuthorization: '0xtokensig' };
  const attached = await sweepService.attachSignatures({ requestId: drafted.request.requestId, requesterPrismId: 'p1', sweepSignatures });
  assert.equal(attached.state, 'PENDING');
  assert.deepEqual(attached.signatures, sweepSignatures);

  const stored = store.read().requests[drafted.request.requestId].sweep;
  assert.equal(stored.state, 'PENDING');
  assert.deepEqual(stored.signatures, sweepSignatures);
});

test('executeFor submits a PENDING CIRCLE sweep exactly once (idempotent)', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_1: { requestId: 'req_1', requesterPrismId: 'p1', circleId: 'circle_1', sweep: { destination: 'CIRCLE', circleId: 'circle_1', preparedId: 'ctb_1', state: 'PENDING', signatures: { prismSignature: '0xaa', tokenSignature: '0xbb' } } } }; });
  let calls = 0;
  // SWEPT now requires on-chain confirmation, so the fake reconciles the broadcast to COMPLETED.
  const circleService = {
    submitContribution: async () => { calls++; return { state: 'confirming', txHash: '0xctb' }; },
    reconcileContribution: async () => ({ contribution: { status: 'COMPLETED', transactionHash: '0xctb' } })
  };
  const svc = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });
  const r1 = await svc.executeFor('req_1');
  const r2 = await svc.executeFor('req_1'); // second call must NOT resubmit
  assert.equal(calls, 1);
  assert.ok(['SUBMITTED', 'SWEPT'].includes(store.read().requests.req_1.sweep.state));
  assert.equal(store.read().requests.req_1.sweep.transactionHash, '0xctb');
});

test('executeFor submits a SAVINGS sweep via the demo Save executor', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_2: { requestId: 'req_2', requesterPrismId: 'p1', sweep: { destination: 'SAVINGS', preparedId: 'sweep_q1', state: 'PENDING', signatures: { signature: '0xcc' } } } }; });
  const demoSaveExecutor = { submitDeposit: async ({ quoteId }) => ({ txHash: '0xsave', state: 'SAVED', operationId: 'op1' }) };
  const svc = new SweepService({ store, circleService: null, saveService: null, demoSaveExecutor, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_2');
  assert.equal(res.state, 'SWEPT');
  assert.equal(store.read().requests.req_2.sweep.transactionHash, '0xsave');
});

test('a failed sweep marks FAILED and leaves the request intact (funds stay in primary)', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_3: { requestId: 'req_3', requesterPrismId: 'p1', sweep: { destination: 'SAVINGS', preparedId: 'q', state: 'PENDING', signatures: { signature: '0x' } } } }; });
  const demoSaveExecutor = { submitDeposit: async () => { throw new Error('quote expired'); } };
  const svc = new SweepService({ store, circleService: null, saveService: null, demoSaveExecutor, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_3');
  assert.equal(res.state, 'FAILED');
  assert.equal(store.read().requests.req_3.sweep.state, 'FAILED');
  assert.match(store.read().requests.req_3.sweep.failure, /quote expired/);
});

test('getOwn retries a PENDING sweep on read and reflects the fresh SWEPT state (missed-settlement recovery)', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const { RequestService } = await import('../src/services/requestService.js');
  const store = tmpStore();
  const config = (await import('../src/config.js')).config;
  const identityService = { get: (prismId) => (prismId === 'p1' ? { prismId: 'p1', accountAddress: '0x00000000000000000000000000000000000000A1' } : null) };
  const requestService = new RequestService({ store, identityService, config });
  store.mutate((d) => {
    d.requests = {
      req_1: {
        requestId: 'req_1', requesterPrismId: 'p1', status: 'PAID', amountAtomic: '1000000', destination: 'CIRCLE', circleId: 'circle_1',
        sweep: { destination: 'CIRCLE', circleId: 'circle_1', preparedId: 'ctb_1', state: 'PENDING', signatures: { prismSignature: '0xaa', tokenSignature: '0xbb' } }
      }
    };
  });

  // Sanity: unowned callers and nonexistent ids 404, never leaking the request.
  assert.throws(() => requestService.getOwn('req_1', 'someone-else'), (e) => e.statusCode === 404);
  assert.throws(() => requestService.getOwn('nope', 'p1'), (e) => e.statusCode === 404);

  const before = requestService.getOwn('req_1', 'p1');
  assert.equal(before.sweep.state, 'PENDING');

  let calls = 0;
  const circleService = {
    submitContribution: async () => { calls++; return { state: 'confirming', txHash: '0xctb' }; },
    reconcileContribution: async () => ({ contribution: { status: 'COMPLETED', transactionHash: '0xctb' } })
  };
  const sweepService = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });

  // Route-equivalent logic: a PENDING/SUBMITTED sweep is retried on read, not just at settlement.
  if (before.sweep?.state === 'PENDING' || before.sweep?.state === 'SUBMITTED') { await sweepService.executeFor('req_1').catch(() => {}); }
  const after = requestService.getOwn('req_1', 'p1');

  assert.equal(calls, 1);
  assert.ok(['SUBMITTED', 'SWEPT'].includes(after.sweep.state));
  assert.equal(after.sweep.transactionHash, '0xctb');
});

// --- money-truth: SWEPT means the second hop CONFIRMED on-chain (INV-M1/M2) --------------------

test('SAVINGS sweep: a REVERTED deposit (state FAILED) settles FAILED, never SWEPT', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_f: { requestId: 'req_f', requesterPrismId: 'p1', sweep: { destination: 'SAVINGS', preparedId: 'q', state: 'PENDING', signatures: { signature: '0xcc' } } } }; });
  // submitDeposit RESOLVES on revert (does not throw) — the old code recorded this SWEPT.
  const demoSaveExecutor = { submitDeposit: async () => ({ txHash: '0xrevert', state: 'FAILED', operationId: 'op1' }) };
  const svc = new SweepService({ store, circleService: null, saveService: null, demoSaveExecutor, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_f');
  assert.equal(res.state, 'FAILED');
  assert.equal(store.read().requests.req_f.sweep.state, 'FAILED');
  assert.notEqual(store.read().requests.req_f.sweep.state, 'SWEPT');
});

test('SAVINGS sweep: a CONFIRMED deposit (state SAVED) settles SWEPT with the tx hash', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_s: { requestId: 'req_s', requesterPrismId: 'p1', sweep: { destination: 'SAVINGS', preparedId: 'q', state: 'PENDING', signatures: { signature: '0xcc' } } } }; });
  const demoSaveExecutor = { submitDeposit: async () => ({ txHash: '0xsaved', state: 'SAVED', operationId: 'op1' }) };
  const svc = new SweepService({ store, circleService: null, saveService: null, demoSaveExecutor, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_s');
  assert.equal(res.state, 'SWEPT');
  assert.equal(store.read().requests.req_s.sweep.transactionHash, '0xsaved');
});

test('SAVINGS sweep: an unmined deposit (state CONFIRMING) stays SUBMITTED, never SWEPT', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_c: { requestId: 'req_c', requesterPrismId: 'p1', sweep: { destination: 'SAVINGS', preparedId: 'q', state: 'PENDING', signatures: { signature: '0xcc' } } } }; });
  const demoSaveExecutor = { submitDeposit: async () => ({ txHash: '0xpending', state: 'CONFIRMING', operationId: 'op1' }) };
  const svc = new SweepService({ store, circleService: null, saveService: null, demoSaveExecutor, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_c');
  assert.equal(res.state, 'SUBMITTED');
  assert.equal(store.read().requests.req_c.sweep.state, 'SUBMITTED');
});

test('CIRCLE sweep: reconcile COMPLETED settles SWEPT with the confirmed tx hash', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_cc: { requestId: 'req_cc', requesterPrismId: 'p1', circleId: 'circle_1', sweep: { destination: 'CIRCLE', circleId: 'circle_1', preparedId: 'ctb_1', state: 'PENDING', signatures: { prismSignature: '0xaa', tokenSignature: '0xbb' } } } }; });
  let submits = 0;
  const circleService = {
    submitContribution: async () => { submits++; return { state: 'confirming', txHash: '0xbroadcast' }; },
    reconcileContribution: async () => ({ contribution: { status: 'COMPLETED', transactionHash: '0xconfirmed' } })
  };
  const svc = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_cc');
  assert.equal(submits, 1);
  assert.equal(res.state, 'SWEPT');
  assert.equal(store.read().requests.req_cc.sweep.transactionHash, '0xconfirmed');
});

test('CIRCLE sweep: a non-terminal reconcile stays SUBMITTED, then a SUBMITTED re-entry reconciles to SWEPT (read-retry recovery)', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_re: { requestId: 'req_re', requesterPrismId: 'p1', circleId: 'circle_1', sweep: { destination: 'CIRCLE', circleId: 'circle_1', preparedId: 'ctb_1', state: 'PENDING', signatures: { prismSignature: '0xaa', tokenSignature: '0xbb' } } } }; });
  let submits = 0;
  let contributionStatus = 'CONFIRMING'; // not yet terminal on first pass
  const circleService = {
    submitContribution: async () => { submits++; return { state: 'confirming', txHash: '0xbroadcast' }; },
    reconcileContribution: async () => ({ contribution: { status: contributionStatus, transactionHash: contributionStatus === 'COMPLETED' ? '0xconfirmed' : null } })
  };
  const svc = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });

  const first = await svc.executeFor('req_re'); // PENDING -> submit + reconcile(CONFIRMING) -> SUBMITTED
  assert.equal(first.state, 'SUBMITTED');
  assert.equal(store.read().requests.req_re.sweep.state, 'SUBMITTED');

  contributionStatus = 'COMPLETED'; // chain confirms before the next read
  const second = await svc.executeFor('req_re'); // SUBMITTED re-entry: reconcile only, NO resubmit
  assert.equal(submits, 1, 'the re-entry must not resubmit the contribution');
  assert.equal(second.state, 'SWEPT');
  assert.equal(store.read().requests.req_re.sweep.transactionHash, '0xconfirmed');
});

test('CIRCLE sweep: a REVERTED contribution (status FAILED) settles FAILED, never SWEPT', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_cf: { requestId: 'req_cf', requesterPrismId: 'p1', circleId: 'circle_1', sweep: { destination: 'CIRCLE', circleId: 'circle_1', preparedId: 'ctb_1', state: 'PENDING', signatures: { prismSignature: '0xaa', tokenSignature: '0xbb' } } } }; });
  let submits = 0;
  const circleService = {
    submitContribution: async () => { submits++; return { state: 'confirming', txHash: '0xbroadcast' }; },
    reconcileContribution: async () => ({ contribution: { status: 'FAILED', transactionHash: '0xrevert' } })
  };
  const svc = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_cf');
  assert.equal(submits, 1);
  assert.equal(res.state, 'FAILED');
  assert.equal(store.read().requests.req_cf.sweep.state, 'FAILED');
  assert.notEqual(store.read().requests.req_cf.sweep.state, 'SWEPT');
});

test('CIRCLE sweep: an unmined contribution (status CONFIRMING) stays SUBMITTED, never SWEPT', async () => {
  const { SweepService } = await import('../src/services/sweepService.js');
  const store = tmpStore();
  store.mutate((d) => { d.requests = { req_cc2: { requestId: 'req_cc2', requesterPrismId: 'p1', circleId: 'circle_1', sweep: { destination: 'CIRCLE', circleId: 'circle_1', preparedId: 'ctb_1', state: 'PENDING', signatures: { prismSignature: '0xaa', tokenSignature: '0xbb' } } } }; });
  let submits = 0;
  const circleService = {
    submitContribution: async () => { submits++; return { state: 'confirming', txHash: '0xbroadcast' }; },
    reconcileContribution: async () => ({ contribution: { status: 'CONFIRMING', transactionHash: null } })
  };
  const svc = new SweepService({ store, circleService, saveService: null, config: { save: { mode: 'demo' } } });
  const res = await svc.executeFor('req_cc2');
  assert.equal(submits, 1);
  assert.equal(res.state, 'SUBMITTED');
  assert.equal(store.read().requests.req_cc2.sweep.state, 'SUBMITTED');
});

test('PaymentService calls onRequestPaid after markPaid on a completed request payment', async () => {
  const { PaymentService } = await import('../src/services/paymentService.js');
  const store = tmpStore();
  const identityService = { get: () => ({ prismId: 'p1', accountAddress: '0x00000000000000000000000000000000000000A1' }) };
  const config = (await import('../src/config.js')).config;
  let paidWith = null;
  const requestService = { markPaid: () => {} };
  const svc = new PaymentService({ store, config, identityService, requestService, onRequestPaid: (id) => { paidWith = id; } });
  // Drive the real completion path: _applySuccess(record) is the private method that contains the
  // markPaid call at paymentService.js:595 (the brief's placeholder name was `_onPaymentCompleted`;
  // the actual method is `_applySuccess`, invoked synchronously from `reconcile` on a success record).
  svc._applySuccess({ kind: 'payment', operationId: 'op1', intent: { requestId: 'req_9' }, transactionHash: '0xtx' });
  assert.equal(paidWith, 'req_9');
});
