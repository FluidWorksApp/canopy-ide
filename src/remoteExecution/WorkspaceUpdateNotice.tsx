import {useEffect,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '../components/ui';
import {Dialog} from '../components/Dialog';
import type {ManagedWorkspace} from './ManagedWorkspaces';
import {hostFeatureName} from './remoteSupport';
import {HostUpdateCancelled,hostUpdateSignal,recordHostUpdate,requestHostUpdate,subscribeHostUpdates,workspaceUpdate} from './hostUpdate';
import {refreshWorkspaceList} from './workspaceListCache';
// The update notice for the active cloud workspace
// (docs/designs/workspace-host-rollout.md, part 3). It replaces the one-time
// "older Canopy host" error: the owner can update the workspace from here,
// a member is told to ask the owner.

const LATER_KEY='canopy:workspace-update-later:';
const notNow=new Set<string>();
function laterRevision(workspaceId:string){try{return localStorage.getItem(LATER_KEY+workspaceId);}catch{return null;}}
function rememberLater(workspaceId:string,revision:string|null){try{if(revision)localStorage.setItem(LATER_KEY+workspaceId,revision);}catch{/* Storage is optional: Later then lasts this session. */}}

/** The update this workspace needs, if any, as the notice and the chip dot see it. */
export function useWorkspaceUpdate(workspaceId:string|undefined,listed:ManagedWorkspace|undefined){
 const signal=useSyncExternalStore(subscribeHostUpdates,()=>workspaceId?hostUpdateSignal(workspaceId):null);
 return workspaceId?workspaceUpdate(listed,signal):null;
}

export const updateConfirmBody='Terminals and agents in this workspace restart. Your files and projects are kept.';
export const othersUpdateMessage=(others:number)=>`${others} other ${others===1?'person is':'people are'} connected. Their terminals and agents stop too; they come back when they open the workspace again.`;

type Phase={kind:'notice'}|{kind:'updating'}|{kind:'done'}|{kind:'failed';message:string};
export function WorkspaceUpdateNotice({workspaceId,name,owner,listed,clientId,reconnect}:{workspaceId:string;name:string;owner:boolean;listed:ManagedWorkspace|undefined;clientId?:string;reconnect:()=>Promise<void>}){
 const update=useWorkspaceUpdate(workspaceId,listed);
 const [phase,setPhase]=useState<Phase>({kind:'notice'});
 const [hidden,setHidden]=useState(()=>notNow.has(workspaceId));
 const [confirm,setConfirm]=useState(false);
 const [others,setOthers]=useState<{count:number;answer:(yes:boolean)=>void}|null>(null);
 useEffect(()=>{setPhase({kind:'notice'});setHidden(notNow.has(workspaceId));},[workspaceId]);
 const busy=phase.kind==='updating';
 if(phase.kind==='notice'&&(!update||hidden||update.state==='available'&&update.revision&&laterRevision(workspaceId)===update.revision))return null;
 const required=update?.state==='required';
 const feature=required&&update?.command?hostFeatureName(update.command):null;
 const message=phase.kind==='updating'?`Updating ${name}…`:phase.kind==='done'?`${name} is up to date.`:phase.kind==='failed'?phase.message:
  required?(feature?`${name} needs an update to use ${feature} and other parts of this version.`:`${name} needs an update to work with this version of Canopy.`):`A newer Canopy host is ready for ${name}.`;
 const dismiss=()=>{
  if(phase.kind!=='notice'){setPhase({kind:'notice'});if(phase.kind==='done')return;}
  if(update?.state==='available')rememberLater(workspaceId,update.revision);
  notNow.add(workspaceId);setHidden(true);
 };
 async function run(){
  setConfirm(false);setPhase({kind:'updating'});
  try{
   await requestHostUpdate(workspaceId,{clientId,confirmOthers:count=>new Promise(resolve=>setOthers({count,answer:resolve}))});
   recordHostUpdate(null,workspaceId);
   await refreshWorkspaceList().catch(()=>{});
   // Terminals and agents restarted with the container: open it again.
   await reconnect().catch(()=>{});
   setPhase({kind:'done'});
  }catch(error){
   if(error instanceof HostUpdateCancelled){setPhase({kind:'notice'});return;}
   setPhase({kind:'failed',message:error instanceof Error?error.message:String(error)});
  }
 }
 return <>
  <aside className="workspace-progress-float workspace-update-notice" aria-label="Workspace update">
   <div className="workspace-progress-line"><span className="workspace-progress-dot" aria-hidden="true"/><strong role="status">{message}</strong></div>
   {busy&&<div className="workspace-progress-track" role="progressbar" aria-label="Workspace update progress" aria-valuetext={message}><span style={{width:'60%'}}/></div>}
   <div className="workspace-progress-meta">
    {phase.kind==='notice'&&!owner&&<small>Ask the workspace owner to update it.</small>}
    {busy&&<small>Your files and projects are kept. Terminals and agents restart.</small>}
    <div className="workspace-inline-actions">
     {owner&&(phase.kind==='notice'||phase.kind==='failed')&&<Button size="sm" variant="accent" onClick={()=>setConfirm(true)}>{phase.kind==='failed'?'Try again':'Update workspace'}</Button>}
     {!busy&&<Button size="sm" onClick={dismiss}>{phase.kind!=='notice'?'Dismiss':!owner?'Dismiss':required?'Not now':'Later'}</Button>}
    </div>
   </div>
  </aside>
  {confirm&&createPortal(<Dialog title={`Update ${name}?`} body={updateConfirmBody} onDismiss={()=>setConfirm(false)} actions={[{label:'Cancel',onClick:()=>setConfirm(false)},{label:'Update workspace',primary:true,onClick:()=>void run()}]}/>,document.body)}
  {others&&createPortal(<Dialog title="Other people are connected" body={othersUpdateMessage(others.count)} onDismiss={()=>{others.answer(false);setOthers(null);}} actions={[{label:'Cancel',onClick:()=>{others.answer(false);setOthers(null);}},{label:'Update anyway',primary:true,onClick:()=>{others.answer(true);setOthers(null);}}]}/>,document.body)}
 </>;
}
