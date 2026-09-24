import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonBody } from '../src/lib/jsonBody.js';
import { receiveAuthorizationTypedData } from '../src/chain/eth.js';

// Regression for the crash the live demo smoke found: a demo Save quote / SAVINGS sweep / withdraw
// returns an EIP-712 authorization whose `message` fields are BigInt (viem uint256). The HTTP `send()`
// JSON.stringify'd it, threw on the BigInt AFTER writeHead had already sent headers, and the catch's
// second send() crashed the whole process (ERR_HTTP_HEADERS_SENT). jsonBody must coerce BigInt to a
// decimal string so these bodies serialize — the same wire shape payments already use.

test('jsonBody coerces a top-level BigInt to a decimal string', () => {
  assert.equal(jsonBody({ n: 250000000n }), '{"n":"250000000"}');
});

test('jsonBody serializes a BigInt nested in an EIP-712 authorization message (the crashing shape)', () => {
  const auth = receiveAuthorizationTypedData({
    from: '0x0B861D6F5Fbf375E5c2D318f3163A3d929b9E3a5',
    to: '0xd6c7F060944Ed7a1622b599D0d69fDA0b8e320A2',
    value: '250000000', validAfter: 0, validBefore: 1893456000, nonce: '0x' + '11'.repeat(32)
  });
  const body = jsonBody({ authorization: auth }); // must NOT throw
  const parsed = JSON.parse(body);
  assert.equal(parsed.authorization.message.value, '250000000');       // BigInt -> string
  assert.equal(parsed.authorization.message.validBefore, '1893456000');
});

test('jsonBody throws on a circular reference (so send() can 500 instead of crashing)', () => {
  const a = {}; a.self = a;
  assert.throws(() => jsonBody(a));
});
