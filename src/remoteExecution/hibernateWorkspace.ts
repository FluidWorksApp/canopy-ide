import {invoke} from '@tauri-apps/api/core';
import {canSwitchExecutionMode} from '../executionMode';
import {activeWorkspace} from './workspace';
import {isAccountWorkspace} from './accountWorkspace';
import {connectionKey,reportWorkspaceLifecycle} from './connectionState';
import type {ManagedWorkspace} from './ManagedWorkspaces';
import {savePhaseLabel} from './storageStatus';
export type HibernatePhase='saving-projects'|'stopping-services'|'stopping-compute'|'completed';
export type HibernateProgress={phase:HibernatePhase;savedProjects?:number;totalProjects?:number;shutdownAccepted:boolean;savePhase?:string|null;saveProgress?:string|null};
// Snapshot storage saves the whole disk after compute stops (trim, stop,
// snapshot, verify); that can take many minutes on a large disk.
export const SNAPSHOT_SAVE_WAIT_MS=90*60*1000;
export type HibernateProgressListener=(progress:HibernateProgress)=>void;
class ObservationTimeout extends Error {}
async function bounded<T>(promise:Promise<T>,message:string,ms=8000):Promise<T>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ObservationTimeout(message)),ms);})]);}finally{clearTimeout(timer!);}}
function transientObservation(error:unknown){
 const message=String(error);
 if(/\b(?:401|403)\b|unauthorized|forbidden|not signed in|sign.?in required/i.test(message))return false;
 return error instanceof ObservationTimeout||/timed?\s*out|timeout|network|connection|failed to fetch|\b(?:408|429|500|502|503|504)\b/i.test(message);
}
function shutdownFence(){const initial=activeWorkspace(),id=initial?.connection.workspaceId,endpoint=initial?.connection.endpoint;let changed=false;const accountChanged=()=>{changed=true;};window.addEventListener('canopy:account-changed',accountChanged);return{check:()=>{if(changed||activeWorkspace()!==initial||initial?.connection.workspaceId!==id||initial?.connection.endpoint!==endpoint)throw Error('Account or workspace changed during shutdown. Check the saved workspace status before continuing.');},close:()=>window.removeEventListener('canopy:account-changed',accountChanged)};}
async function observedWorkspace(id:string,ms=8000){const data=await bounded(invoke<{workspaces:ShutdownWorkspace[]}>('canopy_account_request',{route:'/api/workspaces',body:{action:'status',id}}),'Workspace status did not respond. Projects are saved; compute has not been confirmed stopped.',ms);return data.workspaces.find(item=>item.id===id);}
type ShutdownObservation={accepted?:boolean;deadline?:number;checkCurrent?:()=>void;operationId?:string};
type ShutdownWorkspace=Omit<ManagedWorkspace,'operation'>&{operation?:ManagedWorkspace['operation']&{id?:string}};
/** A response timeout is ambiguous, not a rejected shutdown. Observe the durable
 * intent without issuing another hibernate operation or waking compute. */
