import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {SharedAccountsPanel} from '../components/SharedAccountsPanel';
import {Button} from '../components/ui';
/** Read account metadata only. Opening Tools never starts compute or imports a credential. */
export function WorkspaceOwnerTools({workspaceId}:{workspaceId:string}){
 const [state,setState]=useState<{owner:boolean;projects:{id:string;name:string}[]}|null>(null),[error,setError]=useState(''),[projectNotice,setProjectNotice]=useState('');const epoch=useRef(0);
 async function load(){const current=++epoch.current;setState(null);setError('');setProjectNotice('');try{
  const detail=await invoke<{yourAccess?:{role:string}[]}>('canopy_account_request',{route:'/api/teams',body:{action:'workspace-team-list',workspaceId}});
  if(current!==epoch.current)return;
  if(!detail.yourAccess?.some(grant=>grant.role==='owner')){setState({owner:false,projects:[]});return;}
  try{const {projects}=await invoke<{projects:{id:string;name:string}[]}>('canopy_account_request',{route:'/api/teams',body:{action:'workspace-project-list',workspaceId}});
   if(current===epoch.current)setState({owner:true,projects:Array.isArray(projects)?projects:[]});
  }catch{if(current===epoch.current){setState({owner:true,projects:[]});setProjectNotice('Project details are unavailable. Start the workspace, then retry.');}}
 }catch{if(current===epoch.current)setError('Workspace account settings could not be loaded. Try again.');}}
 useEffect(()=>{void load();const changed=()=>{void load();};window.addEventListener('canopy:account-changed',changed);return()=>{epoch.current++;window.removeEventListener('canopy:account-changed',changed);};},[workspaceId]);
 if(error)return <div className="workspace-feedback error" role="alert">{error}<Button size="sm" onClick={()=>void load()}>Retry</Button></div>;
 if(!state)return <div className="workspace-loading" role="status"><span className="workspace-skeleton"/><span className="workspace-skeleton short"/>Loading account settings…</div>;
 if(!state.owner)return null;
 return <section className="workspace-owner-tools"><header><h3>Accounts for shared projects</h3><p>Provider accounts members can use. Who has access is managed in Access.</p></header>{projectNotice&&<div className="workspace-section-hint" role="status">{projectNotice}<Button size="sm" onClick={()=>void load()}>Retry project details</Button></div>}<SharedAccountsPanel workspaceId={workspaceId} projects={state.projects}/></section>;
}
