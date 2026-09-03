import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';
import { IdentityService } from '../src/services/identityService.js';
import { meraAccount, PK_A, PK_B } from './helpers.js';

const config = { resolverPepper: 'resolver-secret', dataEncryptionKeyHex: '11'.repeat(32) };
function fixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-')), 'store.json');
  const store = new JsonStore(file);
  return { store, service: new IdentityService({ store, config }) };
}

test('OTP-style phone possession cannot seize a bound account', async () => {
  const { service } = fixture();
  const owner = meraAccount(PK_A), attacker = meraAccount(PK_B);
  await service.upsertVerifiedPhone({ phone: '+2348031234567', account: owner.address, bindingProof: await owner.bindingProof() });
  // The attacker controls their OWN Mera account and passed OTP, but the phone already binds to
  // the owner's account. Their valid binding proof for a different account must be rejected.
  const attackerProof = await attacker.bindingProof();
  await assert.rejects(
    () => service.upsertVerifiedPhone({ phone: '+2348031234567', account: attacker.address, bindingProof: attackerProof }),
    /different account/
  );
});

test('onboarding requires proof of Mera account control', async () => {
  const { service } = fixture();
  const owner = meraAccount(PK_A), attacker = meraAccount(PK_B);
  // A binding proof signed by a different key than the claimed account fails closed.
  const wrongProof = await attacker.bindingProof();
  await assert.rejects(
    () => service.createDeviceIdentity({ account: owner.address, bindingProof: wrongProof }),
    /account control signature/
  );
});

test('phone rotation increments alias version without changing account', async () => {
  const { service } = fixture();
  const owner = meraAccount(PK_A);
  const identity = await service.upsertVerifiedPhone({ phone: '+2348031234567', account: owner.address, bindingProof: await owner.bindingProof() });
  const account = identity.accountAddress, version = identity.aliasVersion;
  const changed = service.bindVerifiedPhone(identity.prismId, '+2348037654321');
  assert.equal(changed.accountAddress, account);
  assert.equal(changed.aliasVersion, version + 1);
});

test('phone and handle mutation require the bound account signature', async () => {
  const { service } = fixture();
  const owner = meraAccount(PK_A), attacker = meraAccount(PK_B);
  const identity = await service.createDeviceIdentity({ account: owner.address, bindingProof: await owner.bindingProof() });

  const phone = '+2348037654321';
  const phonePayload = { action: 'bind_phone', aliasVersion: identity.aliasVersion, prismId: identity.prismId, value: phone };
  const attackerPhoneSig = await attacker.mutation(phonePayload);
  await assert.rejects(() => service.bindVerifiedPhoneAuthorized(identity.prismId, phone, attackerPhoneSig), /invalid account signature/);
  const withPhone = await service.bindVerifiedPhoneAuthorized(identity.prismId, phone, await owner.mutation(phonePayload));
  assert.equal(withPhone.aliasVersion, identity.aliasVersion + 1);

  const handle = 'octane';
  const handlePayload = { action: 'set_handle', aliasVersion: withPhone.aliasVersion, prismId: identity.prismId, value: handle };
  const attackerHandleSig = await attacker.mutation(handlePayload);
  await assert.rejects(() => service.setHandleAuthorized(identity.prismId, handle, attackerHandleSig), /invalid account signature/);
  const withHandle = await service.setHandleAuthorized(identity.prismId, handle, await owner.mutation(handlePayload));
  assert.equal(withHandle.handle, 'octane');
});
