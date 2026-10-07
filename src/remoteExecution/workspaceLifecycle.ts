import {useEffect,useSyncExternalStore} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {ManagedWorkspace} from './ManagedWorkspaces';
import {peekWorkspaceList,refreshWorkspaceList,subscribeWorkspaceList} from './workspaceListCache';

/** One lifecycle per managed workspace. The badge, sidebar row, header menu,
 * overview copy and primary action all derive from this value, so they can
 * never disagree about whether a workspace is running or stopping. */
export type WorkspaceLifecycle='not-started'|'starting'|'running'|'stopping'|'stopped'|'deleting'|'error'|'unknown';

/** The control plane records a stop as a pending hibernate operation while the
 * workspace row still reads `ready`. If no such acknowledgement appears within
 * this window, the stop is treated as not taken and reported inline. */
export const STOP_ACKNOWLEDGE_TIMEOUT_MS=90_000;
export const STOP_POLL_INTERVAL_MS=4000;
const STOP_WATCH_LIMIT_MS=15*60_000;

type StopRequest={requestedAt:number;acknowledged?:boolean};
const storageKey='canopy:workspace-stop-requests:v1';
const listeners=new Set<()=>void>();
const errors=new Map<string,string>();
const watching=new Set<string>();
let requests=new Map<string,StopRequest>(),version=0;

function restore(){
 try{const raw=localStorage.getItem(storageKey);if(!raw)return;const saved=JSON.parse(raw) as Record<string,StopRequest>;
  for(const [id,request] of Object.entries(saved))if(typeof id==='string'&&Number.isFinite(request?.requestedAt)&&request.requestedAt<=Date.now()&&Date.now()-request.requestedAt<STOP_WATCH_LIMIT_MS)requests.set(id,{requestedAt:request.requestedAt,acknowledged:request.acknowledged===true});
 }catch{/* Display state only; the server list stays authoritative. */}
}
function persist(){try{if(requests.size)localStorage.setItem(storageKey,JSON.stringify(Object.fromEntries(requests)));else localStorage.removeItem(storageKey);}catch{/* Storage is optional. */}}
function emit(){version++;persist();listeners.forEach(listener=>listener());}
restore();

const activeOperation=(w:ManagedWorkspace,action:string)=>w.operation?.action===action&&['pending','running'].includes(w.operation.status);
const failedStop=(w:ManagedWorkspace)=>w.operation?.action==='hibernate'&&w.operation.status==='failed';
/** The server has accepted a stop: either the worker moved the row to
 * `stopping`, or the hibernate operation is queued while the row reads ready. */
export const serverStopping=(w:ManagedWorkspace)=>activeOperation(w,'hibernate')||(w.state==='stopping'&&!failedStop(w));

export function workspaceLifecycle(w:ManagedWorkspace,now=Date.now()):WorkspaceLifecycle{
 if(['deleting','deleted'].includes(w.state)||activeOperation(w,'delete'))return 'deleting';
 if(w.state==='stopped')return 'stopped';
 if(serverStopping(w))return 'stopping';
 const request=requests.get(w.id);
 // A list response can be older than the accepted stop. Never flip back to
 // Running while our own stop request is still waiting to be observed.
 if(request&&!failedStop(w)&&(request.acknowledged||now-request.requestedAt<STOP_ACKNOWLEDGE_TIMEOUT_MS))return 'stopping';
 if(w.state==='error'||w.operation?.status==='failed')return 'error';
 return ({ready:'running',starting:'starting',created:'not-started'} as Record<string,WorkspaceLifecycle>)[w.state]??'unknown';
}

export const stopRequested=(id:string)=>requests.has(id);
export const stopRequestError=(id:string)=>errors.get(id);
export function markStopRequested(id:string,now=Date.now()){requests.set(id,{requestedAt:now});errors.delete(id);emit();watchStop(id);}
export function clearStopRequest(id:string){if(!requests.delete(id)&&!errors.delete(id))return;errors.delete(id);emit();}
export function resetWorkspaceLifecycle(){requests=new Map();errors.clear();watching.clear();emit();}

