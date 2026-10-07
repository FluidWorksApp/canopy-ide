import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {migrateWorkspace} from './migrate-workspace.mjs';
import {createMigrationJournal} from './migration-journal.mjs';
import {waitForRuntimeReady} from './runtime-readiness.mjs';
import {privateRead} from './credential-vault.mjs';

// Whole-workspace sharing runs members inside the workspace's capacity slice,
// so the owner container must be inside it too. Containers created before the
// slice existed were left outside it (bootstrap only prepares the slice as
// `sharingCgroupParent`). Docker cannot move a container between cgroups, so
// while the owner container is still stopped after boot this checkpoints its
// writable layer and recreates it in the slice, with the same volumes. It uses
// the journaled replacement and rollback of the old sharing migration, minus
// any project copying. Volumes are never touched.
export async function adoptCapacityGroup({config,host,directory,configPath,authorizeRuntime,migrate=migrateWorkspace,journalFor=createMigrationJournal,ready=waitForRuntimeReady}){
 const workspace=config.workspaces.find(w=>w.id===config.managedSession?.workspaceId);
 if(!workspace||workspace.cgroupParent||!workspace.sharingCgroupParent)return {adopted:false,reason:'not-needed'};
 if(host.migrationCleanupRequired.has(workspace.id))return {adopted:false,reason:'recovery-required'};
 const current=await host.inspectRuntime(workspace);
 if(!current)return {adopted:false,reason:'no-container'}; // ensure() creates it in the slice later
 if(current.State?.Running!==false)return {adopted:false,reason:'running'};
 if(typeof authorizeRuntime!=='function'||!await authorizeRuntime(workspace))return {adopted:false,reason:'unauthorized'};
 await mkdir(directory,{recursive:true,mode:0o700});
 const journal=await journalFor(directory,workspace.id);
 let result;
 try{
  result=await migrate({config,workspaceId:workspace.id,projects:[],capacityOnly:true,host,journal,
   saveConfig:next=>saveHostConfig(configPath,next,workspace,authorizeRuntime),
   verifyRuntime:async(runtime,next)=>{await host.verifyCapacity(next);if(!await ready(runtime))throw Error('Workspace services did not start in the capacity group');}});
 }finally{await journal.close().catch(()=>host.migrationCleanupRequired.add(workspace.id));}
 // Published and verified: the checkpoint image holds the old writable layer.
 // Archive the journal first, so a restart never expects the preserved
 // container, then remove that container (never its volumes).
 await rename(journal.path,join(directory,`${workspace.id}.capacity-${Date.now()}.done`));
 await host.docker(['rm',result.preservedContainer]).catch(error=>console.warn(`Preserved container kept: ${error.message}`));
 return {adopted:true,ownerImage:result.ownerImage};
}
async function saveHostConfig(configPath,next,workspace,authorizeRuntime){
 const before=JSON.parse(await privateRead(configPath,1024*1024));const current=before.workspaces.find(w=>w.id===workspace.id);
 if(!current||current.generation!==workspace.generation||['stopped','deleted'].includes(current.desiredState??current.desired_state)||!await authorizeRuntime(workspace))throw Error('Workspace generation or lifecycle changed during capacity adoption.');
 const temporary=configPath+'.'+randomUUID()+'.capacity';let file;
 try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(next));await file.sync();await file.close();file=null;await rename(temporary,configPath);const parent=await open(dirname(configPath),'r');try{await parent.sync();}finally{await parent.close();}}
 finally{await file?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
