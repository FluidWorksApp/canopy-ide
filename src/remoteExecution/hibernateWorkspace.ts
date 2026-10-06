import {invoke} from '@tauri-apps/api/core';
import {canSwitchExecutionMode} from '../executionMode';
import {activeWorkspace} from './workspace';
import {isAccountWorkspace} from './accountWorkspace';
import {connectionKey,reportWorkspaceLifecycle} from './connectionState';
import type {ManagedWorkspace} from './ManagedWorkspaces';
export type HibernatePhase='saving-projects'|'stopping-services'|'stopping-compute'|'completed';
export type HibernateProgress={phase:HibernatePhase;savedProjects?:number;totalProjects?:number;shutdownAccepted:boolean};
export type HibernateProgressListener=(progress:HibernateProgress)=>void;
async function bounded<T>(promise:Promise<T>,message:string,ms=8000):Promise<T>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer!);}}
async function observedWorkspace(id:string){const data=await bounded(invoke<{workspaces:ManagedWorkspace[]}>('canopy_account_request',{route:'/api/workspaces',body:null}),'Workspace status did not respond. Projects are saved; compute has not been confirmed stopped.');return data.workspaces.find(item=>item.id===id);}
/** Retry an existing shutdown by observing control-plane state. Never wake compute
 * or issue another hibernate operation because a client response was delayed. */
export async function waitForWorkspaceStopped(workspaceId:string,onProgress?:HibernateProgressListener,key?:string){
 onProgress?.({phase:'stopping-compute',shutdownAccepted:true});
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){
  const current=await observedWorkspace(workspaceId);
  if(current?.state==='stopped'){if(key)reportWorkspaceLifecycle(key,'hibernated');onProgress?.({phase:'completed',shutdownAccepted:true});return;}
  if(!current||current.state==='error')throw Error('Could not confirm workspace shutdown. Projects are saved; check its status in Workspaces.');
  const pendingShutdown=current.operation?.action==='hibernate'&&['pending','running'].includes(current.operation.status);
  if(current.state==='ready'&&!pendingShutdown)throw Error('The workspace is still running. Shutdown has not been confirmed.');
  if(current.operation?.action&&current.operation.action!=='hibernate'&&['pending','running'].includes(current.operation.status))throw Error('Another workspace action replaced this shutdown. Check its current status.');
  if(workspaceId!=='shoaib-work'&&(current.state==='stopping'||pendingShutdown))await bounded(invoke('canopy_account_request',{route:'/api/operations',body:{workspaceId:current.id,action:'advance'}}),'Shutdown status did not respond. Projects are saved; check the workspace status.');
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 throw Error('Shutdown is taking longer than expected. Projects are saved; compute has not been confirmed stopped.');
}
export async function hibernateWorkspaceProjects(projectIds:string[],snapshot:(id:string)=>Promise<void>,release:(id:string)=>Promise<void>,projectsUnchanged:()=>boolean=()=>true,onProgress?:HibernateProgressListener){
 const workspace=activeWorkspace();
 if(!workspace||!isAccountWorkspace(workspace.connection))throw Error('This connection does not support workspace hibernation');
 if(!canSwitchExecutionMode())throw Error('Save unsaved files before hibernating the workspace');
 const key=connectionKey(workspace.connection.endpoint,workspace.connection.workspaceId);
 let savedProjects=0;
 const publish=(phase:HibernatePhase,shutdownAccepted=false)=>onProgress?.({phase,savedProjects,totalProjects:projectIds.length,shutdownAccepted});
 publish('saving-projects');
 for(const id of projectIds){await bounded(snapshot(id),'Project snapshot timed out. Review its saved state and check the workspace status.');savedProjects++;publish('saving-projects');}
 if(!projectsUnchanged()||!canSwitchExecutionMode())throw Error('Projects changed while saving. Review the open projects and workspace status before retrying.');
 // No cloud shutdown may happen before every project snapshot is durable.
 publish('stopping-services');
 for(const id of projectIds){try{await bounded(release(id),'Workspace services did not respond. Projects are saved; compute has not been confirmed stopped.');}catch(error){
  // Compute may already have stopped through a concurrent intentional shutdown.
  // Only external state can complete this job when the remote release hangs.
  if(activeWorkspace()!==workspace||!projectsUnchanged()||!canSwitchExecutionMode())throw Error('Projects changed during shutdown. Review the saved snapshots and workspace status.');
  try{const current=await observedWorkspace(workspace.connection.workspaceId);if(current?.state==='stopped'){reportWorkspaceLifecycle(key,'hibernated');publish('completed',true);return;}}catch{/* Keep the release failure; saved snapshots remain durable. */}
  throw error;
 }}
 if(activeWorkspace()!==workspace)throw Error('Workspace changed while saving projects');
 if(!projectsUnchanged()||!canSwitchExecutionMode())throw Error('Projects changed while saving. Review the open projects and workspace status before retrying.');
 workspace.setProjectIdle(true);publish('stopping-compute');
 const result=await bounded(invoke<{accepted:boolean}>('canopy_account_request',{route:'/api/operations',body:{workspaceId:workspace.connection.workspaceId,action:'hibernate',confirmInterrupt:true,requestKey:crypto.randomUUID()}}),'Shutdown request did not respond. Projects are saved; check whether compute has stopped.');
 if(result?.accepted!==true)throw Error('Workspace shutdown was not accepted; it may still be running');
 publish('stopping-compute',true);reportWorkspaceLifecycle(key,'stopping');
 await waitForWorkspaceStopped(workspace.connection.workspaceId,progress=>publish(progress.phase,progress.shutdownAccepted),key);
}
