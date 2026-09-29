import test from 'node:test';
import assert from 'node:assert/strict';
import { setChainProvider, resetChainProvider } from '../src/providers/index.js';
import { mintUsdcTo } from '../src/chain/eth.js';

test('mintUsdcTo calls MockUSDC.mint(to, amount) via the relayer and returns the tx hash', async (t) => {
  let seen;
  setChainProvider({ writeContract: async (args) => { seen = args; return '0xmint'; } });
  t.after(resetChainProvider);
  const tx = await mintUsdcTo('0x9226D56F93A3Fe4E78795BBaC1aecfF61E6A28F1', '20000000');
  assert.equal(tx, '0xmint');
  assert.equal(seen.functionName, 'mint');
  assert.equal(seen.args[1], 20000000n); // amount coerced to bigint
});
