import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button} from './ui';
import './workspaceSharing.css';
// Whole-workspace sharing. Adding a person, team or everyone in Access is the
// share; Canopy's account service then checks the running workspace is ready
// for members (again after every restart). This line only reports that, with
// Retry when the check failed. It never needs a connection to the workspace.
export type SharingState='off'|'stopped'|'pending'|'ready'|'failed';
export type Sharing={state:SharingState;enabled:boolean;ready:boolean;error:string|null};
const request=(body:Record<string,unknown>)=>invoke<{sharing:Sharing}>('canopy_account_request',{route:'/api/operations',body});
export function sharingLine(sharing:Sharing|null,hasAccess:boolean){
 if(!sharing)return {tone:'quiet',text:'Checking sharing…'};
 if(sharing.state==='ready')return {tone:'on',text:'Sharing on · People with access can connect'};
 if(sharing.state==='pending')return {tone:'busy',text:'Getting ready · Members can connect in a minute'};
 if(sharing.state==='stopped')return {tone:'quiet',text:'Sharing on · Members can connect while the workspace runs'};
 if(sharing.state==='failed')return {tone:'error',text:`Not ready: ${sharing.error??'the workspace did not confirm member isolation'}`};
 return {tone:'quiet',text:hasAccess?'Sharing off · People with access can’t connect':'Not shared · Add a person or team to share this workspace'};
}
export function WorkspaceSharingStatus({workspaceId,hasAccess,refreshKey=0}:{workspaceId:string;hasAccess:boolean;refreshKey?:number}){
 const [sharing,setSharing]=useState<Sharing|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmOff,setConfirmOff]=useState(false);const epoch=useRef(0);
 async function call(action:string){const current=epoch.current;if(action!=='sharing-status')setBusy(true);setError('');try{const result=await request({action,workspaceId});if(current===epoch.current)setSharing(result.sharing);}catch(e){if(current===epoch.current)setError(String(e));}finally{if(current===epoch.current)setBusy(false);}}
 useEffect(()=>{epoch.current++;setSharing(null);setBusy(false);setError('');void call('sharing-status');const changed=()=>{epoch.current++;setSharing(null);void call('sharing-status');};window.addEventListener('canopy:account-changed',changed);return()=>{epoch.current++;window.removeEventListener('canopy:account-changed',changed);};},[workspaceId]);
 // A new grant turns sharing on; show the change without waiting for a poll.
 useEffect(()=>{if(refreshKey)void call('sharing-status');},[refreshKey]);
 useEffect(()=>{if(sharing?.state!=='pending')return;const timer=setInterval(()=>void call('sharing-status'),5000);return()=>clearInterval(timer);},[sharing?.state,workspaceId]);
 const line=sharingLine(sharing,hasAccess);
 return <div className={`workspace-sharing-status workspace-sharing-status-${line.tone}`} role="status" aria-label="Sharing">
  <i aria-hidden="true"/><span>{line.text}</span>
  {sharing?.state==='failed'&&<Button size="sm" disabled={busy} onClick={()=>void call('sharing-retry')}>{busy?'Checking…':'Retry'}</Button>}
  {sharing?.state==='off'&&hasAccess&&<Button size="sm" disabled={busy} onClick={()=>void call('sharing-on')}>Turn on sharing</Button>}
  {sharing&&['ready','pending','failed','stopped'].includes(sharing.state)&&(confirmOff?<span className="workspace-sharing-status-confirm">Members are disconnected.<Button size="sm" variant="danger" disabled={busy} onClick={()=>{setConfirmOff(false);void call('sharing-off');}}>Turn off sharing</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirmOff(false)}>Cancel</Button></span>:<Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirmOff(true)}>Turn off</Button>)}
  {error&&<small className="workspace-sharing-status-error" role="alert">{error}</small>}
 </div>;
}