export async function waitForWorkspaceStopped(workspaceId:string,onProgress?:HibernateProgressListener,key?:string,options:ShutdownObservation={}){
 const fence=shutdownFence(),check=()=>{fence.check();options.checkCurrent?.();};
 const connection=activeWorkspace()?.connection,lifecycleKey=key??(connection?.workspaceId===workspaceId?connectionKey(connection.endpoint,workspaceId):undefined);
 let accepted=options.accepted??true,operationId=options.operationId;
 let deadline=options.deadline??Date.now()+120000,extended=false;
 const requestBudget=()=>Math.max(1,Math.min(8000,deadline-Date.now()));
 try{
 check();onProgress?.({phase:'stopping-compute',shutdownAccepted:accepted});
 while(Date.now()<deadline){
  let current:ShutdownWorkspace|undefined;
  try{current=await observedWorkspace(workspaceId,requestBudget());}catch(error){check();if(!transientObservation(error))throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(2000,Math.max(0,deadline-Date.now()))));continue;}
  check();
  if(!current)throw Error('Could not confirm workspace shutdown. Projects are saved; check its status in Workspaces.');
  const activeOperation=current.operation&&['pending','running'].includes(current.operation.status);
  if(activeOperation&&current.operation?.action&&current.operation.action!=='hibernate')throw Error('Another workspace action replaced this shutdown. Check its current status.');
  if(current.storage_mode==='snapshot'&&!extended){extended=true;deadline=Math.max(deadline,Date.now()+SNAPSHOT_SAVE_WAIT_MS);}
  if(current.storage_mode==='snapshot'&&savePhaseLabel(current.operation?.phase))onProgress?.({phase:'stopping-compute',shutdownAccepted:true,savePhase:current.operation?.phase??null,saveProgress:current.operation?.save_progress??null});
  if(current.state==='stopped'){if(lifecycleKey)reportWorkspaceLifecycle(lifecycleKey,'hibernated');onProgress?.({phase:'completed',shutdownAccepted:true});return;}
  const pendingShutdown=current.operation?.action==='hibernate'&&activeOperation;
  if(pendingShutdown&&current.operation?.id){if(operationId&&current.operation.id!==operationId)throw Error('Another workspace action replaced this shutdown. Check its current status.');operationId=current.operation.id;}
  if(current.state==='stopping'||pendingShutdown){if(!accepted){accepted=true;onProgress?.({phase:'stopping-compute',shutdownAccepted:true});}if(lifecycleKey)reportWorkspaceLifecycle(lifecycleKey,'stopping');}
  if((current.operation?.action==='hibernate'&&current.operation.status==='failed')||(accepted&&current.state==='error'))throw Error(current.operation?.last_error||'Could not confirm workspace shutdown. Projects are saved; check its status in Workspaces.');
  if(accepted&&current.state==='ready'&&!pendingShutdown)throw Error('The workspace is still running. Shutdown has not been confirmed.');
  if(workspaceId!=='shoaib-work'&&pendingShutdown&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(current.operation?.id??'')){
   check();try{await bounded(invoke('canopy_account_request',{route:'/api/operations',body:{workspaceId:current.id,action:'advance',operationId:current.operation!.id,expectedAction:'hibernate'}}),'Shutdown status did not respond. Projects are saved; check the workspace status.',requestBudget());}catch(error){check();if(!transientObservation(error))throw error;}
   check();
  }
  await new Promise(resolve=>setTimeout(resolve,Math.min(2000,Math.max(0,deadline-Date.now()))));
 }
 check();throw Error(accepted?'Shutdown is taking longer than expected. Projects are saved; compute has not been confirmed stopped.':'The shutdown response was delayed and acceptance could not be confirmed. Projects are saved; check its status in Workspaces before requesting another shutdown.');
 }finally{fence.close();}
}
export async function hibernateWorkspaceProjects(projectIds:string[],snapshot:(id:string)=>Promise<void>,release:(id:string)=>Promise<void>,projectsUnchanged:()=>boolean=()=>true,onProgress?:HibernateProgressListener){
 const fence=shutdownFence();
 try{
 const workspace=activeWorkspace();
 if(!workspace||!isAccountWorkspace(workspace.connection))throw Error('This connection does not support workspace hibernation');
 if(!canSwitchExecutionMode())throw Error('Save unsaved files before hibernating the workspace');
 const key=connectionKey(workspace.connection.endpoint,workspace.connection.workspaceId);
 let savedProjects=0;
 const publish=(phase:HibernatePhase,shutdownAccepted=false)=>onProgress?.({phase,savedProjects,totalProjects:projectIds.length,shutdownAccepted});
 publish('saving-projects');
 for(const id of projectIds){fence.check();await bounded(snapshot(id),'Project snapshot timed out. Review its saved state and check the workspace status.');fence.check();savedProjects++;publish('saving-projects');}
 if(!projectsUnchanged()||!canSwitchExecutionMode())throw Error('Projects changed while saving. Review the open projects and workspace status before retrying.');
 // No cloud shutdown may happen before every project snapshot is durable.
 publish('stopping-services');
 for(const id of projectIds){fence.check();try{await bounded(release(id),'Workspace services did not respond. Projects are saved; compute has not been confirmed stopped.');fence.check();}catch(error){
  fence.check();
  // Compute may already have stopped through a concurrent intentional shutdown.
  // Only external state can complete this job when the remote release hangs.
  if(activeWorkspace()!==workspace||!projectsUnchanged()||!canSwitchExecutionMode())throw Error('Projects changed during shutdown. Review the saved snapshots and workspace status.');
  try{const current=await observedWorkspace(workspace.connection.workspaceId);fence.check();if(current?.state==='stopped'){reportWorkspaceLifecycle(key,'hibernated');publish('completed',true);return;}}catch{/* Keep the release failure; saved snapshots remain durable. */}
  throw error;
 }}
 if(activeWorkspace()!==workspace)throw Error('Workspace changed while saving projects');
 if(!projectsUnchanged()||!canSwitchExecutionMode())throw Error('Projects changed while saving. Review the open projects and workspace status before retrying.');
 fence.check();workspace.setProjectIdle(true);publish('stopping-compute');
 const requestKey=crypto.randomUUID(),deadline=Date.now()+120000;
 let accepted=false,operationId:string|undefined;
 try{
  const result=await bounded(invoke<{accepted:boolean;operation?:{id?:string}}>('canopy_account_request',{route:'/api/operations',body:{workspaceId:workspace.connection.workspaceId,action:'hibernate',confirmInterrupt:true,requestKey}}),'Shutdown request did not respond. Projects are saved; checking its current status.');
  fence.check();if(result?.accepted!==true)throw Error('Workspace shutdown was not accepted; it may still be running');accepted=true;operationId=result.operation?.id;
 }catch(error){fence.check();if(!transientObservation(error))throw error;}
 if(accepted){publish('stopping-compute',true);reportWorkspaceLifecycle(key,'stopping');}
 await waitForWorkspaceStopped(workspace.connection.workspaceId,progress=>publish(progress.phase,progress.shutdownAccepted),key,{accepted,deadline,operationId,checkCurrent:()=>fence.check()});
 }finally{fence.close();}
}
