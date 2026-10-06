import {invoke} from '@tauri-apps/api/core';
import {useEffect,useState} from 'react';
import {activeWorkspace} from './workspace';
import {WorkspaceProgress} from './WorkspaceProgress';
import type {ManagedWorkspace} from './ManagedWorkspaces';
import {isAccountWorkspace} from './accountWorkspace';
import {connectionKey,reportWorkspaceLifecycle} from './connectionState';
const eventName='canopy:project-workspace-progress';
let pending:Promise<void>|undefined;
const report=(message:string|null)=>window.dispatchEvent(new CustomEvent(eventName,{detail:message}));
const request=<T,>(route:string,body?:unknown)=>invoke<T>('canopy_account_request',{route,body:body??null});
/** Project intent is held until compute and the workspace service are ready. */
export async function ensureProjectWorkspace(){
 const host=activeWorkspace();
 if(!host||!isAccountWorkspace(host.connection))return;
 reportWorkspaceLifecycle(connectionKey(host.connection.endpoint,host.connection.workspaceId),null);
 host.setProjectIdle(false);
 if(pending)return pending;
 pending=(async()=>{
  const id=host.connection.workspaceId;let resumed=false;
  for(let attempt=0;attempt<360;attempt++){
   const result=await request<{workspaces:ManagedWorkspace[]}>('/api/workspaces');
   const w=result.workspaces.find(w=>w.id===id);
   if(!w)throw Error('This workspace is no longer available. Choose another workspace.');
   if(w.state==='ready'){await host.client.workspace(id,'/open',{resume:true});report(null);return;}
   if(w.state==='error')throw Error('Workspace startup failed. Open Workspaces to retry.');
   report(w.state==='stopping'?'Waiting for the workspace to finish stopping…':w.operation?.phase==='preparing-workspace'?'Starting workspace services…':w.operation?.phase==='connecting-workspace'?'Checking the workspace connection…':'Starting your workspace…');
   if(['created','stopped'].includes(w.state)&&!resumed){await request('/api/operations',{workspaceId:id,action:'resume',requestKey:crypto.randomUUID()});resumed=true;}
   else if(id!=='shoaib-work'&&(w.state==='starting'||w.state==='stopping'))await request('/api/operations',{workspaceId:id,action:'advance'});
   await new Promise(resolve=>setTimeout(resolve,5000));
  }
  throw Error('Workspace startup is taking longer than expected. Open Workspaces to retry.');
 })().finally(()=>{pending=undefined;report(null);});
 return pending;
}
export function ProjectWorkspaceProgress(){
 const [message,setMessage]=useState<string|null>(null);
 useEffect(()=>{const listener=(e:Event)=>setMessage((e as CustomEvent).detail);window.addEventListener(eventName,listener);return()=>window.removeEventListener(eventName,listener);},[]);
 return message?<WorkspaceProgress progress={{name:'Opening project',step:message.includes('connection')?3:message.includes('services')?2:0,elapsed:0,message}} onDetails={()=>window.dispatchEvent(new Event('canopy:open-workspaces'))}/>:null;
}
