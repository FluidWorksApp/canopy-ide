import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {RuntimeSupervisor} from './runtime-supervisor.mjs';import {DockerWorkspaces} from './docker.mjs';
const workspace={id:'owner',accounts:[],memoryMiB:1024,cpus:1},containerId='a'.repeat(64);
async function fixture(run){
 const directory=await mkdtemp(join(tmpdir(),'canopy-runtime-recovery-'));let now=0,allowed=true,running=true,healthy=false,attempts=0,failRecovery=false;
 const host={runtimes:new Map(),inspectRuntime:async()=>({Id:containerId,State:{Running:running}}),recoverRuntime:async(w,id,{authorize,reserve})=>{assert.equal(id,containerId);if(!running||!await authorize())return false;await reserve();attempts++;if(failRecovery)throw Error('Docker failed');return true;}};
 const options={directory,host,authorize:async()=>allowed,probe:async()=>healthy,now:()=>now,thresholdMs:10,cooldownMs:20};
 const observe=async supervisor=>{await supervisor.observe(workspace,{});now+=10;await supervisor.observe(workspace,{});now+=10;return supervisor.observe(workspace,{});};
 try{await run({directory,host,options,observe,get attempts(){return attempts;},set allowed(v){allowed=v;},set running(v){running=v;},set healthy(v){healthy=v;},set failRecovery(v){failRecovery=v;},advance:ms=>now+=ms});}
 finally{await rm(directory,{recursive:true,force:true});}
}
test('hang recovery reservations survive supervisor restart and exhaust after three attempts',()=>fixture(async f=>{
 for(let i=0;i<3;i++){const supervisor=new RuntimeSupervisor(f.options);assert.equal(await f.observe(supervisor),'recovering');f.advance(20);}
 const restarted=new RuntimeSupervisor(f.options);assert.equal(await f.observe(restarted),'recovery-exhausted');assert.equal(f.attempts,3);
 const state=JSON.parse(await readFile(join(f.directory,'owner.json'),'utf8'));assert.equal(state.attempts,3);
}));
test('intentional exit, revoked access and healthy observations never reserve recovery',()=>fixture(async f=>{
 const supervisor=new RuntimeSupervisor(f.options);f.running=false;assert.equal(await f.observe(supervisor),'stopped');
 f.running=true;f.allowed=false;assert.equal(await f.observe(supervisor),'unauthorized');
 f.allowed=true;f.healthy=true;assert.equal(await f.observe(supervisor),'healthy');assert.equal(f.attempts,0);
}));
test('failed recovery consumes its reservation and corrupted state fails closed',()=>fixture(async f=>{
 f.failRecovery=true;const supervisor=new RuntimeSupervisor(f.options);await assert.rejects(f.observe(supervisor),/Docker failed/);
 assert.equal(JSON.parse(await readFile(join(f.directory,'owner.json'),'utf8')).attempts,1);
 await writeFile(join(f.directory,'owner.json'),'{corrupt');f.advance(20);await assert.rejects(f.observe(supervisor));assert.equal(f.attempts,1);
}));
test('trusted host rechecks stopped, changed or revoked containers before restart',async()=>{
 const calls=[];let running=true,id=containerId,allowed=true,reservations=0;
 const host=new DockerWorkspaces({secret:'test',docker:async args=>{calls.push(args);return {stdout:JSON.stringify([{Id:id,Config:{Labels:{'canopy.workspace':'owner'}},HostConfig:{RestartPolicy:{Name:'on-failure',MaximumRetryCount:3}},State:{Running:running}}])};}});
 const options={authorize:async()=>allowed,reserve:async()=>reservations++};
 running=false;assert.equal(await host.recoverRuntime(workspace,containerId,options),false);
 running=true;id='b'.repeat(64);assert.equal(await host.recoverRuntime(workspace,containerId,options),false);
 id=containerId;allowed=false;assert.equal(await host.recoverRuntime(workspace,containerId,options),false);
 assert.equal(reservations,0);assert.equal(calls.some(args=>['restart','kill'].includes(args[0])),false);
});
test('host restart reserves before mutation and refreshes endpoint without replacing container or volumes',async()=>{
 const calls=[],runtime={url:'http://127.0.0.1:45000',token:'runtime'};
 const host=new DockerWorkspaces({secret:'test',docker:async args=>{calls.push(args[0]);return {stdout:JSON.stringify([{Id:containerId,Config:{Labels:{'canopy.workspace':'owner'}},HostConfig:{RestartPolicy:{Name:'on-failure',MaximumRetryCount:3}},State:{Running:true}}])};}});
 host.ensure=async w=>{assert.equal(w,workspace);calls.push('refresh');return runtime;};
 assert.equal(await host.recoverRuntime(workspace,containerId,{authorize:async()=>true,reserve:async()=>calls.push('reserve')}),true);
  assert.deepEqual(calls,['inspect','reserve','kill','inspect','refresh']);assert.deepEqual(host.runtimes.get('owner').runtime,runtime);
 assert.equal(calls.some(value=>['run','rm','volume','start'].includes(value)),false);
 host.migrationCleanupRequired.add('owner');await assert.rejects(host.recoverRuntime(workspace,containerId,{authorize:async()=>true,reserve:async()=>assert.fail('Must not reserve during migration')}),/migration requires recovery/);
});
