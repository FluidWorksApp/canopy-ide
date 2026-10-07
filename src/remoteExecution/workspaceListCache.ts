import {invoke} from '@tauri-apps/api/core';
import type {ManagedWorkspace} from './ManagedWorkspaces';
type Snapshot={workspaces:ManagedWorkspace[];at:number};
const subscribers=new Set<(snapshot:Snapshot)=>void>();
/** Every successful refresh, from any caller, reaches every subscriber. */
export function subscribeWorkspaceList(listener:(snapshot:Snapshot)=>void){subscribers.add(listener);return()=>{subscribers.delete(listener);};}
let cache:Snapshot|null=null,epoch=0,namespace:Promise<string|null>|undefined,pending:Promise<Snapshot>|undefined;
const prefix='canopy:workspace-list:v1:';
function clearStoredWorkspaceLists(){try{for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith(prefix))localStorage.removeItem(key);}}catch{/* Storage is optional. */}}
export const isWorkspaceAuthenticationError=(error:unknown)=>/unauthorized|not signed in|sign in required|\b40[13]\b/i.test(String(error));
window.addEventListener('canopy:account-changed',()=>{epoch++;cache=null;namespace=undefined;pending=undefined;clearStoredWorkspaceLists();});
export const peekWorkspaceList=()=>cache;
async function cacheKey(){namespace??=invoke<string|null>('canopy_account_cache_key').catch(()=>null);const key=await namespace;return key&&/^[a-f0-9]{64}$/.test(key)?prefix+key:null;}
export async function restoreWorkspaceList(){
 const current=epoch,key=await cacheKey();if(current!==epoch||!key)return cache;
 try{const raw=localStorage.getItem(key);if(!raw||raw.length>524288)return cache;const saved=JSON.parse(raw) as Snapshot;
  if(Array.isArray(saved.workspaces)&&saved.workspaces.length<=128&&saved.workspaces.every(w=>typeof w.id==='string'&&typeof w.name==='string'&&typeof w.state==='string')&&Number.isFinite(saved.at)&&saved.at<=Date.now()&&Date.now()-saved.at<86400000&&(!cache||saved.at>cache.at))cache=saved;
 }catch{/* Invalid cached display data is discarded. */}
 return cache;
}
export function refreshWorkspaceList(){
 if(pending)return pending;
 const current=epoch;
 const request=invoke<{workspaces:ManagedWorkspace[]}>('canopy_account_request',{route:'/api/workspaces',body:null}).then(async result=>{
  if(current!==epoch)throw Error('Account changed');
  if(!Array.isArray(result?.workspaces)||result.workspaces.length>128)throw Error('Workspace list is unavailable');
  const next={workspaces:result.workspaces,at:Date.now()};cache=next;
  const key=await cacheKey();if(current===epoch&&key)try{localStorage.setItem(key,JSON.stringify(next));}catch{/* Quota does not block live status. */}
  if(current!==epoch)throw Error('Account changed');
  subscribers.forEach(listener=>{try{listener(next);}catch{/* One subscriber never blocks the list. */}});
  return next;
 }).catch(error=>{if(current===epoch&&isWorkspaceAuthenticationError(error)){cache=null;clearStoredWorkspaceLists();}throw error;});
 pending=request;void request.finally(()=>{if(pending===request)pending=undefined;}).catch(()=>{});return request;
}
