import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {adoptCapacityGroup} from './capacity-adoption.mjs';
const slice='canopy-0123456789abcdef01234567.slice';
async function fixture(run){const directory=await mkdtemp(join(tmpdir(),'canopy-adopt-'));try{await run(directory);}finally{await rm(directory,{recursive:true,force:true});}}
const config=(extra={})=>({managedSession:{workspaceId:'ws-a'},workspaces:[{id:'ws-a',generation:2,accounts:[],sharingCgroupParent:slice,...extra}]});
const host=(state={Running:false})=>{const docker=[];return {docker,migrationCleanupRequired:new Set(),inspectRuntime:async()=>state&&{State:state},verifyCapacity:async()=>{},docker:async args=>{docker.push(args);return {stdout:''};}};};
test('a stopped owner container outside the slice is recreated inside it, then the preserved copy is removed',()=>fixture(async directory=>{
 const h=host(),calls=[];h.docker=async args=>{calls.push(args);return {stdout:''};};
 const result=await adoptCapacityGroup({config:config(),host:h,directory,configPath:join(directory,'host.json'),authorizeRuntime:async()=>true,
  migrate:async options=>{assert.equal(options.capacityOnly,true);assert.deepEqual(options.projects,[]);await options.journal.append({phase:'committed'});return {preservedContainer:'canopy-preserved-ws-a-1',ownerImage:'sha256:'+'1'.repeat(64)};}});
 assert.equal(result.adopted,true);
 assert.deepEqual(calls,[['rm','canopy-preserved-ws-a-1']],'never --volumes');
 const files=await readdir(directory);assert.equal(files.some(f=>f.endsWith('.migration.jsonl')),false,'journal archived so restarts do not expect the preserved container');assert.ok(files.some(f=>f.includes('.capacity-')));
}));
test('nothing happens when not needed, running, unauthorized or awaiting recovery',()=>fixture(async directory=>{
 const never=async()=>assert.fail('must not migrate');
 const base={directory,configPath:join(directory,'host.json'),authorizeRuntime:async()=>true,migrate:never};
 assert.equal((await adoptCapacityGroup({...base,config:config({cgroupParent:slice}),host:host()})).reason,'not-needed');
 assert.equal((await adoptCapacityGroup({...base,config:config({sharingCgroupParent:undefined}),host:host()})).reason,'not-needed');
 assert.equal((await adoptCapacityGroup({...base,config:config(),host:host({Running:true})})).reason,'running');
 assert.equal((await adoptCapacityGroup({...base,config:config(),host:host(null)})).reason,'no-container');
 assert.equal((await adoptCapacityGroup({...base,config:config(),host:host(),authorizeRuntime:async()=>false})).reason,'unauthorized');
 const blocked=host();blocked.migrationCleanupRequired.add('ws-a');assert.equal((await adoptCapacityGroup({...base,config:config(),host:blocked})).reason,'recovery-required');
}));
test('a failed adoption keeps its journal for the existing recovery path',()=>fixture(async directory=>{
 await assert.rejects(adoptCapacityGroup({directory,configPath:join(directory,'host.json'),authorizeRuntime:async()=>true,config:config(),host:host(),migrate:async()=>{throw Error('Migration failed; preserved containers require recovery');}}),/recovery/);
 assert.ok((await readdir(directory)).includes('ws-a.migration.jsonl'));
}));
