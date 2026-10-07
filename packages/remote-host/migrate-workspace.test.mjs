import test from 'node:test';import assert from 'node:assert/strict';
import {migrateWorkspace} from './migrate-workspace.mjs';
const image='sha256:'+'a'.repeat(64);
function setup(){
 const config={workspaces:[{id:'owner',accounts:[],memoryMiB:1024,cpus:1,cgroupParent:'canopy-owner.slice'}]};
 const original={Id:'original',Config:{Labels:{'canopy.workspace':'owner'}},State:{Running:false},HostConfig:{RestartPolicy:{Name:'unless-stopped'}}};
 const containers=new Map([['canopy-ws-owner',original]]),calls=[];
 const host={image:'base',runtimes:new Map(),migrationCleanupRequired:new Set(),withResourceLock:action=>action(),verifyCapacity:async()=>{},ensure:async()=>{containers.set('canopy-ws-owner',{Id:'new',Config:original.Config,State:{Running:true}});return {url:'runtime'};},docker:async args=>{
  calls.push(args);
  if(args[0]==='inspect'){if(!containers.has(args[1]))throw Object.assign(Error('missing'),{missingResource:true});return {stdout:JSON.stringify([containers.get(args[1])])};}
  if(args[0]==='commit')return {stdout:image};
  if(args[0]==='image')return {stdout:JSON.stringify([{Id:image,Config:{Labels:{'canopy.owner-checkpoint':'owner'}}}])};
  if(args[0]==='volume'&&args[1]==='inspect')return {stdout:JSON.stringify([{Name:args[2],Driver:'local',Labels:{'canopy.workspace':'owner','canopy.project':'app'}}])};
  if(args[0]==='rename'){assert.ok(!containers.has(args[2]));containers.set(args[2],containers.get(args[1]));containers.delete(args[1]);}
  if(args[0]==='stop')containers.get(args.at(-1)).State.Running=false;
  if(args[0]==='run'&&args.includes('node'))return {stdout:JSON.stringify(JSON.parse(args.at(-2)).map(({id,label,relativePath})=>({id,label,relativePath:relativePath==='.'?'content':'content/'+relativePath})))};
  return {stdout:''};
 }};
 const options={journal:{append:async()=>{}},config,workspaceId:'owner',projects:[{id:'app',name:'App',components:[{id:'app',label:'App',source:'repo',relativePath:'.'}]}],host,verifyRuntime:async()=>{},saveConfig:async()=>{}};
 return {options,containers,calls};
}
test('migration publishes config only after replacement readiness and retains the stopped original',async()=>{
 const {options,containers,calls}=setup();let verified=false;
 options.verifyRuntime=async()=>{verified=true;};options.saveConfig=async c=>{assert.equal(verified,true);assert.equal(c.workspaces[0].ownerImage,image);};
 const result=await migrateWorkspace(options);
 assert.equal(containers.get(result.preservedContainer).Id,'original');assert.equal(containers.get('canopy-ws-owner').Id,'new');
 assert.equal(options.config.workspaces[0].projectMounts[0].components[0].relativePath,'content');assert.ok(!calls.some(c=>c[0]==='rm'));
});
test('failed readiness restores original container name without deleting replacement or publishing config',async()=>{
 const {options,containers,calls}=setup();options.verifyRuntime=async()=>{throw Error('not ready');};options.saveConfig=async()=>assert.fail('must not publish');
 await assert.rejects(migrateWorkspace(options),/not ready/);
 assert.equal(containers.get('canopy-ws-owner').Id,'original');assert.equal(containers.get('canopy-ws-owner').State.Running,false);
 assert.ok([...containers.entries()].some(([name,c])=>name.endsWith('-failed')&&c.Id==='new'&&!c.State.Running));
 assert.equal(options.config.workspaces[0].ownerImage,undefined);assert.ok(!calls.some(c=>c[0]==='rm'));
});

test('rename failure restores the original bounded restart policy without renaming the original away',async()=>{
 const {options,containers,calls}=setup();
 containers.get('canopy-ws-owner').HostConfig.RestartPolicy={Name:'on-failure',MaximumRetryCount:3};
 const docker=options.host.docker;
 options.host.docker=async args=>{if(args[0]==='rename')throw Error('rename refused');return docker(args);};
 await assert.rejects(migrateWorkspace(options),/rename refused/);
 assert.equal(containers.size,1);assert.equal(containers.get('canopy-ws-owner').Id,'original');
 assert.ok(calls.some(c=>c[0]==='update'&&c[2]==='on-failure:3'));
 assert.equal(options.host.migrationCleanupRequired.size,0);
});

test('migration refuses to change containers when durable preparation cannot be recorded',async()=>{
 const {options,calls,containers}=setup();
 options.journal.append=async()=>{throw Error('disk full');};
 await assert.rejects(migrateWorkspace(options),/disk full/);
 assert.equal(containers.size,1);
 assert.ok(!calls.some(c=>['commit','rename','update','run'].includes(c[0])));
});

test('uncertain config publication preserves both containers and quarantines instead of rolling back',async()=>{
 const {options,containers,calls}=setup();let published;
 options.saveConfig=async next=>{published=structuredClone(next);throw Error('directory fsync failed after rename');};
 await assert.rejects(migrateWorkspace(options),/publication could not be confirmed/);
 assert.equal(published.workspaces[0].ownerImage,image);
 assert.equal(containers.get('canopy-ws-owner').Id,'new');
 assert.ok([...containers.entries()].some(([name,c])=>name.startsWith('canopy-preserved-owner-')&&c.Id==='original'&&!c.State.Running));
 assert.equal(options.host.migrationCleanupRequired.has('owner'),true);
 assert.equal(calls.filter(c=>c[0]==='rename').length,1);
 assert.ok(!calls.some(c=>c[0]==='rm'));
});

test('failed rollback journal sync keeps the restored workspace quarantined',async()=>{
 const {options,containers}=setup();
 options.verifyRuntime=async()=>{throw Error('not ready');};
 options.journal.append=async event=>{if(event.phase==='rolled-back')throw Error('disk full');};
 await assert.rejects(migrateWorkspace(options),/require recovery/);
 assert.equal(containers.get('canopy-ws-owner').Id,'original');
 assert.equal(containers.get('canopy-ws-owner').State.Running,false);
 assert.equal(options.host.migrationCleanupRequired.has('owner'),true);
});
