import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {activeWorkspace} from '../remoteExecution/workspace';
import {Button} from './ui';
import type {WorkspaceState} from '../projects';
import './sharedSessions.css';
type Candidate={id:string;name:string;components:{id:string;label:string;source:string;relativePath:string}[];error?:string};
type Status={status:string;phase:string;error:string|null};
export function sharingCandidates(store:WorkspaceState):Candidate[]{return store.projects.map(project=>{
 const components=project.components.map(component=>({id:component.id,label:component.label,source:component.path.startsWith('/workspace/')?component.path.slice('/workspace/'.length):'',relativePath:project.components.length===1?'.':component.id}));
 return {id:project.id,name:project.name,components,...(components.some(c=>!c.source||c.source.split('/').some(part=>!part||part==='.'||part==='..'))?{error:'One or more component folders are outside this workspace’s project storage.'}:{})};
});}
export function SharingSetupPanel({workspaceId,onEnabled}:{workspaceId:string;onEnabled?:()=>void}){
 const [status,setStatus]=useState<Status|null>(null),[candidates,setCandidates]=useState<Candidate[]>([]),[selected,setSelected]=useState<string[]>([]),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[enabled,setEnabled]=useState(false);const epoch=useRef(0);
 const host=activeWorkspace(),client=host?.connection.workspaceId===workspaceId?host.client:null;
 useEffect(()=>{const reset=()=>{epoch.current++;setStatus(null);setCandidates([]);setSelected([]);setConfirmed(false);setError('');setBusy(false);setEnabled(false);};reset();window.addEventListener('canopy:account-changed',reset);return()=>{epoch.current++;window.removeEventListener('canopy:account-changed',reset);};},[workspaceId]);
 async function refresh(){if(!client)return;const current=epoch.current;try{const data=await client.workspace<Status>(workspaceId,'/sharing-setup');if(current===epoch.current)setStatus(data);}catch{if(current===epoch.current)setError('Sharing setup is unavailable. Update and connect to this workspace to continue.');}}
 async function inspect(){if(!client||!host)return;const current=epoch.current;setBusy(true);setError('');try{await refresh();const store=JSON.parse(await host.invoke<string>('store_load',{})) as WorkspaceState;if(current===epoch.current)setCandidates(sharingCandidates(store));}catch(e){if(current===epoch.current)setError(String(e));}finally{if(current===epoch.current)setBusy(false);}}
 useEffect(()=>{if(status?.status!=='running')return;const timer=setInterval(()=>void refresh(),2000);return()=>clearInterval(timer);},[status?.status,client,workspaceId]);
 async function prepare(){if(!client)return;const current=epoch.current;setBusy(true);setError('');try{const data=await client.workspace<Status>(workspaceId,'/sharing-setup',{action:'start',confirmInterrupt:confirmed,projects:candidates.filter(p=>selected.includes(p.id)&&!p.error).map(({error,...p})=>p)});if(current===epoch.current){setStatus(data);setConfirmed(false);}}catch(e){if(current===epoch.current)setError(String(e));}finally{if(current===epoch.current)setBusy(false);}}
 async function activate(){const current=epoch.current;setBusy(true);setError('');try{await invoke('canopy_account_request',{route:'/api/operations',body:{action:'activate-sharing',workspaceId}});if(current===epoch.current){setEnabled(true);onEnabled?.();}}catch(e){if(current===epoch.current)setError(String(e));}finally{if(current===epoch.current)setBusy(false);}}
 return <details className="sharing-setup-panel" onToggle={e=>{if(e.currentTarget.open)void refresh();}}><summary>Enable workspace sharing</summary><div className="shared-sessions-content">
  {!client?<p>Connect as the workspace owner to prepare sharing. This panel does not start the workspace.</p>:<><p>Choose projects for separate shared storage. Your personal home and Git and agent sign-ins stay private. Git repositories are copied in full, including history and folders beyond the selected components. Non-Git component folders are copied as selected. Check repository files and environment files before sharing.</p>
   {error&&<p role="alert">{error}</p>}{status?.error&&<p role="alert">{status.error}</p>}
   {status?.status==='running'?<p role="status">Preparing shared storage · {status.phase}. You can continue using other workspaces.</p>:status?.status==='recovery-required'?<p>Setup needs management recovery. Original files and the original container are retained; no new member connections are allowed.</p>:status?.status==='ready'?<><p>Shared project storage is ready. Activate verified access for your teams and people.</p><Button disabled={busy||enabled} onClick={()=>void activate()}>{enabled?'Sharing enabled':busy?'Checking readiness…':'Activate sharing'}</Button></>:<>
    <Button disabled={busy} onClick={()=>void inspect()}>Find workspace projects</Button>
    {candidates.map(p=><label className="workspace-project-choice" key={p.id}><input type="checkbox" aria-label={p.name} checked={selected.includes(p.id)} disabled={busy||!!p.error} onChange={e=>setSelected(ids=>e.target.checked?[...ids,p.id]:ids.filter(id=>id!==p.id))}/><span><strong>{p.name}</strong><small>{p.error??p.components.map(c=>c.label).join(' · ')}</small></span></label>)}
    {!!candidates.length&&<><label className="shared-session-disclosure"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I am ready to stop all running terminals, agents and jobs in this workspace. Files and setup will be retained while shared storage is prepared.</label><Button disabled={busy||!selected.length||!confirmed} onClick={()=>void prepare()}>{busy?'Starting setup…':'Prepare shared storage'}</Button></>}
   </>}
  </>}
 </div></details>;
}
