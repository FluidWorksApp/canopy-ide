import {invoke} from '@tauri-apps/api/core';
import {useSyncExternalStore} from 'react';
import {HOST_PROTOCOL} from '../../packages/remote-host/native-commands.mjs';
import {accountErrorMessage,accountRequestError,othersConnected} from './accountWorkspace';
import type {ManagedWorkspace} from './ManagedWorkspaces';
import {HOST_OUTDATED_EVENT} from './remoteSupport';
// Workspace host updates (docs/designs/workspace-host-rollout.md, part 3).
// The workspace list reports which host release a workspace runs (`host`) and
// which one is active (`release`); the app decides what that means itself.
// `host.protocol` is what the owner's container answers (native commands run
// there), so it is the protocol this app talks to.
export type HostUpdateState='current'|'available'|'required'|'unknown';
export type HostReport={revision:string|null;protocol:number|null;image?:string|null;reportedAt?:string|null};
export type HostRelease={revision:string;protocol:number;image?:string|null};
/** What the container answers to host_capabilities, for when the list has no
 * report (control plane unreachable, or a host from before reporting). */
export type HostCapabilities={protocol?:number;revision?:string|null};
/** `required`: the workspace speaks an older protocol than this app.
 * `available`: a newer release is active and the workspace still works with
 * this app. */
export function hostUpdateState(workspace:Pick<ManagedWorkspace,'host'|'release'>,capabilities?:HostCapabilities|null,appProtocol=HOST_PROTOCOL):HostUpdateState{
 const host=workspace.host??null,release=workspace.release??null;
 const protocol=typeof host?.protocol==='number'?host.protocol:typeof capabilities?.protocol==='number'?capabilities.protocol:null;
 const revision=host?.revision??capabilities?.revision??null;
 if(protocol===null)return 'unknown';
 if(protocol<appProtocol)return 'required';
 if(!release)return 'current';
 if(host?.image&&release.image&&host.image!==release.image)return 'available';
 if(!revision)return 'unknown';
 return revision===release.revision?'current':'available';
}

/** What a workspace connection learned about its host: sent by
 * NativeWorkspaceHost as HOST_OUTDATED_EVENT. `command` is the feature that
 * failed, never a background probe. */
export type HostUpdateSignal={workspaceId:string;state:'available'|'required';command:string|null;revision:string|null};
const signals=new Map<string,HostUpdateSignal>(),signalListeners=new Set<()=>void>();
export const hostUpdateSignal=(workspaceId:string)=>signals.get(workspaceId)??null;
export function subscribeHostUpdates(listener:()=>void){signalListeners.add(listener);return()=>{signalListeners.delete(listener);};}
export function recordHostUpdate(signal:HostUpdateSignal|null,workspaceId=signal?.workspaceId){
 if(!workspaceId)return;
 if(signal)signals.set(workspaceId,signal);else signals.delete(workspaceId);
 signalListeners.forEach(listener=>{try{listener();}catch{/* One view never blocks another. */}});
}
/** The update this workspace needs, if any, as the notice and the chip dot see it. */
export function useWorkspaceUpdate(workspaceId:string|undefined,listed:Pick<ManagedWorkspace,'host'|'release'>|undefined){
 const signal=useSyncExternalStore(subscribeHostUpdates,()=>workspaceId?hostUpdateSignal(workspaceId):null);
 return workspaceId?workspaceUpdate(listed,signal):null;
}
if(typeof window!=='undefined')window.addEventListener(HOST_OUTDATED_EVENT,event=>{
 const detail=(event as CustomEvent<Partial<HostUpdateSignal>>).detail;
 if(typeof detail?.workspaceId!=='string'||(detail.state!=='available'&&detail.state!=='required'))return;
 const previous=signals.get(detail.workspaceId);if(previous?.state==='required'&&detail.state==='available')return;
 recordHostUpdate({workspaceId:detail.workspaceId,state:detail.state,command:detail.command??null,revision:detail.revision??null});
});
/** The notice to show. A command that failed for want of an update is proof;
 * otherwise the workspace list decides when it has a report, and what the
 * connection learned when it does not. */
export function workspaceUpdate(listed:Pick<ManagedWorkspace,'host'|'release'>|undefined,signal:HostUpdateSignal|null):{state:'available'|'required';command:string|null;revision:string|null}|null{
 const revision=listed?.release?.revision??signal?.revision??null;
 if(signal?.state==='required')return {state:'required',command:signal.command,revision};
 const fromList=listed?.host?hostUpdateState(listed):null;
 if(fromList==='available'||fromList==='required')return {state:fromList,command:null,revision};
 if(fromList==='current')return null;
 return signal?{state:signal.state,command:null,revision}:null;
}

