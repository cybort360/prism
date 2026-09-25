import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { JsonStore } from '../src/lib/jsonStore.js';
import { KeyService } from '../src/services/keyService.js';
import { ResolverService } from '../src/services/resolverService.js';
import { phoneLookupKey } from '../src/lib/crypto.js';

const cfg={resolverPepper:'pepper',serviceKeyEncryptionKeyHex:'22'.repeat(32)};
function fixture(){
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'prism-')),'store.json'); const store=new JsonStore(file);
  const phone='+2348031234567'; const lookup=phoneLookupKey(phone,cfg.resolverPepper);
  store.mutate(d=>{d.identities.target={prismId:'target',accountAddress:'0x1111111111111111111111111111111111111111',aliasVersion:2,phoneDiscoverable:true};d.phoneIndex[lookup]='target';});
  const keyService=new KeyService(store,cfg); const identityService={get:id=>store.read().identities[id]};
  return {store,phone,resolver:new ResolverService({store,config:cfg,keyService,identityService})};
}

test('resolver stores no raw phone and returns requester-bound signed short-lived result',()=>{
  const {store,phone,resolver}=fixture();
  const result=resolver.resolvePhone('sender',phone);
  assert.equal(result.found,true); assert.equal(result.attestation.aliasVersion,2);
  assert.equal(result.attestation.requesterPrismId,'sender');
  assert.equal(resolver.verifyResolution(result,'sender').prismIdentity,'target');
  assert.throws(()=>resolver.verifyResolution(result,'attacker'),/another requester/);
  assert.equal(JSON.stringify(store.read()).includes(phone),false);
  assert.equal('privateKeyPem' in store.read().serviceKeys.resolver,false);
  assert.ok(store.read().serviceKeys.resolver.privateKeyEncrypted);
});

test('phone privacy setting fails closed',()=>{
  const {store,phone,resolver}=fixture();
  store.mutate(d=>{d.identities.target.phoneDiscoverable=false;});
  assert.deepEqual(resolver.resolvePhone('sender',phone),{found:false,reason:'not_discoverable'});
});

// --- handleOnPrism: cheap as-you-type existence check (no attestation, no account leak) -----------
test('handleOnPrism confirms a real handle without issuing an attestation', () => {
  const { store, resolver } = fixture();
  store.mutate((d) => { d.identities.target.handle = 'tester2'; d.handleIndex ||= {}; d.handleIndex.tester2 = 'target'; });

  const hit = resolver.handleOnPrism('me', '@Tester2'); // @ optional, case-insensitive
  assert.equal(hit.onPrism, true);
  assert.equal(hit.handle, 'tester2');
  assert.equal(hit.attestation, undefined, 'no signed attestation is issued for a check');
  assert.equal(hit.signature, undefined, 'no account/signature is revealed');
});

test('handleOnPrism reports a handle that is not on Prism (never a false positive)', () => {
  const { resolver } = fixture();
  const miss = resolver.handleOnPrism('me', 'nobody');
  assert.equal(miss.onPrism, false);
  assert.equal(miss.reason, 'not_found');
});

test('handleOnPrism fails closed for a non-discoverable handle', () => {
  const { store, resolver } = fixture();
  store.mutate((d) => { d.identities.target.handle = 'ghost'; d.identities.target.handleSearchable = false; d.handleIndex = { ghost: 'target' }; });
  const res = resolver.handleOnPrism('me', 'ghost');
  assert.equal(res.onPrism, false);
  assert.equal(res.reason, 'not_discoverable');
});