/** Fold a fresh server list into pending stop requests: settle them, record
 * the server's acknowledgement, or expire them with an inline error. */
export function reconcileStopRequests(workspaces:ManagedWorkspace[],now=Date.now()){
 let changed=false;
 for(const [id,request] of requests){
  const w=workspaces.find(item=>item.id===id);
  if(!w||['stopped','deleting','deleted'].includes(w.state)){requests.delete(id);changed=true;continue;}
  if(failedStop(w)){requests.delete(id);errors.set(id,w.operation?.last_error?.replace(/\p{Cc}/gu,' ').slice(0,300).trim()||'Could not stop the workspace. It may still be running; check its status and try again.');changed=true;continue;}
  if(serverStopping(w)){if(!request.acknowledged){request.acknowledged=true;changed=true;}continue;}
  // Acknowledged earlier, now neither stopping nor stopped: another action
  // (for example a resume from another device) replaced the stop.
  if(request.acknowledged){requests.delete(id);changed=true;continue;}
  if(now-request.requestedAt>=STOP_ACKNOWLEDGE_TIMEOUT_MS){requests.delete(id);errors.set(id,'The workspace still reports running. The stop was not confirmed; try Stop again.');changed=true;}
 }
 if(changed)emit();
}
subscribeWorkspaceList(snapshot=>reconcileStopRequests(snapshot.workspaces));
window.addEventListener('canopy:account-changed',()=>{resetWorkspaceLifecycle();dismissStopSwitchNotice();});

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Poll until a stop settles. Owners nudge the queued operation forward the
 * same way startup does; the durable cron still finishes it if this stops. */
export function watchStop(id:string){
 if(watching.has(id))return;watching.add(id);
 void (async()=>{
  const deadline=Date.now()+STOP_WATCH_LIMIT_MS;
  try{
   while(watching.has(id)&&Date.now()<deadline){
    const cached=peekWorkspaceList()?.workspaces.find(w=>w.id===id);
    if(!requests.has(id)&&!(cached&&serverStopping(cached)))return;
    await sleep(STOP_POLL_INTERVAL_MS);
    if(!watching.has(id))return;
    if(cached&&cached.access?.owner!==false&&id!=='shoaib-work')try{await invoke('canopy_account_request',{route:'/api/operations',body:{workspaceId:id,action:'advance'}});}catch{/* The list below still reports progress. */}
    try{await refreshWorkspaceList();}catch{/* Retry on the next tick. */}
   }
  }finally{watching.delete(id);}
 })();
}

/** Re-render on stop-request changes and keep stopping workspaces polled. */
export function useWorkspaceLifecycle(workspaces:ManagedWorkspace[]=[]){
 const current=useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>version);
 const stopping=workspaces.filter(w=>workspaceLifecycle(w)==='stopping').map(w=>w.id).sort().join(',');
 useEffect(()=>{for(const id of requests.keys())watchStop(id);for(const id of stopping.split(','))if(id)watchStop(id);},[stopping,current]);
 return current;
}

/** Shown after Canopy deliberately leaves a workspace the user just stopped. */
export type StopSwitchNotice={workspaceId:string;name:string;at:number};
const noticeKey='canopy:workspace-stop-switch:v1';
export function saveStopSwitchNotice(notice:StopSwitchNotice){try{localStorage.setItem(noticeKey,JSON.stringify(notice));}catch{/* Optional. */}}
export function takeStopSwitchNotice(now=Date.now()):StopSwitchNotice|null{
 try{const raw=localStorage.getItem(noticeKey);if(!raw)return null;const notice=JSON.parse(raw) as StopSwitchNotice;
  if(typeof notice?.workspaceId!=='string'||typeof notice.name!=='string'||!Number.isFinite(notice.at)||now-notice.at>STOP_WATCH_LIMIT_MS){localStorage.removeItem(noticeKey);return null;}
  return notice;
 }catch{return null;}
}
export function dismissStopSwitchNotice(){try{localStorage.removeItem(noticeKey);}catch{/* Optional. */}}
