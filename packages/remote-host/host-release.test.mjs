import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {readHostRelease,hostReport,HOST_RELEASE_FILE,HOST_RUNTIME_SHA256_FILE} from './host-release.mjs';
import {HOST_PROTOCOL} from './native-commands.mjs';
import {runtimeAuthority} from './runtime-authority.mjs';
const key='k'.repeat(48),workspace={id:'ws-11111111-1111-4111-8111-111111111111',generation:4};
test('host release comes from the installed manifest and the installer-written archive hash',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'canopy-host-release-'));
 try{
  const directory=pathToFileURL(dir+'/');
  assert.deepEqual(await readHostRelease({directory}),{revision:null,protocol:HOST_PROTOCOL,runtimeSha256:null},'a development tree reports what it can');
  await writeFile(join(dir,HOST_RELEASE_FILE),JSON.stringify({revision:'a'.repeat(40),runtimeLockSha256:'f'.repeat(64)}));
  await writeFile(join(dir,HOST_RUNTIME_SHA256_FILE),'b'.repeat(64)+'\n');
  assert.deepEqual(await readHostRelease({directory}),{revision:'a'.repeat(40),protocol:HOST_PROTOCOL,runtimeSha256:'b'.repeat(64)});
  await writeFile(join(dir,HOST_RELEASE_FILE),JSON.stringify({revision:'main'}));await writeFile(join(dir,HOST_RUNTIME_SHA256_FILE),'not a hash');
  assert.deepEqual(await readHostRelease({directory}),{revision:null,protocol:HOST_PROTOCOL,runtimeSha256:null},'malformed values are never reported');
  await writeFile(join(dir,HOST_RELEASE_FILE),'{');assert.equal((await readHostRelease({directory})).revision,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('the report carries the gateway release with the owner container\'s protocol and image',async()=>{
 const release=async()=>({revision:'a'.repeat(40),protocol:HOST_PROTOCOL,runtimeSha256:'b'.repeat(64)}),image='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'c'.repeat(64);
 assert.deepEqual(await hostReport({release,owner:async()=>({image,protocol:4})}),{revision:'a'.repeat(40),protocol:4,runtimeSha256:'b'.repeat(64),image},'the protocol the IDE talks to is the container\'s, not this gateway\'s');
 assert.deepEqual(await hostReport({release,owner:async()=>{throw Error('docker down');}}),{revision:'a'.repeat(40),protocol:null,runtimeSha256:'b'.repeat(64),image:null});
 assert.deepEqual(await hostReport({release}),{revision:'a'.repeat(40),protocol:null,runtimeSha256:'b'.repeat(64),image:null},'no owner container: unknown, never the gateway protocol');
});
test('runtime policy reports the host on every call, and still authorizes when it cannot be read',async()=>{
 const bodies=[];let reads=0;
 const fetchImpl=async(url,options)=>{bodies.push(JSON.parse(options.body));return Response.json({allowed:true,workspaceId:workspace.id,generation:4});};
 const host={revision:'a'.repeat(40),protocol:HOST_PROTOCOL,runtimeSha256:null,image:null};
 const authority=runtimeAuthority('https://control.invalid/api/runtime-policy',{key,workspaceId:workspace.id},{fetchImpl,hostRelease:async()=>{reads++;return host;}});
 assert.equal(await authority(workspace),true);assert.equal(await authority(workspace),true);
 assert.deepEqual(bodies,[{host},{host}]);assert.equal(reads,2);
 bodies.length=0;
 const unreadable=runtimeAuthority('https://control.invalid/api/runtime-policy',{key,workspaceId:workspace.id},{fetchImpl,hostRelease:async()=>{throw Error('unreadable');}});
 assert.equal(await unreadable(workspace),true);assert.deepEqual(bodies,[{}]);
});
