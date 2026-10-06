import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {upgradeRuntimeImage,imageUpgradeJournal,quarantineImageUpgrades} from './image-upgrade.mjs';
const original={Id:'a'.repeat(64),Config:{Labels:{'canopy.workspace':'alice'}},State:{Running:false}};
const release={reference:'ghcr.io/fluidworksapp/canopy-workspace@sha256:'+'b'.repeat(64),imageId:'sha256:'+'c'.repeat(64)};
function fixture(){
 const names=new Map([['canopy-ws-alice',structuredClone(original)]]),calls=[],records=[];
 const docker=async args=>{calls.push(args);if(args[0]==='inspect'){if(!names.has(args[1]))throw Object.assign(Error('missing'),{missingResource:true});return {stdout:JSON.stringify([names.get(args[1])])};}if(args[0]==='rename'){names.set(args[2],names.get(args[1]));names.delete(args[1]);}if(args[0]==='stop')names.get(args.at(-1)).State.Running=false;return {stdout:''};};
 const launch=async image=>{assert.equal(image,release.reference);names.set('canopy-ws-alice',{Id:'d'.repeat(64),Config:{Labels:{'canopy.workspace':'alice'}},State:{Running:true}});return {url:'synthetic'};};
 return {names,calls,records,docker,launch,journal:async r=>records.push(r),verify:async()=>true};
}
test('image replacement keeps the original container and never deletes containers or volumes',async()=>{
 const f=fixture();await upgradeRuntimeImage({id:'alice'},original,release,f);
 assert.ok([...f.names.keys()].some(name=>name.startsWith('canopy-previous-alice-')));assert.equal(f.records.at(-1).phase,'committed');assert.ok(!f.calls.some(args=>['rm','volume','commit'].includes(args[0])));
});
test('bad release restores the original stopped container and retains the failed replacement',async()=>{
 const f=fixture();f.verify=async()=>false;await assert.rejects(upgradeRuntimeImage({id:'alice'},original,release,f),/failed readiness/);assert.equal(f.names.get('canopy-ws-alice').Id,original.Id);assert.equal(f.names.get('canopy-ws-alice').State.Running,false);assert.equal(f.records.at(-1).phase,'rolled-back');assert.ok([...f.names.keys()].some(name=>name.endsWith('-failed')));
});
test('running or replaced originals cannot be rolled over',async()=>{
 const f=fixture();await assert.rejects(upgradeRuntimeImage({id:'alice'},{...original,State:{Running:true}},release,f),/Stop/);assert.equal(f.calls.length,0);f.names.get('canopy-ws-alice').Id='e'.repeat(64);await assert.rejects(upgradeRuntimeImage({id:'alice'},original,release,f));assert.ok(!f.calls.some(args=>args[0]==='rename'));
});
test('interrupted image journals quarantine their workspace across management restarts',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'canopy-image-journal-'));try{const save=imageUpgradeJournal(dir,'alice');await save({phase:'replacing',originalContainerId:original.Id});const host={migrationCleanupRequired:new Set()};await quarantineImageUpgrades(dir,host);assert.ok(host.migrationCleanupRequired.has('alice'));await save({phase:'committed'});host.migrationCleanupRequired.clear();await quarantineImageUpgrades(dir,host);assert.equal(host.migrationCleanupRequired.size,0);}finally{await rm(dir,{recursive:true,force:true});}
});

import {readImageUpgrade,recoverImageUpgrade} from './image-upgrade.mjs';
import {chmod,symlink} from 'node:fs/promises';
const recoveryRecord={version:1,workspaceId:'alice',phase:'replacing',originalContainerId:original.Id,preservedContainer:'canopy-previous-alice-012345abcdef',image:release.reference};
test('offline recovery restores the exact original without starting or deleting compute',async()=>{
 const f=fixture();await f.docker(['rename','canopy-ws-alice',recoveryRecord.preservedContainer]);await f.launch(release.reference);f.calls.length=0;
 const result=await recoverImageUpgrade(recoveryRecord,f);
 assert.equal(result.containerId,original.Id);assert.equal(f.names.get('canopy-ws-alice').State.Running,false);
 assert.ok([...f.names.keys()].some(name=>name.includes('-recovery-')));
 assert.ok(!f.calls.some(args=>['start','rm','volume'].includes(args[0])));assert.equal(f.records.at(-1).phase,'rolled-back');
});
test('offline recovery refuses foreign candidates and changed or running originals before mutation',async()=>{
 for(const scenario of ['foreign','running','replaced']){
  const f=fixture();await f.docker(['rename','canopy-ws-alice',recoveryRecord.preservedContainer]);await f.launch(release.reference);
  if(scenario==='foreign')f.names.get('canopy-ws-alice').Config.Labels['canopy.workspace']='bob';
  if(scenario==='running')f.names.get(recoveryRecord.preservedContainer).State.Running=true;
  if(scenario==='replaced')f.names.get(recoveryRecord.preservedContainer).Id='f'.repeat(64);
  f.calls.length=0;await assert.rejects(recoverImageUpgrade(recoveryRecord,f));assert.ok(f.calls.every(args=>args[0]==='inspect'));
 }
});
test('image journals reject symlinks and group-readable recovery records',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'canopy-image-read-'));
 try{await imageUpgradeJournal(dir,'alice')(recoveryRecord);assert.equal((await readImageUpgrade(dir,'alice')).originalContainerId,original.Id);
 await chmod(path.join(dir,'alice.json'),0o644);await assert.rejects(readImageUpgrade(dir,'alice'),/permissions/);
 await symlink(path.join(dir,'alice.json'),path.join(dir,'bob.json'));await assert.rejects(readImageUpgrade(dir,'bob'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
