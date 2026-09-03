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
