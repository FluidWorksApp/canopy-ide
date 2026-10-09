import {isDeepStrictEqual} from 'node:util';
import {projectMounts} from './project-mounts.mjs';
import {verifyServiceMount,volumeMounts} from './service-mount.mjs';

// A completed migration survives later control-plane resume/resize generations.
// Only lifecycle-owned fields may advance. Project/account/image/capacity-group
// identity remains bound to the durable migration and real Docker mounts.
const lifecycleFields=new Set(['generation','name','desiredState','desired_state','memoryMiB','memoryMaxMiB','cpus','cpusMax','swapRatio','swapMiB','storageGiB','pidsLimit']);
function committedLifecycleMatches(workspace,next,current){
 const stable=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!lifecycleFields.has(key)));
 if(!isDeepStrictEqual(stable(workspace),stable(next)))return false;
 const before=next.generation??0,after=workspace.generation??0;
 if(!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(after)||after<before)return false;
 const expected=[['/workspace',`canopy-project-${workspace.id}`,true],['/home/agent',`canopy-home-${workspace.id}`,true],...(workspace.accounts??[]).map(id=>[`/accounts/${id}`,`canopy-account-${id}`,false]),...projectMounts(workspace)].sort();
 if(!Array.isArray(current?.Mounts))return false;
 try{verifyServiceMount(workspace,current.Mounts);}catch{return false;}
 if(volumeMounts(current.Mounts).some(m=>m.Type!=='volume')||!isDeepStrictEqual(volumeMounts(current.Mounts).map(m=>[m.Destination,m.Name,m.RW]).sort(),expected)||current.HostConfig?.CgroupParent!==workspace.cgroupParent)return false;
 return true;
}

// Read-only recovery assessment. Never restart, rename or delete anything from
// a journal alone: compare durable configuration with inspected Docker state.
export async function assessMigrationRecovery({records,config,docker}) {
 if(!Array.isArray(records)||!records.length)throw Error('Missing migration journal');
 const id=records[0].workspaceId;
 if(typeof id!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(id))throw Error('Invalid workspace identity');
 records.forEach((r,i)=>{if(r.workspaceId!==id||r.sequence!==i+1)throw Error('Invalid journal sequence');});
 const prepared=records.findLast(r=>r.phase==='prepared');
 if(!prepared)return {state:'before-replacement',workspaceId:id};
 if(typeof prepared.originalContainerId!=='string'||!prepared.originalContainerId||
    typeof prepared.preservedContainer!=='string'||!prepared.preservedContainer.startsWith(`canopy-preserved-${id}-`)||
    !/^canopy-preserved-[a-z0-9-]+$/.test(prepared.preservedContainer))throw Error('Invalid recovery identities');
 const inspect=async name=>{try{return JSON.parse((await docker(['inspect',name])).stdout)[0];}catch(error){if(error.missingResource)return null;throw error;}};
 const current=await inspect(`canopy-ws-${id}`);
 const preserved=await inspect(prepared.preservedContainer);
 for(const container of [current,preserved])if(container&&container.Config?.Labels?.['canopy.workspace']!==id)throw Error('Container ownership changed; manual recovery required');
 const workspace=config.workspaces.find(w=>w.id===id);
 if(!workspace)throw Error('Workspace configuration missing; manual recovery required');
 const committed=records.at(-1).phase==='committed';
 const published=isDeepStrictEqual(workspace,prepared.next)||committed&&committedLifecycleMatches(workspace,prepared.next,current);
 if(published){
  if(!current||current.Id===prepared.originalContainerId||preserved?.Id!==prepared.originalContainerId||preserved.State?.Running!==false)throw Error('Published migration disagrees with containers; manual recovery required');
  return {state:'published',workspaceId:id,originalContainer:prepared.preservedContainer,running:current.State?.Running===true};
 }
 if(records.some(r=>r.phase==='committed'))throw Error('Committed migration disagrees with configuration; manual recovery required');
 if(!prepared.originalWorkspace||!isDeepStrictEqual(workspace,prepared.originalWorkspace))throw Error('Configuration changed; manual recovery required');
 if(current?.Id===prepared.originalContainerId){
  if(preserved)throw Error('Conflicting preserved container; manual recovery required');
  return {state:'original-restored',workspaceId:id,running:current.State?.Running===true,restorePolicy:prepared.restorePolicy};
 }
 if(preserved?.Id!==prepared.originalContainerId||preserved.State?.Running!==false)throw Error('Stopped original unavailable; manual recovery required');
 return {state:'rollback-needed',workspaceId:id,originalContainer:prepared.preservedContainer,replacementContainerId:current?.Id??null,restorePolicy:prepared.restorePolicy};
}

// Offline host operation. Caller holds the host service stopped and supplies a
// separate durable recovery journal. The original remains stopped throughout.
export async function rollbackMigration({records,readConfig,host,journal}) {
 if(typeof readConfig!=='function'||typeof journal?.append!=='function')throw Error('Recovery requires fresh configuration and a durable journal');
 return host.withResourceLock(async()=>{
  const assessment=await assessMigrationRecovery({records,config:await readConfig(),docker:host.docker});
  if(assessment.state!=='rollback-needed')return assessment;
  const prepared=records.findLast(r=>r.phase==='prepared');
  if(!/^(no|always|unless-stopped|on-failure(?::[1-9][0-9]*)?)$/.test(prepared.restorePolicy))throw Error('Invalid restart policy');
  const id=assessment.workspaceId;
  const name='canopy-ws-'+id;
  await journal.append({phase:'rollback-started',originalContainerId:prepared.originalContainerId,replacementContainerId:assessment.replacementContainerId});
  try{
   if(assessment.replacementContainerId){
    const replacement=assessment.replacementContainerId;
    await host.docker(['update','--restart','no',replacement]);
    await host.docker(['stop','--timeout','30',replacement]);
    await host.docker(['rename',replacement,prepared.preservedContainer+'-failed']);
   }
   await host.docker(['rename',prepared.originalContainerId,name]);
   await host.docker(['update','--restart',prepared.restorePolicy,prepared.originalContainerId]);
   host.runtimes.delete(id);
   const restored=JSON.parse((await host.docker(['inspect',name])).stdout)[0];
   if(restored?.Id!==prepared.originalContainerId||restored.State?.Running!==false)throw Error('Original restoration could not be verified');
   await journal.append({phase:'rollback-complete',originalContainerId:prepared.originalContainerId});
   return {state:'original-restored',workspaceId:id,running:false};
  }catch(error){host.migrationCleanupRequired.add(id);throw error;}
 });
}
