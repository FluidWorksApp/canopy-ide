import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp,readFile,stat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hostCredential,serviceControlPlane} from './service-control-plane.mjs';
const managed={key:'k'.repeat(40),workspaceId:'ws-a',runtimePolicyUrl:'https://canopy.example/api/runtime-policy'};
const workspace={id:'ws-a',generation:7};
const claimsOf=token=>{const [payload,signature]=token.split('.');assert.equal(signature,createHmac('sha256',managed.key).update(payload).digest('base64url'));return JSON.parse(Buffer.from(payload,'base64url'));};

test('host credentials are purpose-bound, short-lived and signed with the managed key',()=>{
 const claims=claimsOf(hostCredential(managed,'peer-relay',workspace,{now:()=>1_000_000}));
 assert.deepEqual(claims,{version:1,kind:'peer-relay',workspaceId:'ws-a',generation:7,expires:1120});
 assert.throws(()=>hostCredential(managed,'runtime-policy',workspace),/purpose/);
 assert.throws(()=>hostCredential(managed,'peer-relay',{id:'ws-b',generation:1}),/unavailable/);
 assert.throws(()=>hostCredential({...managed,key:'short'},'peer-relay',workspace),/unavailable/);
});

test('snapshots and host registration go to the control-plane origin with their own credentials',async()=>{
 const requests=[];
 const fetchImpl=async(url,options)=>{requests.push({url,options});
  if(url.includes('workspace-access-snapshot'))return new Response(JSON.stringify({payload:'cA',signature:'cw'}),{status:200});
  return new Response('{}',{status:200});};
 const plane=serviceControlPlane({managedSession:managed},{fetchImpl,now:()=>1_000_000});
 assert.deepEqual(await plane.accessSnapshot(workspace),{payload:'cA',signature:'cw'});
 assert.equal(requests[0].url,'https://canopy.example/api/workspace-access-snapshot?workspace=ws-a');
 assert.equal(claimsOf(requests[0].options.headers.authorization.slice(7)).kind,'workspace-access-snapshot');
 await plane.registerHost(workspace,{deviceId:'dev',keys:{agreement:{kty:'EC'},signing:{kty:'EC'}},extra:true});
 assert.equal(requests[1].url,'https://canopy.example/api/peers');
 assert.deepEqual(JSON.parse(requests[1].options.body),{action:'register-host',deviceId:'dev',keys:{agreement:{kty:'EC'},signing:{kty:'EC'}},workspaceIds:['ws-a']});
 assert.equal(claimsOf(requests[1].options.headers.authorization.slice(7)).kind,'peer-host-registration');
 const denied=serviceControlPlane({managedSession:managed},{fetchImpl:async()=>new Response('{}',{status:403})});
 await assert.rejects(denied.accessSnapshot(workspace),/refused \(403\)/);
 const huge=serviceControlPlane({managedSession:managed},{fetchImpl:async()=>new Response('x'.repeat(70000),{status:200})});
 await assert.rejects(huge.accessSnapshot(workspace),/too large/);
 assert.equal(serviceControlPlane({}),undefined);
 assert.throws(()=>serviceControlPlane({managedSession:{...managed,peersUrl:'http://canopy.example/api/peers'}}),/Invalid/);
});

test('the relay credential is written atomically, group-readable, per workspace',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canopy-relay-'));
 try{
  const plane=serviceControlPlane({managedSession:managed},{fetchImpl:async()=>{throw Error('no network');}});
  await plane.writeRelayCredential(workspace,dir);await plane.writeRelayCredential(workspace,dir);
  const file=join(dir,'ws-a','relay-credential'),token=await readFile(file,'utf8');
  assert.equal(claimsOf(token).kind,'peer-relay');assert.ok(!token.includes('\n')&&!token.startsWith('Bearer'));
  assert.equal((await stat(file)).mode&0o777,0o640);
  assert.deepEqual(await readdir(join(dir,'ws-a')),['relay-credential'],'no temp files remain');
 }finally{await rm(dir,{recursive:true,force:true});}
});
