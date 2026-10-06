import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {quarantineInterruptedMigrations} from './migration-startup.mjs';

async function fixture(run){
 const directory=await mkdtemp(join(tmpdir(),'canopy-startup-'));
 const old={id:'owner'},next={id:'owner',ownerImage:'checkpoint'};
 const original={Id:'original',State:{Running:false},Config:{Labels:{'canopy.workspace':'owner'}}};
 const current={...original,Id:'replacement'};
 const config={workspaces:[old]};
 const host={migrationCleanupRequired:new Set(),docker:async args=>{
  assert.equal(args[0],'inspect');
  return {stdout:JSON.stringify([args[1]==='canopy-ws-owner'?current:original])};
 }};
 const records=[{workspaceId:'owner',sequence:1,phase:'prepared',originalWorkspace:old,next,originalContainerId:'original',preservedContainer:'canopy-preserved-owner-abc',restorePolicy:'no'}];
 const save=async(tail='')=>writeFile(join(directory,'owner.migration.jsonl'),records.map(r=>JSON.stringify(r)+'\n').join('')+tail);
 try{await run({directory,config,host,records,next,save,current,original});}finally{await rm(directory,{recursive:true,force:true});}
}
test('fresh host quarantines interrupted replacement from durable evidence',()=>fixture(async f=>{
 await f.save();assert.deepEqual(await quarantineInterruptedMigrations(f),['owner']);
 assert.ok(f.host.migrationCleanupRequired.has('owner'));
}));
test('verified committed migration can reopen, but torn completion remains quarantined',()=>fixture(async f=>{
 f.config.workspaces=[f.next];f.records.push({workspaceId:'owner',sequence:2,phase:'committed'});
 await f.save();assert.deepEqual(await quarantineInterruptedMigrations(f),[]);
 assert.equal(f.host.migrationCleanupRequired.size,0);
 await f.save('{');assert.deepEqual(await quarantineInterruptedMigrations(f),['owner']);
}));
test('mismatched or corrupt journals fail closed and preserve quarantine',()=>fixture(async f=>{
 f.records[0].workspaceId='other';await f.save();
 await assert.rejects(quarantineInterruptedMigrations(f),/identity differs/);
 assert.ok(f.host.migrationCleanupRequired.has('owner'));
 await writeFile(join(f.directory,'owner.migration.jsonl'),'broken\n');
 await assert.rejects(quarantineInterruptedMigrations(f));
 assert.ok(f.host.migrationCleanupRequired.has('owner'));
}));
test('new installation without migration directory needs no recovery',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'canopy-startup-'));
 try{assert.deepEqual(await quarantineInterruptedMigrations({directory:join(directory,'missing'),config:{workspaces:[]},host:{}}),[]);}finally{await rm(directory,{recursive:true,force:true});}
});
test('committed migration survives legitimate resume and resize while stable project/container identity remains enforced',()=>fixture(async f=>{
 Object.assign(f.next,{generation:4,name:'Original',memoryMiB:1024,cpus:1,accounts:[],cgroupParent:'canopy-test.slice',projectMounts:[{id:'app',writable:true}]});
 const {projectMounts}=await import('./project-mounts.mjs');f.current.Mounts=[['/workspace','canopy-project-owner',true],['/home/agent','canopy-home-owner',true],...projectMounts(f.next)].map(([Destination,Name,RW])=>({Type:'volume',Destination,Name,RW}));f.current.HostConfig={CgroupParent:'canopy-test.slice'};
 f.records.push({workspaceId:'owner',sequence:2,phase:'committed'});await f.save();
 f.config.workspaces=[{...f.next,generation:5,name:'Renamed',memoryMiB:2048,cpus:2,desiredState:'running'}];assert.deepEqual(await quarantineInterruptedMigrations(f),[]);assert.equal(f.host.migrationCleanupRequired.size,0);
 f.config.workspaces[0].projectMounts=[{id:'other',writable:true}];await assert.rejects(quarantineInterruptedMigrations(f),/disagrees/);assert.equal(f.host.migrationCleanupRequired.has('owner'),true);
}));
