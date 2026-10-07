import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {removeStaleWorkspaceImages,ensurePullSpace,requiredPullBytes,pendingImageUpgrades,containerdFreeBytes,WorkspaceDiskFullError,WORKSPACE_IMAGE_FALLBACK_BYTES,PREPULL_RESERVE_BYTES} from './image-retention.mjs';
import {pullWorkspaceImage} from './image-release.mjs';
import {startReleasePrepull} from './release-prepull.mjs';
import {DockerWorkspaces} from './docker.mjs';

const GB=1e9,GiB=1024**3;
const repo='ghcr.io/fluidworksapp/canopy-workspace';
const hex=(c,n=64)=>c.repeat(n);
const ref=c=>`${repo}@sha256:${hex(c)}`;
const imageId=c=>'sha256:'+hex(c);

// A small Docker engine model: containers, images (by reference), volumes.
// It enforces Docker's own refusals (running container rm, in-use image rm),
// records every call, and counts free space so preflight decisions are real.
function fakeDocker({free=40*GB,manifest,pullSize=16.5*GB,pullError}={}){
 const s={calls:[],containers:new Map(),images:new Map(),volumes:new Set(['canopy-home-alice','canopy-project-alice','canopy-account-owner']),free};
 const findImage=reference=>[...s.images.entries()].find(([id,image])=>id===reference||image.refs.some(r=>r.ref===reference));
 const findContainer=key=>[...s.containers.values()].find(c=>c.Name==='/'+key||c.Id===key);
 const missing=()=>Object.assign(Error('missing'),{missingResource:true});
 s.addImage=(id,refs,size=12.8*GB)=>{s.images.set(id,{refs:refs.map(r=>({ref:r,...(r.includes('@')?{Repository:r.split('@')[0],Tag:'<none>',Digest:r.split('@')[1]}:{Repository:r.slice(0,r.lastIndexOf(':')),Tag:r.slice(r.lastIndexOf(':')+1),Digest:'<none>'})})),size});s.free-=size;};
 s.addContainer=(name,image,{running=false,workspace,id}={})=>{const c={Id:id??Buffer.from(name).toString('hex').padEnd(64,'0').slice(0,64),Name:'/'+name,Image:image,State:{Running:running},Config:{Labels:workspace?{'canopy.workspace':workspace}:{}}};s.containers.set(name,c);return c;};
 s.docker=async args=>{
  s.calls.push(args);
  const [cmd,sub]=args;
  if(cmd==='ps')return {stdout:[...s.containers.values()].map(c=>c.Id).join('\n')};
  if(cmd==='inspect'){const found=args.slice(1).map(findContainer).filter(Boolean);if(!found.length)throw missing();return {stdout:JSON.stringify(found)};}
  if(cmd==='rm'){const c=findContainer(args.at(-1));if(!c)throw missing();if(c.State.Running)throw Error('container is running');s.containers.delete(c.Name.slice(1));return {stdout:''};}
  if(cmd==='rename'){const c=findContainer(args[1]);s.containers.delete(c.Name.slice(1));c.Name='/'+args[2];s.containers.set(args[2],c);return {stdout:''};}
  if(cmd==='manifest'){if(!manifest)throw Error('registry unavailable');return {stdout:JSON.stringify(manifest)};}
  if(cmd==='pull'){if(pullError)throw pullError;if(s.free<pullSize)throw Object.assign(Error('pull failed'),{noSpace:true});s.addImage(imageId('9'),[args.at(-1)],pullSize);return {stdout:args.at(-1)};}
  if(cmd==='image'&&sub==='inspect'){const found=findImage(args[2]);if(!found)throw missing();return {stdout:JSON.stringify([{Id:found[0],RepoDigests:found[1].refs.filter(r=>r.ref.includes('@')).map(r=>r.ref)}])};}
  if(cmd==='image'&&sub==='ls')return {stdout:[...s.images.entries()].flatMap(([id,image])=>image.refs.map(r=>JSON.stringify({ID:id,Repository:r.Repository,Tag:r.Tag,Digest:r.Digest}))).join('\n')};
  if(cmd==='image'&&sub==='rm'){
   const found=findImage(args[2]);if(!found)throw missing();const [id,image]=found;
   if(image.refs.length===1&&[...s.containers.values()].some(c=>c.Image===id))throw Error('conflict: image is being used by a container');
   image.refs=image.refs.filter(r=>r.ref!==args[2]);if(!image.refs.length){s.images.delete(id);s.free+=image.size;}return {stdout:''};
  }
  if(cmd==='image'&&sub==='prune'){for(const [id,image] of s.images)if(!image.refs.length&&![...s.containers.values()].some(c=>c.Image===id)){s.images.delete(id);s.free+=image.size;}return {stdout:''};}
  return {stdout:''};
 };
 s.freeBytes=async()=>s.free;
 return s;
}
// Volumes hold user home and projects: no call may name or prune them.
function assertNoVolumeOrForce(calls){
 for(const args of calls){
  assert.ok(!args.includes('volume')&&!args.includes('system')&&!args.includes('--volumes')&&!args.includes('-v'),`unsafe call: ${args.join(' ')}`);
  if(args[0]==='rm'||(args[0]==='image'&&args[1]==='rm'))assert.ok(!args.includes('--force')&&!args.includes('-f'),`forced removal: ${args.join(' ')}`);
  if(args[0]==='image'&&args[1]==='prune')assert.ok(!args.includes('--all')&&!args.includes('-a'),'prune must stay dangling-only');
 }
}

