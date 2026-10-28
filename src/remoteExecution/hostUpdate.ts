import {invoke} from '@tauri-apps/api/core';
import {HOST_PROTOCOL} from '../../packages/remote-host/native-commands.mjs';
import {accountErrorMessage,accountRequestError,othersConnected} from './accountWorkspace';
import type {ManagedWorkspace} from './ManagedWorkspaces';
// Workspace host updates (docs/designs/workspace-host-rollout.md, part 3).
// The workspace list reports which host release a workspace runs (`host`) and
// which one is active (`release`); the app decides what that means itself.
export type HostUpdateState='current'|'available'|'required'|'unknown';
export type HostReport={revision:string|null;protocol:number|null;reportedAt?:string|null};
export type HostRelease={revision:string;protocol:number};
/** What the host itself answers to host_capabilities, for when the list has
 * no report (control plane unreachable, or a host from before reporting). */
export type HostCapabilities={protocol?:number;revision?:string|null};
/** `required`: the host speaks an older protocol than this app. `available`:
 * a newer release is active and this host still works with this app. */
export function hostUpdateState(workspace:Pick<ManagedWorkspace,'host'|'release'>,capabilities?:HostCapabilities|null,appProtocol=HOST_PROTOCOL):HostUpdateState{
 const host=workspace.host??null,release=workspace.release??null;
 const protocol=typeof host?.protocol==='number'?host.protocol:typeof capabilities?.protocol==='number'?capabilities.protocol:null;
 const revision=host?.revision??capabilities?.revision??null;
 if(protocol===null)return 'unknown';
 if(protocol<appProtocol)return 'required';
 if(!release)return 'current';
 if(!revision)return 'unknown';
 return revision===release.revision?'current':'available';
}

export type HostUpdateProgress={phase:'requesting'|'updating'|'completed';accepted:boolean};
export type ConfirmHostUpdate=(others:number)=>Promise<boolean>;
export class HostUpdateCancelled extends Error{constructor(){super('Update cancelled. The workspace keeps running its current host.');}}
export const HOST_UPDATE_WAIT_MS=5*60*1000;
type Observed={id:string;state:string;operation?:{id?:string;action?:string;status:string;last_error?:string|null}};
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
 const deadline=Date.now()+waitMs;let seen=accepted;
 while(Date.now()<deadline){
  let current:Observed|undefined;
  try{current=(await invoke<{workspaces:Observed[]}>('canopy_account_request',{route:'/api/workspaces',body:{action:'status',id:workspaceId}})).workspaces.find(item=>item.id===workspaceId);}
  catch(error){if(!transient(error))throw error;await pause(2000);continue;}
  if(!current)throw Error('Could not find the workspace to confirm its update.');
  const operation=current.operation,ours=operation?.action==='update-host'&&(!operationId||!operation.id||operation.id===operationId);
  if(ours&&operation?.status==='failed')throw Error(operation.last_error||'The workspace update failed. The workspace keeps running its current host.');
  if(ours&&['pending','running'].includes(operation!.status)){if(!seen){seen=true;onProgress?.({phase:'updating',accepted:true});}}
  else if(seen&&current.state==='ready'){onProgress?.({phase:'completed',accepted:true});return;}
  else if(operation&&operation.action!=='update-host'&&['pending','running'].includes(operation.status))throw Error('Another workspace action replaced this update. Check the workspace status.');
  else if(!seen)throw Error('The workspace update was not confirmed. Check the workspace status before trying again.');
  await pause(2000);
 }
 throw Error('The workspace update is taking longer than expected. Check the workspace status.');
}
