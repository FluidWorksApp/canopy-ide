import {useEffect,useState} from 'react';
import {Button} from '../components/ui';
import type {ManagedWorkspace} from './ManagedWorkspaces';
import {peekWorkspaceList,refreshWorkspaceList,subscribeWorkspaceList} from './workspaceListCache';
import {stopRequestError,useWorkspaceLifecycle,watchStop,workspaceLifecycle,type StopSwitchNotice} from './workspaceLifecycle';

/** Follows a stop after Canopy moved the user off that workspace, so the
 * switch reads as deliberate and the outcome stays visible. */
export function WorkspaceStopNotice({notice,onDetails,onDismiss}:{notice:StopSwitchNotice;onDetails:()=>void;onDismiss:()=>void}){
 const [workspace,setWorkspace]=useState<ManagedWorkspace|undefined>(()=>peekWorkspaceList()?.workspaces.find(w=>w.id===notice.workspaceId));
 useEffect(()=>{
  const unsubscribe=subscribeWorkspaceList(snapshot=>setWorkspace(snapshot.workspaces.find(w=>w.id===notice.workspaceId)));
  void refreshWorkspaceList().catch(()=>{});watchStop(notice.workspaceId);
  return unsubscribe;
 },[notice.workspaceId]);
 useWorkspaceLifecycle(workspace?[workspace]:[]);
 const lifecycle=workspace?workspaceLifecycle(workspace):'stopping',error=stopRequestError(notice.workspaceId);
 const stopped=lifecycle==='stopped',settled=stopped||!!error||!['stopping','unknown'].includes(lifecycle);
 const status=error?'Needs attention':stopped?'Stopped':lifecycle==='stopping'?'Stopping…':lifecycle==='running'?'Running':'Checking status';
 return <aside className="workspace-progress-float" aria-label="Workspace stop">
  <div className="workspace-progress-line"><span className="workspace-progress-dot" aria-hidden="true"/><strong>{stopped?`${notice.name} stopped`:`Stopping ${notice.name}`}</strong><span role="status">{status}</span></div>
  {!settled&&<div className="workspace-progress-track" role="progressbar" aria-label="Workspace stop progress" aria-valuetext={status}><span style={{width:'60%'}}/></div>}
  <div className="workspace-progress-meta"><small>{error??(stopped?`You’re on your Local workspace. ${notice.name}’s files and setup are saved; resume it from Workspaces.`:`You’re now on your Local workspace. ${notice.name}’s files and setup are saved while its compute stops.`)}</small><div className="workspace-inline-actions"><Button size="sm" onClick={onDetails}>Details</Button><Button size="sm" onClick={onDismiss}>Dismiss</Button></div></div>
 </aside>;
}