test('keeps the running image and removes every other canopy-workspace image, local or registry',async()=>{
 const d=fakeDocker();
 d.addImage(imageId('1'),[ref('1')]);d.addImage(imageId('2'),[ref('2')]);d.addImage(imageId('3'),[ref('3')]);
 d.addImage(imageId('4'),['canopy-workspace:0.1.0']);d.addImage(imageId('5'),['ghcr.io/other/tool:1','docker.io/library/caddy:2']);
 d.addImage(imageId('6'),[]);// dangling content from a failed pull
 d.addContainer('canopy-ws-alice',imageId('3'),{running:true,workspace:'alice'});
 const removed=await removeStaleWorkspaceImages({docker:d.docker});
 assert.deepEqual([...d.images.keys()].sort(),[imageId('3'),imageId('5')]);
 assert.deepEqual(removed.images.sort(),[imageId('1'),imageId('2'),imageId('4')]);
 assert.deepEqual([...d.volumes].sort(),['canopy-account-owner','canopy-home-alice','canopy-project-alice']);
 assertNoVolumeOrForce(d.calls);
});
test('a stopped workspace, any other container and explicit keep references retain their images',async()=>{
 const d=fakeDocker();
 for(const c of ['1','2','3','4'])d.addImage(imageId(c),[ref(c)]);
 d.addContainer('canopy-ws-alice',imageId('1'),{running:false,workspace:'alice'});
 d.addContainer('canopy-migrate-x',imageId('2'));
 await removeStaleWorkspaceImages({docker:d.docker,keep:[ref('3'),ref('8'),undefined]});
 assert.deepEqual([...d.images.keys()].sort(),[imageId('1'),imageId('2'),imageId('3')]);
 assert.ok(d.containers.has('canopy-ws-alice')&&d.containers.has('canopy-migrate-x'));
 assertNoVolumeOrForce(d.calls);
});
test('settled rollback containers are removed with their images; unfinished, running or orphaned ones are kept',async()=>{
 const settled=()=>{const d=fakeDocker();for(const c of ['1','2','3','4'])d.addImage(imageId(c),[ref(c)]);
  d.addContainer('canopy-ws-ws-1',imageId('4'),{running:true,workspace:'ws-1'});
  d.addContainer('canopy-previous-ws-1-'+hex('a',12),imageId('1'),{workspace:'ws-1'});
  d.addContainer('canopy-previous-ws-1-'+hex('b',12)+'-failed',imageId('2'),{workspace:'ws-1'});
  d.addContainer('canopy-previous-ws-1-'+hex('c',12)+'-recovery-'+hex('d',12),imageId('3'),{workspace:'ws-1'});return d;};
 const d=settled();await removeStaleWorkspaceImages({docker:d.docker,protectWorkspaces:new Set()});
 assert.deepEqual([...d.containers.keys()],['canopy-ws-ws-1']);assert.deepEqual([...d.images.keys()],[imageId('4')]);assertNoVolumeOrForce(d.calls);
 // An upgrade journal still in progress (or unreadable) keeps the rollback.
 for(const protectWorkspaces of [new Set(['ws-1']),null]){const p=settled();await removeStaleWorkspaceImages({docker:p.docker,protectWorkspaces});assert.equal(p.containers.size,4);assert.equal(p.images.size,4);}
 // Never the only copy: without the canonical workspace, the previous container stays.
 const orphan=fakeDocker();orphan.addImage(imageId('1'),[ref('1')]);orphan.addContainer('canopy-previous-ws-1-'+hex('a',12),imageId('1'),{workspace:'ws-1'});
 await removeStaleWorkspaceImages({docker:orphan.docker});assert.equal(orphan.containers.size,1);assert.equal(orphan.images.size,1);
 // Running, mislabelled or foreign-named containers are never removed.
 const other=fakeDocker();other.addImage(imageId('1'),[ref('1')]);other.addContainer('canopy-ws-ws-1',imageId('1'),{workspace:'ws-1'});
 other.addContainer('canopy-previous-ws-1-'+hex('a',12),imageId('1'),{workspace:'ws-1',running:true});
 other.addContainer('canopy-previous-ws-1-'+hex('b',12),imageId('1'),{workspace:'ws-2'});
 other.addContainer('canopy-previous-ws-1-notahash',imageId('1'),{workspace:'ws-1'});
 await removeStaleWorkspaceImages({docker:other.docker});assert.equal(other.containers.size,4);
});
test('pending upgrade journals protect their workspace; unreadable journals protect all',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'retention-journal-'));
 try{
  assert.deepEqual(await pendingImageUpgrades(join(dir,'missing')),new Set());
  await writeFile(join(dir,'ws-1.json'),JSON.stringify({version:1,workspaceId:'ws-1',phase:'committed'}));
  await writeFile(join(dir,'ws-2.json'),JSON.stringify({version:1,workspaceId:'ws-2',phase:'replacing'}));
  assert.deepEqual(await pendingImageUpgrades(dir),new Set(['ws-2']));
  await writeFile(join(dir,'ws-3.json'),'{not json');assert.equal(await pendingImageUpgrades(dir),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const manifest={SchemaV2Manifest:{config:{size:20000},layers:[{size:2*GB},{size:1.68*GB}]}};
test('pull size comes from the manifest when available, else a conservative 16 GiB',async()=>{
 const estimate=await requiredPullBytes(ref('9'),{docker:fakeDocker({manifest}).docker});
 assert.equal(estimate.source,'manifest');assert.equal(estimate.bytes,Math.ceil((3.68*GB+20000)*4.5)+GiB);
 const list=[{Descriptor:{platform:{os:'linux',architecture:'arm64'}},OCIManifest:{layers:[{size:1}]}},{Descriptor:{platform:{os:'linux',architecture:'amd64'}},OCIManifest:{layers:[{size:GB}]}}];
 assert.equal((await requiredPullBytes(ref('9'),{docker:fakeDocker({manifest:list}).docker,arch:'x64'})).bytes,Math.ceil(GB*4.5)+GiB);
 for(const bad of [undefined,{SchemaV2Manifest:{layers:[]}},{SchemaV2Manifest:{layers:[{size:-1}]}}])assert.deepEqual(await requiredPullBytes(ref('9'),{docker:fakeDocker({manifest:bad}).docker}),{bytes:WORKSPACE_IMAGE_FALLBACK_BYTES,source:'fallback'});
});
test('space preflight cleans before failing and reports the exact disk-full message',async()=>{
 // Enough space: no cleanup.
 let cleaned=0;assert.equal((await ensurePullSpace(ref('9'),{docker:fakeDocker().docker,freeBytes:async()=>40*GB,cleanup:async()=>{cleaned++;}})).checked,true);assert.equal(cleaned,0);
 // Short, but cleanup frees enough.
 let free=5*GB;const result=await ensurePullSpace(ref('9'),{docker:fakeDocker().docker,freeBytes:async()=>free,cleanup:async()=>{cleaned++;free=30*GB;}});assert.equal(cleaned,1);assert.equal(result.cleaned,true);
 // Still short after cleanup.
 await assert.rejects(ensurePullSpace(ref('9'),{docker:fakeDocker().docker,freeBytes:async()=>3.24*GB,cleanup:async()=>{}}),error=>error instanceof WorkspaceDiskFullError&&error.message==='Workspace disk is full: 3.2 GB free, 17.2 GB needed'&&error.code==='WORKSPACE_DISK_FULL'&&error.reason==='disk-full');
 await assert.rejects(ensurePullSpace(ref('9'),{docker:fakeDocker({manifest}).docker,freeBytes:async()=>10*GB}),{message:'Workspace disk is full: 10.0 GB free, 17.6 GB needed'});
 // A reserve (background pre-pull) raises the bar.
 await assert.rejects(ensurePullSpace(ref('9'),{docker:fakeDocker().docker,freeBytes:async()=>18*GB,reserveBytes:PREPULL_RESERVE_BYTES}),/18\.0 GB free, 21\.5 GB needed/);
 // Unknown free space never blocks.
 assert.deepEqual(await ensurePullSpace(ref('9'),{docker:fakeDocker().docker,freeBytes:async()=>null}),{checked:false});
 assert.equal(await containerdFreeBytes({roots:['/missing'],statfs:async()=>{throw Error('ENOENT');}}),null);
 assert.equal(await containerdFreeBytes({roots:['/a','/b'],statfs:async root=>{if(root==='/a')throw Error('ENOENT');return {bavail:10,bsize:4096};}}),40960);
});
test('the incident: a full retained disk is cleaned before the pull instead of failing mid-extract',async()=>{
 const d=fakeDocker({free:50*GB});
 for(const c of ['1','2','3','4'])d.addImage(imageId(c),[ref(c)]);// 51.2 GB of releases
 d.addContainer('canopy-ws-ws-1',imageId('4'),{workspace:'ws-1'});
 for(const c of ['a','b','c'])d.addContainer('canopy-previous-ws-1-'+hex(c,12),imageId({a:'1',b:'2',c:'3'}[c]),{workspace:'ws-1'});
 assert.ok(d.free<0.1*GB);
 const cleanup=()=>removeStaleWorkspaceImages({docker:d.docker,keep:[ref('9')],protectWorkspaces:new Set()});
 const release=await pullWorkspaceImage(ref('9'),{docker:d.docker,space:{freeBytes:d.freeBytes,cleanup}});
 assert.equal(release.reference,ref('9'));assert.deepEqual([...d.containers.keys()],['canopy-ws-ws-1']);
 assert.deepEqual([...d.images.keys()].sort(),[imageId('4'),imageId('9')]);
 const pull=d.calls.findIndex(args=>args[0]==='pull'),firstRemoval=d.calls.findIndex(args=>args[0]==='rm');assert.ok(firstRemoval>=0&&firstRemoval<pull);
 assertNoVolumeOrForce(d.calls);
 // When nothing can be freed the error is specific, and no pull is attempted.
 const full=fakeDocker({free:4*GB});full.addContainer('canopy-ws-ws-1',imageId('4'),{workspace:'ws-1'});
 await assert.rejects(pullWorkspaceImage(ref('9'),{docker:full.docker,space:{freeBytes:full.freeBytes,cleanup:()=>removeStaleWorkspaceImages({docker:full.docker})}}),{message:'Workspace disk is full: 4.0 GB free, 17.2 GB needed'});
 assert.ok(!full.calls.some(args=>args[0]==='pull'));
});
test('a mid-pull ENOSPC is reported as disk full, other pull failures are unchanged',async()=>{
 const d=fakeDocker({pullError:Object.assign(Error('Docker workspace pull failed'),{noSpace:true})});let cleaned=0;
 await assert.rejects(pullWorkspaceImage(ref('9'),{docker:d.docker,space:{freeBytes:async()=>20*GB,cleanup:async()=>{cleaned++;}}}),error=>error instanceof WorkspaceDiskFullError&&/^Workspace disk is full: 20\.0 GB free, 17\.2 GB needed$/.test(error.message));
 assert.equal(cleaned,1);
 const cli=fakeDocker({pullError:Object.assign(Error('exit 1'),{stderr:'failed to extract layer sha256:abc: write /srv/canopy/containerd/x: no space left on device'})});
 await assert.rejects(pullWorkspaceImage(ref('9'),{docker:cli.docker,space:{freeBytes:async()=>0.5*GB}}),/Workspace disk is full: 0\.5 GB free/);
 const other=fakeDocker({pullError:Error('registry unavailable')});
 await assert.rejects(pullWorkspaceImage(ref('9'),{docker:other.docker,space:{freeBytes:async()=>40*GB}}),/registry unavailable/);
 // Without the space option (local hosts) pulls behave exactly as before.
 const plain=fakeDocker();await pullWorkspaceImage(ref('9'),{docker:plain.docker});assert.ok(!plain.calls.some(args=>args[0]==='manifest'));
});

const timers={setTimeout:()=>null,setInterval:()=>null,clearTimeout(){},clearInterval(){}};
test('pre-pull obeys the space check with a reserve and never starts a pull that would fill the disk',async()=>{
 const d=fakeDocker({free:19*GB});d.addContainer('canopy-ws-ws-1',imageId('4'),{running:true,workspace:'ws-1'});d.addImage(imageId('4'),[ref('4')]);d.free=19*GB;
 const results=[],targets=[];
 const prepull=startReleasePrepull({workspace:{id:'ws-1'},release:async()=>ref('9'),docker:d.docker,timers,target:r=>targets.push(r),
  space:()=>({freeBytes:d.freeBytes,reserveBytes:PREPULL_RESERVE_BYTES,cleanup:()=>removeStaleWorkspaceImages({docker:d.docker,keep:[ref('9')]})}),onResult:r=>results.push(r)});
 assert.equal(await prepull.tick(),null);
 assert.deepEqual(results,[{ok:false,error:'Workspace disk is full: 19.0 GB free, 21.5 GB needed',code:'WORKSPACE_DISK_FULL'}]);
 assert.ok(!d.calls.some(args=>args[0]==='pull'));assert.ok(d.images.has(imageId('4')),'the running image is never removed');
 assertNoVolumeOrForce(d.calls);
});
test('pre-pull leaves only images containers use plus the one pre-pulled target',async()=>{
 const d=fakeDocker({free:200*GB});for(const c of ['1','2','4'])d.addImage(imageId(c),[ref(c)]);
 d.addContainer('canopy-ws-ws-1',imageId('4'),{running:true,workspace:'ws-1'});
 let target;const retained=[];
 const prepull=startReleasePrepull({workspace:{id:'ws-1'},release:async()=>ref('9'),docker:d.docker,timers,target:r=>{target=r;},
  space:()=>({freeBytes:d.freeBytes,reserveBytes:PREPULL_RESERVE_BYTES}),
  retain:async result=>{retained.push(result.reference);await removeStaleWorkspaceImages({docker:d.docker,keep:[target]});}});
 assert.equal((await prepull.tick()).reference,ref('9'));assert.equal(target,ref('9'));assert.deepEqual(retained,[ref('9')]);
 assert.deepEqual([...d.images.keys()].sort(),[imageId('4'),imageId('9')]);
 // A cleanup failure is reported but the pre-pulled image stays usable.
 const results=[];const failing=startReleasePrepull({workspace:{id:'ws-1'},release:async()=>ref('9'),docker:d.docker,timers,retain:async()=>{throw Error('lock busy');},onResult:r=>results.push(r)});
 assert.equal((await failing.tick()).reference,ref('9'));assert.deepEqual(results,[{ok:false,error:'Workspace image cleanup skipped: lock busy'},{ok:true,reference:ref('9')}]);
 assertNoVolumeOrForce(d.calls);
});

// Full resume through DockerWorkspaces: the previous container and image survive
// until the replacement passes readiness, then both are removed.
function workspaceFixture(){
 const d=fakeDocker({free:30*GB});
 const workspace={id:'alice',accounts:[],memoryMiB:2048,cpus:2};
 d.addImage(imageId('1'),[ref('1')]);d.addImage(imageId('2'),[ref('2')]);d.addImage(imageId('3'),['canopy-workspace:0.1.0']);
 d.addContainer('canopy-previous-alice-'+hex('e',12),imageId('2'),{workspace:'alice'});
 const host=new DockerWorkspaces({secret:'synthetic',image:ref('9'),releaseChannel:ref('9'),resolveRelease:async()=>ref('9'),docker:d.docker,retainImages:true,freeBytes:d.freeBytes,log:()=>{}});
 const c=d.addContainer('canopy-ws-alice',imageId('1'),{workspace:'alice',id:hex('e')});
 Object.assign(c,{Config:{Labels:{'canopy.workspace':'alice','canopy.image-channel':ref('1')},Image:ref('1'),User:'1000:1000',Env:[`CANOPY_RUNNER_TOKEN=${host.token('alice')}`,'CANOPY_ACCOUNTS=']},HostConfig:{Memory:2048*1048576,MemorySwap:3584*1048576,NanoCpus:2e9,RestartPolicy:{Name:'on-failure',MaximumRetryCount:3},PidsLimit:1024,CapDrop:['ALL'],CapAdd:[],NetworkMode:'canopy-net-alice',SecurityOpt:['no-new-privileges:true']},Mounts:[{Type:'volume',Destination:'/workspace',Name:'canopy-project-alice',RW:true},{Type:'volume',Destination:'/home/agent',Name:'canopy-home-alice',RW:true}],State:{Running:false},NetworkSettings:{Networks:{'canopy-net-alice':{IPAddress:'172.18.0.2'}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'45000'}]}}});
 const docker=d.docker;
 d.docker=async args=>{
  if(args[0]==='run'){d.calls.push(args);const name=args[args.indexOf('--name')+1];const fresh=structuredClone(d.containers.get([...d.containers.keys()].find(n=>n.startsWith('canopy-previous-alice-')&&d.containers.get(n).Id===hex('e'))));Object.assign(fresh,{Id:hex('f'),Name:'/'+name,Image:imageId('9'),State:{Running:true}});fresh.Config.Image=args.at(-1);d.containers.set(name,fresh);return {stdout:''};}
  return docker(args);
 };
 host.docker=d.docker;
 return {d,host,workspace};
}
test('resume keeps the previous container and image through the rollback window, then removes them',async()=>{
 const {d,host,workspace}=workspaceFixture();const dir=await mkdtemp(join(tmpdir(),'retention-upgrade-'));host.upgradeDirectory=dir;
 const fetch=globalThis.fetch;let duringReadiness;
 globalThis.fetch=async()=>{duringReadiness??={containers:[...d.containers.keys()].sort(),images:[...d.images.keys()].sort()};return Response.json([]);};
 try{
  assert.ok((await host.open(workspace,{resume:true})).url);
  // While the new container was being health-checked, rollback material existed.
  assert.ok(duringReadiness.containers.some(n=>/^canopy-previous-alice-[a-f0-9]{12}$/.test(n)&&d.calls.some(a=>a[0]==='rename'&&a[2]===n)));
  assert.ok(duringReadiness.images.includes(imageId('1')));
  // After readiness: only the new workspace container and its image remain.
  assert.deepEqual([...d.containers.keys()],['canopy-ws-alice']);assert.equal(d.containers.get('canopy-ws-alice').Image,imageId('9'));
  assert.deepEqual([...d.images.keys()],[imageId('9')]);
  assert.equal(d.volumes.size,3);assertNoVolumeOrForce(d.calls);
 }finally{globalThis.fetch=fetch;await rm(dir,{recursive:true,force:true});}
});
test('a failed replacement rolls back with the original image intact',async()=>{
 const {d,host,workspace}=workspaceFixture();const dir=await mkdtemp(join(tmpdir(),'retention-upgrade-'));host.upgradeDirectory=dir;
 const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('not ready');};
 const realNow=performance.now.bind(performance);let offset=0;performance.now=()=>realNow()+(offset+=10000);
 try{
  await assert.rejects(host.open(workspace,{resume:true}),/failed readiness/);
  assert.equal(d.containers.get('canopy-ws-alice').Id,hex('e'));assert.ok(d.images.has(imageId('1')),'original image retained for the restored container');
  assertNoVolumeOrForce(d.calls);
 }finally{globalThis.fetch=fetch;performance.now=realNow;await rm(dir,{recursive:true,force:true});}
});
test('resume on a full disk fails with the disk-full message before pulling, keeping the stopped workspace',async()=>{
 const {d,host,workspace}=workspaceFixture();d.free=2*GB;d.images.get(imageId('2')).size=GB;d.images.get(imageId('3')).size=GB;// cleanup frees 2 GB: still short
 await assert.rejects(host.open(workspace,{resume:true}),{message:'Workspace disk is full: 4.0 GB free, 17.2 GB needed'});
 assert.ok(!d.containers.has('canopy-previous-alice-'+hex('e',12)));
 assert.ok(!d.calls.some(args=>args[0]==='pull'));assert.ok(d.containers.has('canopy-ws-alice'));assert.ok(d.images.has(imageId('1')));
 assertNoVolumeOrForce(d.calls);
});
test('hosts without retention (local images) never run cleanup or the preflight',async()=>{
 const d=fakeDocker();d.addImage(imageId('3'),['canopy-workspace:0.1.0']);
 const host=new DockerWorkspaces({secret:'synthetic',docker:d.docker});
 assert.equal(await host.cleanupWorkspaceImages(),null);assert.equal(host.pullSpace(ref('9')),undefined);assert.ok(d.images.has(imageId('3')));
});
test('host bootstrap CLI exits 28 with coded numbers when the pull runs out of space',async()=>{
 const {spawnSync}=await import('node:child_process');const {chmod,readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'retention-cli-'));
 try{
  await mkdir(join(dir,'bin'));await mkdir(join(dir,'containerd'));
  await writeFile(join(dir,'bin','docker'),`#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1 $2" in
 "image inspect") echo "Error response from daemon: No such image: $3" >&2; exit 1;;
 "pull --quiet") echo "failed to extract layer sha256:abc: write /srv/canopy/containerd/x: no space left on device" >&2; exit 1;;
 "manifest inspect") exit 1;;
esac
exit 0
`);await chmod(join(dir,'bin','docker'),0o755);
  const run=spawnSync(process.execPath,[new URL('./image-release.mjs',import.meta.url).pathname,ref('9')],{encoding:'utf8',env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,CANOPY_CONTAINERD_ROOT:join(dir,'containerd'),CANOPY_IMAGE_UPGRADES:join(dir,'none'),CANOPY_IMAGE_FAILURE_FILE:join(dir,'failure')}});
  assert.equal(run.status,28,run.stderr);assert.match(run.stderr,/Workspace disk is full: [0-9]+\.[0-9] GB free, 17\.2 GB needed/);assert.equal(run.stdout,'');
  assert.match(await readFile(join(dir,'failure'),'utf8'),/^disk-full [0-9]+\.[0-9] 17\.2\n$/);
  const calls=await readFile(join(dir,'calls'),'utf8');assert.doesNotMatch(calls,/volume|system|--all --force|-a /);
 }finally{await rm(dir,{recursive:true,force:true});}
});
