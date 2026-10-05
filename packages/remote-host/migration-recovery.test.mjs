import test from 'node:test';import assert from 'node:assert/strict';
import {assessMigrationRecovery,rollbackMigration} from './migration-recovery.mjs';
const original={Id:'original',Config:{Labels:{'canopy.workspace':'owner'}},State:{Running:false}};
const replacement={...original,Id:'replacement',State:{Running:true}};
const next={id:'owner',ownerImage:'checkpoint',projectMounts:[{id:'app'}]};
const records=[{workspaceId:'owner',sequence:1,phase:'prepared',originalWorkspace:{id:'owner'},originalContainerId:'original',preservedContainer:'canopy-preserved-owner-abc',restorePolicy:'no',next}];
function options(published=false){const calls=[];return {calls,records,config:{workspaces:[published?next:{id:'owner'}]},docker:async args=>{calls.push(args);return {stdout:JSON.stringify([args[1]==='canopy-ws-owner'?replacement:original])};}};}
test('interrupted unpublished replacement needs rollback but assessment never mutates Docker',async()=>{const o=options();assert.equal((await assessMigrationRecovery(o)).state,'rollback-needed');assert.ok(o.calls.every(c=>c[0]==='inspect'));});
test('config published before final journal sync is recognized and not rolled back',async()=>{assert.equal((await assessMigrationRecovery(options(true))).state,'published');});
test('forged ownership, missing original and conflicting committed config fail closed',async()=>{
 const o=options();o.docker=async()=>({stdout:JSON.stringify([{...original,Config:{Labels:{'canopy.workspace':'other'}}}])});await assert.rejects(assessMigrationRecovery(o),/ownership/);
 const missing=options();missing.docker=async()=>{throw Object.assign(Error('missing'),{missingResource:true});};await assert.rejects(assessMigrationRecovery(missing),/original unavailable/);
 const committed=options();committed.records=[...records,{workspaceId:'owner',sequence:2,phase:'committed'}];await assert.rejects(assessMigrationRecovery(committed),/disagrees/);
});

test('rollback keeps failed replacement and original files, never starting or deleting containers',async()=>{
 const o=options();const containers=new Map([['canopy-ws-owner',structuredClone(replacement)],['canopy-preserved-owner-abc',structuredClone(original)]]);const calls=[],events=[];
 const host={runtimes:new Map(),migrationCleanupRequired:new Set(),withResourceLock:fn=>fn(),docker:async args=>{
  calls.push(args);const entry=[...containers].find(([name,c])=>name===args[1]||c.Id===args[1]);
  if(args[0]==='inspect'){if(!entry)throw Object.assign(Error('missing'),{missingResource:true});return {stdout:JSON.stringify([entry[1]])};}
  if(args[0]==='stop'){const c=[...containers.values()].find(c=>c.Id===args.at(-1));c.State.Running=false;}
  if(args[0]==='rename'){assert.ok(!containers.has(args[2]));containers.delete(entry[0]);containers.set(args[2],entry[1]);}
  return {stdout:''};
 }};
 const result=await rollbackMigration({records,readConfig:async()=>o.config,host,journal:{append:async e=>events.push(e)}});
 assert.equal(result.state,'original-restored');assert.equal(containers.get('canopy-ws-owner').Id,'original');
 assert.equal(containers.get('canopy-preserved-owner-abc-failed').State.Running,false);
 assert.ok(!calls.some(c=>['rm','start','run'].includes(c[0])));
 assert.deepEqual(events.map(e=>e.phase),['rollback-started','rollback-complete']);
});
test('recovery refuses a configuration changed since migration preparation',async()=>{
 const o=options();o.config.workspaces[0].cpus=2;
 await assert.rejects(assessMigrationRecovery(o),/Configuration changed/);
});
test('committed lifecycle tolerance refuses changed mounts, checkpoint, accounts, groups, generation regression or active original',async()=>{
 const {projectMounts}=await import('./project-mounts.mjs');const committedNext={...next,generation:4,accounts:['owner'],cgroupParent:'canopy-test.slice',memoryMiB:1024,cpus:1,projectMounts:[{id:'app',writable:true}]};
 const mounts=[['/workspace','canopy-project-owner',true],['/home/agent','canopy-home-owner',true],['/accounts/owner','canopy-account-owner',false],...projectMounts(committedNext)].map(([Destination,Name,RW])=>({Type:'volume',Destination,Name,RW}));
 const committedRecords=[{...records[0],next:committedNext},{workspaceId:'owner',sequence:2,phase:'committed'}];
 const source=(changed={},container={})=>({records:committedRecords,config:{workspaces:[{...committedNext,generation:5,cpus:2,...changed}]},docker:async args=>({stdout:JSON.stringify([args[1]==='canopy-ws-owner'?{...replacement,Mounts:mounts,HostConfig:{CgroupParent:'canopy-test.slice'},...container}:original])})});
 assert.equal((await assessMigrationRecovery(source())).state,'published');
 for(const changed of [{ownerImage:'other'},{accounts:[]},{cgroupParent:'canopy-other.slice'},{generation:3},{projectMounts:[{id:'other',writable:true}]}])await assert.rejects(assessMigrationRecovery(source(changed)),/disagrees/);
 await assert.rejects(assessMigrationRecovery(source({},{Mounts:mounts.slice(1)})),/disagrees/);
 const activeOriginal=source();activeOriginal.docker=async args=>({stdout:JSON.stringify([args[1]==='canopy-ws-owner'?{...replacement,Mounts:mounts,HostConfig:{CgroupParent:'canopy-test.slice'}}:{...original,State:{Running:true}}])});await assert.rejects(assessMigrationRecovery(activeOriginal),/disagrees/);
 const interrupted=source();interrupted.records=committedRecords.slice(0,1);await assert.rejects(assessMigrationRecovery(interrupted),/Configuration changed/);
});
