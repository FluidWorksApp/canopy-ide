import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DockerWorkspaces,retainedRuntimeImage} from './docker.mjs';
const old='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'a'.repeat(64),latest='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'b'.repeat(64),checkpoint='sha256:'+'c'.repeat(64),newImage='sha256:'+'d'.repeat(64);
function fixture(ownerImage){
 const calls=[],workspace={id:'alice',accounts:[],memoryMiB:2048,cpus:2,...(ownerImage?{ownerImage}:{})};let current;
 const host=new DockerWorkspaces({secret:'synthetic',image:latest,releaseChannel:latest,resolveRelease:async()=>{calls.push(['lookup']);return latest;},docker:async args=>{calls.push(args);if(args[0]==='inspect')return {stdout:JSON.stringify([current])};return {stdout:''};}});
 current={Id:'e'.repeat(64),Image:ownerImage??'sha256:'+'f'.repeat(64),Config:{Labels:{'canopy.workspace':'alice','canopy.image-channel':old},Image:ownerImage??old,User:'1000:1000',Env:[`CANOPY_RUNNER_TOKEN=${host.token('alice')}`,'CANOPY_ACCOUNTS=']},HostConfig:{Memory:2147483648,MemorySwap:3758096384,NanoCpus:2e9,RestartPolicy:{Name:'on-failure',MaximumRetryCount:3},PidsLimit:1024,CapDrop:['ALL'],CapAdd:[],NetworkMode:'canopy-net-alice',SecurityOpt:['no-new-privileges:true']},Mounts:[{Type:'volume',Destination:'/workspace',Name:'canopy-project-alice',RW:true},{Type:'volume',Destination:'/home/agent',Name:'canopy-home-alice',RW:true}],State:{Running:true},NetworkSettings:{Networks:{'canopy-net-alice':{IPAddress:'172.18.0.2'}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'45000'}]}}};
 return {host,workspace,calls,get current(){return current;},set current(next){current=next;}};
}
test('new management digest preserves a running published image and exact private checkpoint without pulls or mutation',async()=>{
 for(const ownerImage of [undefined,checkpoint]){const f=fixture(ownerImage),before=structuredClone(f.current);assert.ok((await f.host.ensure(f.workspace)).url);assert.deepEqual(f.current,before);assert.deepEqual(f.calls.map(args=>args[0]),['inspect','inspect']);}
});
test('retained image provenance cannot bypass image, workspace, member or container isolation checks',async()=>{
 const invalid=[c=>{c.Config.Image='ghcr.io/other/workspace@sha256:'+'a'.repeat(64);},c=>{c.Config.Labels['canopy.image-channel']='ghcr.io/other/workspace:stable';},c=>{c.Config.Image='ghcr.io/fluidworksapp/canopy-workspace:unverified';},c=>{delete c.Config.Labels['canopy.image-channel'];},c=>{c.Image='arbitrary';},c=>{c.Config.Labels['canopy.workspace']='bob';},c=>{c.Mounts[0].Name='canopy-project-bob';},c=>{c.HostConfig.CapAdd=['SYS_ADMIN'];}];
 for(const change of invalid){const f=fixture();change(f.current);await assert.rejects(f.host.ensure(f.workspace),/configuration differs|provenance differs/);assert.ok(f.calls.every(args=>args[0]==='inspect'));}
 const owner=fixture(checkpoint);assert.equal(retainedRuntimeImage({...owner.workspace,memberId:'alice'},owner.current,latest),undefined);owner.current.Image='sha256:'+'0'.repeat(64);await assert.rejects(owner.host.ensure(owner.workspace),/provenance differs/);
});
test('cached stopped migrated owner explicitly resumes on fresh published image and subsequent opens/restarted management retain strict scope',async()=>{
 const f=fixture(checkpoint),directory=await mkdtemp(join(tmpdir(),'retained-image-'));f.host.upgradeDirectory=directory;f.current.State.Running=false;let preserved,renamed=false;const fetch=globalThis.fetch;globalThis.fetch=async()=>Response.json([]);
 f.host.docker=async args=>{f.calls.push(args);
  if(args[0]==='pull')return {stdout:''};if(args[0]==='image')return {stdout:JSON.stringify([{Id:newImage,RepoDigests:[latest]}])};
  if(args[0]==='inspect'){if(!f.current)throw Object.assign(Error('missing'),{missingResource:true});return {stdout:JSON.stringify([f.current])};}
  if(args[0]==='rename'){preserved=structuredClone(f.current);f.current=null;renamed=true;}
  if(args[0]==='run'){f.current={...structuredClone(preserved),Id:'1'.repeat(64),Image:newImage,State:{Running:true},Config:{...preserved.Config,Image:args.at(-1),Labels:{'canopy.workspace':'alice','canopy.image-channel':latest}}};}
  return {stdout:''};};
 try{f.host.runtimes.set(f.workspace.id,{runtime:{url:'cached-owner-must-not-return'},fingerprint:JSON.stringify([f.workspace,false]),checkedAt:Date.now()});assert.ok((await f.host.open(f.workspace,{resume:true})).url);assert.equal(f.calls.filter(args=>args[0]==='lookup').length,1);assert.equal(renamed,true);assert.equal(f.current.Config.Image,latest);assert.equal(preserved.Config.Image,checkpoint);assert.equal(preserved.State.Running,false);assert.deepEqual(f.current.Mounts,preserved.Mounts);assert.ok((await f.host.ensure(f.workspace)).url);
  const nextChannel='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'9'.repeat(64),priorCalls=f.calls.length;f.host.image=nextChannel;f.host.releaseChannel=nextChannel;assert.ok((await f.host.ensure(f.workspace)).url);assert.deepEqual(f.calls.slice(priorCalls).map(args=>args[0]),['inspect','inspect']);
 }finally{globalThis.fetch=fetch;await rm(directory,{recursive:true,force:true});}
});