/** The host's own step, as the control plane copies it to the operation's
 * `context.updateStep` (host-update-run.mjs). */
export type HostUpdateStep='download'|'gateway'|'gateway-ready'|'image'|'rollback';
export type HostUpdateProgress={phase:'requesting'|'updating'|'completed';accepted:boolean;step?:HostUpdateStep|null};
const STEP_LABELS:Record<HostUpdateStep,string>={download:'Downloading the update','gateway':'Restarting the workspace host','gateway-ready':'Updating the workspace',image:'Updating the workspace',rollback:'Rolling back'};
export const hostUpdateStepLabel=(step?:string|null)=>step&&Object.hasOwn(STEP_LABELS,step)?STEP_LABELS[step as HostUpdateStep]:null;
export type ConfirmHostUpdate=(others:number)=>Promise<boolean>;
export class HostUpdateCancelled extends Error{constructor(){super('Update cancelled. The workspace keeps running its current host.');}}
// Step (b) may pull the release image when the pre-pull has not.
export const HOST_UPDATE_WAIT_MS=20*60*1000;
type Observed={id:string;state:string;operation?:{id?:string;action?:string;status:string;last_error?:string|null;context?:{updateStep?:string|null}|null}};
const transient=(error:unknown)=>{const message=String(error);if(/\b(?:401|403)\b|unauthorized|forbidden|not signed in/i.test(message))return false;return /timed?\s*out|timeout|network|connection|failed to fetch|\b(?:408|429|500|502|503|504)\b/i.test(message);};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Owner only: asks the control plane for the `update-host` operation, with
 * the same request key, confirmation and progress handling as hibernate, and
 * waits until the operation has finished. Members are refused by the server. */
export async function requestHostUpdate(workspaceId:string,{clientId,confirmOthers,onProgress,waitMs=HOST_UPDATE_WAIT_MS}:{clientId?:string;confirmOthers?:ConfirmHostUpdate;onProgress?:(progress:HostUpdateProgress)=>void;waitMs?:number}={}){
 let confirmed=false,accepted=false,operationId:string|undefined;
 onProgress?.({phase:'requesting',accepted:false});
 for(;;){
  try{
   const result=await invoke<{accepted:boolean;operation?:{id?:string}}>('canopy_account_request',{route:'/api/operations',body:{workspaceId,action:'update-host',requestKey:crypto.randomUUID(),...(clientId?{clientId}:{}),...(confirmed?{confirmOthers:true}:{})},detailedErrors:true});
   if(result?.accepted!==true)throw Error('The workspace update was not accepted.');
   accepted=true;operationId=result.operation?.id;
  }catch(error){
   const others=confirmed?null:othersConnected(error);
   if(others!==null){if(!confirmOthers||!await confirmOthers(others))throw new HostUpdateCancelled();confirmed=true;continue;}
   // A lost response may still have started the update: watch for it below.
   if(!transient(error))throw accountRequestError(error)?Error(accountErrorMessage(error)):error;
  }
  break;
 }
 onProgress?.({phase:'updating',accepted});
 const deadline=Date.now()+waitMs;let seen=accepted,lastStep:HostUpdateStep|null=null;
 while(Date.now()<deadline){
  let current:Observed|undefined;
  try{current=(await invoke<{workspaces:Observed[]}>('canopy_account_request',{route:'/api/workspaces',body:{action:'status',id:workspaceId}})).workspaces.find(item=>item.id===workspaceId);}
  catch(error){if(!transient(error))throw error;await pause(2000);continue;}
  if(!current)throw Error('Could not find the workspace to confirm its update.');
  const operation=current.operation,ours=operation?.action==='update-host'&&(!operationId||!operation.id||operation.id===operationId);
  if(ours&&operation?.status==='failed')throw Error(operation.last_error||'The workspace update failed. The workspace keeps running its current host.');
  if(ours&&['pending','running'].includes(operation!.status)){
   const step=hostUpdateStepLabel(operation?.context?.updateStep)?operation!.context!.updateStep as HostUpdateStep:null;
   if(!seen||step!==lastStep){seen=true;lastStep=step;onProgress?.({phase:'updating',accepted:true,step});}
  }
  else if(seen&&current.state==='ready'){onProgress?.({phase:'completed',accepted:true});return;}
  else if(operation&&operation.action!=='update-host'&&['pending','running'].includes(operation.status))throw Error('Another workspace action replaced this update. Check the workspace status.');
  else if(!seen)throw Error('The workspace update was not confirmed. Check the workspace status before trying again.');
  await pause(2000);
 }
 throw Error('The workspace update is taking longer than expected. Check the workspace status.');
}
