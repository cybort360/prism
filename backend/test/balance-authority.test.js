import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { meraAccount, PK_A } from './helpers.js';

// Requirement 9 (INV-M2): the backend never writes an authoritative balance that can supersede Monad.
// Balance is always an on-chain read; the persisted store holds no balance ledger.

process.env.MONAD_CHAIN_ID = '10143';
process.env.PRISM_PAYMENT_ROUTER = '0x0000000000000000000000000000000000000A11';
process.env.PRISM_CLAIM_VAULT = '0x0000000000000000000000000000000000000B22';
process.env.RELAYER_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
process.env.CLAIM_AUTHORIZER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;

const { JsonStore } = await import('../src/lib/jsonStore.js');
const { usdcBalanceOf } = await import('../src/chain/eth.js');
const { setChainProvider, resetChainProvider } = await import('../src/providers/index.js');
const { makeMockChainProvider } = await import('../src/providers/mockChainProvider.js');

function freshStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-bal-')), 'store.json');
  return new JsonStore(file);
}

test('req9: the persisted store has no balance/ledger key', () => {
  const store = freshStore();
  for (const k of Object.keys(store.read())) {
    assert.ok(!/balance|ledger|funds/i.test(k), `store key "${k}" looks like an authoritative balance ledger`);
  }
  // Even after recording completed money operations, no balance ledger is introduced.
  store.mutate(d => { d.operations['op1'] = { operationId: 'op1', kind: 'payment', state: 'completed', intent: { amountAtomic: '999999999' } }; });
  const snap = store.read();
  assert.ok(!('balances' in snap) && !('ledger' in snap) && !('funds' in snap),
    'the backend must not accumulate an authoritative balance');
});

test('req9: reported balance tracks the CHAIN, and store writes cannot supersede it', async () => {
  const addr = meraAccount(PK_A).address;
  let onchain = 5_000000n; // the chain is the only source of truth
  const mock = makeMockChainProvider({ readContract: () => onchain });
  setChainProvider(mock);
  try {
    assert.equal((await usdcBalanceOf(addr)).toString(), '5000000');

    onchain = 42_000000n; // chain state changes
    assert.equal((await usdcBalanceOf(addr)).toString(), '42000000', 'balance follows on-chain state');

    // A completed operation in the backend store must NOT change the reported balance — the backend is
    // not a ledger. Only the chain read decides.
    const store = freshStore();
    store.mutate(d => { d.operations['op'] = { operationId: 'op', kind: 'payment', state: 'completed', intent: { amountAtomic: '1000000000' } }; });
    assert.equal((await usdcBalanceOf(addr)).toString(), '42000000', 'store writes cannot supersede the chain balance');
  } finally {
    resetChainProvider();
  }
});
