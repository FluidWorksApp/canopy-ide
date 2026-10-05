import {randomBytes} from 'node:crypto';
import {checkpointOwner} from './owner-checkpoint.mjs';
import {migrateProjectVolume} from './migrate-project-volume.mjs';
import {validateMigrationComponents} from './project-migration.mjs';
import {sharedProjectDefinitions} from './project-catalog.mjs';

// Trusted, offline operation. The caller must stop the gateway and persist
// configuration atomically. Nothing here deletes containers, images or volumes.
export async function migrateWorkspace({config,workspaceId,projects,host,saveConfig,verifyRuntime,journal}){
 const workspace=config.workspaces.find(w=>w.id===workspaceId);
 if(!workspace||workspace.memberId||workspace.projectMounts?.length)throw Error('Workspace is not eligible for initial sharing migration');
 if(!Array.isArray(projects)||!projects.length||projects.length>128)throw Error('Choose projects to migrate');
 for(const project of projects)validateMigrationComponents(project.components);
 sharedProjectDefinitions({...workspace,projectMounts:projects.map(p=>({...p,writable:true,components:p.components.map(({id,label,relativePath})=>({id,label,relativePath}))}))});
 if(typeof saveConfig!=='function'||typeof verifyRuntime!=='function'||typeof journal?.append!=='function')throw Error('Migration requires persistence, a durable journal and readiness verification');
 return host.withResourceLock(async()=>{
  if(host.migrationCleanupRequired.has(workspaceId))throw Error('Workspace migration requires recovery');
  const cgroupParent=workspace.cgroupParent??workspace.sharingCgroupParent;
  await host.verifyCapacity({...workspace,cgroupParent});
  const name='canopy-ws-'+workspaceId;
  const before=JSON.parse((await host.docker(['inspect',name])).stdout)[0];
  await journal.append({phase:'checkpointing',originalContainerId:before.Id});
  const checkpoint=await checkpointOwner(workspace,{docker:host.docker});
  const mounts=[];
  try{for(const project of projects)mounts.push(await migrateProjectVolume(workspace,project,{docker:host.docker,image:host.image}));}
  catch(error){if(error.migrationCleanupRequired)host.migrationCleanupRequired.add(workspaceId);throw error;}
  const next={...workspace,cgroupParent,ownerImage:checkpoint.ownerImage,projectMounts:mounts};
  const preserved=`canopy-preserved-${workspaceId}-${randomBytes(6).toString('hex')}`;
  const current=JSON.parse((await host.docker(['inspect',name])).stdout)[0];
  if(current.Id!==checkpoint.originalContainerId||current.State?.Running!==false)throw Error('Workspace changed during migration');
  const policy=before.HostConfig?.RestartPolicy?.Name??'no';
  if(!['no','always','unless-stopped','on-failure'].includes(policy))throw Error('Invalid original restart policy');
  const retries=before.HostConfig?.RestartPolicy?.MaximumRetryCount??0;
  if(!Number.isInteger(retries)||retries<0)throw Error('Invalid original restart retry count');
  const restorePolicy=policy==='on-failure'&&retries?policy+':'+retries:policy;
  await journal.append({phase:'prepared',originalWorkspace:workspace,originalContainerId:before.Id,preservedContainer:preserved,restorePolicy,next});
  let renamed=false;
  let publicationAttempted=false;
  try{
   await journal.append({phase:'replacing'});
   await host.docker(['update','--restart','no',name]);
   await host.docker(['rename',name,preserved]);
   renamed=true;
   host.runtimes.delete(workspaceId);
   const runtime=await host.ensure(next);
   await verifyRuntime(runtime,next);
   const updated={...config,workspaces:config.workspaces.map(w=>w.id===workspaceId?next:w)};
   await journal.append({phase:'publishing'});
   publicationAttempted=true;
   await saveConfig(updated);
   Object.assign(workspace,next);
   await journal.append({phase:'committed'}).catch(()=>host.migrationCleanupRequired.add(workspaceId));
   return {workspaceId,preservedContainer:preserved,ownerImage:checkpoint.ownerImage,projects:mounts};
  }catch(error){
   // An atomic file replacement can succeed before directory fsync reports an
   // error. Do not restore the old container against potentially new durable
   // configuration. Offline recovery compares the actual config and identities.
   if(publicationAttempted){
    host.migrationCleanupRequired.add(workspaceId);
    host.runtimes.delete(workspaceId);
    throw Error('Migration publication could not be confirmed; preserved containers require recovery');
   }
   // Keep even the unsuccessful replacement for inspection/recovery. Restore
   // the original under its original name, stopped as it was before migration.
   try{
    if(!renamed){
     const original=JSON.parse((await host.docker(['inspect',name])).stdout)[0];
     if(original.Id!==before.Id)throw Error('Original container ownership changed');
     await host.docker(['update','--restart',restorePolicy,name]);
    }else{
    let replacement;
    try{replacement=JSON.parse((await host.docker(['inspect',name])).stdout)[0];}catch(missing){if(!missing.missingResource)throw missing;}
    if(replacement){
     if(replacement.Config?.Labels?.['canopy.workspace']!==workspaceId)throw Error('Replacement ownership differs');
     await host.docker(['update','--restart','no',name]);
     if(replacement.State?.Running)await host.docker(['stop','--timeout','30',name]);
     await host.docker(['rename',name,preserved+'-failed']);
    }
    await host.docker(['rename',preserved,name]);
    await host.docker(['update','--restart',restorePolicy,name]);
    host.runtimes.delete(workspaceId);
    }
    const restored=JSON.parse((await host.docker(['inspect',name])).stdout)[0];
    if(restored.Id!==before.Id||restored.State?.Running!==false)throw Error('Stopped original restoration could not be verified');
    await journal.append({phase:'rolled-back'});
   }catch{host.migrationCleanupRequired.add(workspaceId);throw Error('Migration failed; preserved containers require recovery');}
   throw error;
  }
 });
}
