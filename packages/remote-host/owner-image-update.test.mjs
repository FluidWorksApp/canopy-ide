import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DockerWorkspaces} from './docker.mjs';
// Update workspace, step (b): DockerWorkspaces.updateOwnerImage and the
// owner container report sent on runtime-policy calls.
const old='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'a'.repeat(64),latest='ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'b'.repeat(64),oldImage='sha256:'+'f'.repeat(64),newImage='sha256:'+'d'.repeat(64);
const member='member-'+'1'.repeat(40);
async function fixture({launch=true}={}){
 const calls=[],workspace={id:'alice',accounts:[],memoryMiB:2048,cpus:2},directory=await mkdtemp(join(tmpdir(),'owner-image-'));
 const containers=new Map();let preserved;
 const host=new DockerWorkspaces({secret:'synthetic',image:old,releaseChannel:old,upgradeDirectory:directory,resolveRelease:async()=>{calls.push(['lookup']);return old;},docker:async args=>{
  calls.push(args);const [command]=args,name=args.at(-1);
  if(command==='image')return {stdout:JSON.stringify([args[2]===oldImage?{Id:oldImage,RepoDigests:[old]}:{Id:newImage,RepoDigests:[latest]}])};
  if(command==='pull')return {stdout:''};
  if(command==='ps')return {stdout:containers.get('canopy-ws-'+member)?.State.Running?`canopy-ws-${member}\n`:''};
  if(command==='inspect'){const found=containers.get(name);if(!found)throw Object.assign(Error('missing'),{missingResource:true});return {stdout:JSON.stringify([found])};}
  if(command==='stop')containers.get(name).State.Running=false;
  if(command==='start')containers.get(name).State.Running=true;
  if(command==='rename'){const [from,to]=args.slice(1);containers.set(to,containers.get(from));containers.delete(from);if(from==='canopy-ws-alice'&&to.startsWith('canopy-previous-'))preserved=containers.get(to);}
  if(command==='run'){if(!launch)throw Error('new image would not start');containers.set('canopy-ws-alice',{...structuredClone(preserved),Id:'1'.repeat(64),Image:newImage,State:{Running:true},Config:{...preserved.Config,Image:args.at(-1),Labels:{'canopy.workspace':'alice','canopy.image-channel':old}}});}
  return {stdout:''};}});
 containers.set('canopy-ws-alice',{Id:'e'.repeat(64),Image:oldImage,Config:{Labels:{'canopy.workspace':'alice','canopy.image-channel':old},Image:old,User:'1000:1000',Env:[`CANOPY_RUNNER_TOKEN=${host.token('alice')}`,'CANOPY_ACCOUNTS=']},HostConfig:{Memory:2147483648,MemorySwap:3758096384,NanoCpus:2e9,RestartPolicy:{Name:'on-failure',MaximumRetryCount:3},PidsLimit:1024,CapDrop:['ALL'],CapAdd:[],NetworkMode:'canopy-net-alice',SecurityOpt:['no-new-privileges:true']},Mounts:[{Type:'volume',Destination:'/workspace',Name:'canopy-project-alice',RW:true},{Type:'volume',Destination:'/home/agent',Name:'canopy-home-alice',RW:true}],State:{Running:true},NetworkSettings:{Networks:{'canopy-net-alice':{IPAddress:'172.18.0.2'}},Ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:'45000'}]}}});
 containers.set('canopy-ws-'+member,{Id:'2'.repeat(64),Config:{Labels:{'canopy.workspace':member}},State:{Running:true}});
 const fetch=globalThis.fetch;globalThis.fetch=async()=>Response.json([]);
 return {host,workspace,calls,containers,cleanup:async()=>{globalThis.fetch=fetch;await rm(directory,{recursive:true,force:true});}};
}
const owner=f=>f.containers.get('canopy-ws-alice');
test('the owner container moves onto the release image; members stop and the previous container is kept',async()=>{
 const f=await fixture();
 try{
  assert.deepEqual(await f.host.updateOwnerImage(f.workspace,latest),{code:'updated'});
  assert.equal(owner(f).Image,newImage);assert.equal(owner(f).Config.Image,latest);assert.equal(owner(f).State.Running,true);
  assert.ok([...f.containers.keys()].some(name=>name.startsWith('canopy-previous-alice-')),'rollback keeps the old container');
  assert.equal(f.containers.get('canopy-ws-'+member).State.Running,false,'members come back on their next open');
  assert.equal(f.calls.some(args=>args[0]==='lookup'),false,'the release named by the update is used, not a fresh lookup');
  const order=f.calls.map(args=>args.join(' '));
  assert.ok(order.indexOf(`stop --time 5 canopy-ws-${member}`)<order.indexOf('stop --time 30 canopy-ws-alice'));
  assert.ok(order.indexOf('stop --time 30 canopy-ws-alice')<order.findIndex(line=>line.startsWith('run ')));
  assert.equal(f.calls.some(args=>args[0]==='rm'||args.includes('--volumes')),false,'no container or volume is deleted');
  assert.ok(f.host.runtimes.get('alice')?.runtime.url);
  f.calls.length=0;
  assert.deepEqual(await f.host.updateOwnerImage(f.workspace,latest),{code:'current'});
  assert.equal(f.calls.some(args=>['stop','run','rename'].includes(args[0])),false);
 }finally{await f.cleanup();}
});
test('a new image that does not start rolls back to the previous container, running again',async()=>{
 const f=await fixture({launch:false});
 try{
  const result=await f.host.updateOwnerImage(f.workspace,latest);
  assert.equal(result.code,'rolled-back');assert.match(result.detail,/would not start/);
  assert.equal(owner(f).Id,'e'.repeat(64));assert.equal(owner(f).Image,oldImage);assert.equal(owner(f).State.Running,true);
  assert.ok(f.calls.some(args=>args.join(' ')==='update --restart on-failure:3 canopy-ws-alice'));
  assert.equal(f.host.migrationCleanupRequired.has('alice'),false);
 }finally{await f.cleanup();}
});
test('no container, a moving tag or a host without a release channel never stops anything',async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.host.updateOwnerImage(f.workspace,old.replace(/@.*/,':stable'))).code,'failed');
  f.host.releaseChannel=undefined;assert.equal((await f.host.updateOwnerImage(f.workspace,latest)).code,'failed');f.host.releaseChannel=old;
  f.containers.delete('canopy-ws-alice');assert.equal((await f.host.updateOwnerImage(f.workspace,latest)).code,'current');
  assert.equal(f.calls.some(args=>args[0]==='stop'),false);
 }finally{await f.cleanup();}
});
test('the owner report names the running image digest and the protocol its runner answers',async()=>{
 const f=await fixture();
 try{
  const asked=[];
  const fetchImpl=async(url,options)=>{asked.push([url,options.headers.authorization,JSON.parse(options.body)]);return Response.json({result:{protocol:5,commands:[]}});};
  assert.deepEqual(await f.host.ownerRuntimeReport(f.workspace,{fetchImpl}),{image:old,protocol:5});
  assert.deepEqual(asked,[['http://172.18.0.2:8081/native',`Bearer ${f.host.token('alice')}`,{command:'host_capabilities',args:{}}]]);
  await f.host.ownerRuntimeReport(f.workspace,{fetchImpl});assert.equal(asked.length,1,'cached while the same container runs');
  f.host.ownerReport=undefined;
  assert.deepEqual(await f.host.ownerRuntimeReport(f.workspace,{fetchImpl:async()=>Response.json({error:'The Linux workspace does not support host_capabilities yet'},{status:400})}),{image:old,protocol:0},'a runner older than host_capabilities is older than every protocol');
  f.host.ownerReport=undefined;
  assert.deepEqual(await f.host.ownerRuntimeReport(f.workspace,{fetchImpl:async()=>{throw Error('unreachable');}}),{image:old,protocol:null});
  owner(f).State.Running=false;assert.deepEqual(await f.host.ownerRuntimeReport(f.workspace,{fetchImpl}),{image:null,protocol:null});
 }finally{await f.cleanup();}
});
