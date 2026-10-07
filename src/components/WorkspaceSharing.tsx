import {useEffect,useId,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button} from './ui';
import {WorkspaceSharingStatus} from './WorkspaceSharingStatus';
import './workspaceSharing.css';
// Sharing works like sharing a document: who, Can view or Can edit, and three
// switches. Saving is the share; members can connect once the running
// workspace is ready (the status line above the list says when).
export type Level='view'|'edit';
export type Subject={type:'person'|'team'|'everyone';id:string;name?:string;email?:string};
export type Share={subject:Subject;level:Level;projects:boolean;sessions:boolean;accounts:boolean;via:string[]};
type Listing={organizationId:string|null;organizationName:string|null;people:{id:string;name:string;email:string}[];teams:{id:string;name:string}[];shares:Share[]};
type Draft={subject:Subject|null;level:Level;projects:boolean;sessions:boolean;accounts:boolean};
const request=<T,>(body:Record<string,unknown>)=>invoke<T>('canopy_account_request',{route:'/api/teams',body});
export const SWITCHES=[
 {key:'projects',label:'Projects',hint:'Every project in this workspace, including new ones'},
 {key:'sessions',label:'Agent sessions',hint:'See and join agent sessions you publish'},
 {key:'accounts',label:'Accounts',hint:'Use the provider accounts you share in Tools & accounts'},
] as const;
const newDraft=():Draft=>({subject:null,level:'edit',projects:true,sessions:false,accounts:false});
const sameSubject=(a:Subject,b:Subject)=>a.type===b.type&&a.id===b.id;
const subjectKey=(s:Subject)=>`${s.type}:${s.id}`;

export function WorkspaceSharing({workspaceId,workspaceName}:{workspaceId:string;workspaceName?:string}){
 const [listing,setListing]=useState<Listing|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [ownerOnly,setOwnerOnly]=useState(false),[draft,setDraft]=useState<Draft|null>(null),[refresh,setRefresh]=useState(0);
 const [organizations,setOrganizations]=useState<{id:string;name:string}[]>([]),[organization,setOrganization]=useState('');
 const epoch=useRef(0),uid=useId();
 async function load(){
  const current=epoch.current;setLoading(true);setError('');
  try{
   const data=await request<Listing>({action:'workspace-share-list',workspaceId});if(current!==epoch.current)return;
   setListing(data);setOwnerOnly(false);
   if(!data.organizationId){const list=await request<{organizations:{id:string;name:string}[]}>({action:'organization-list'});if(current===epoch.current)setOrganizations(list.organizations);}
  }catch(e){if(current!==epoch.current)return;if(/Only the workspace owner/.test(String(e)))setOwnerOnly(true);else setError(String(e));}
  finally{if(current===epoch.current)setLoading(false);}
 }
 useEffect(()=>{const reload=()=>{epoch.current++;setListing(null);setDraft(null);setNotice('');setError('');setBusy(false);setOrganizations([]);setOrganization('');void load();};reload();window.addEventListener('canopy:account-changed',reload);return()=>{epoch.current++;window.removeEventListener('canopy:account-changed',reload);};},[workspaceId]);
 async function act(body:Record<string,unknown>,message:string){
  const current=epoch.current;setBusy(true);setError('');setNotice('');
  try{await request({...body,workspaceId});if(current!==epoch.current)return;setDraft(null);setNotice(message);setRefresh(n=>n+1);await load();}
  catch(e){if(current===epoch.current)setError(String(e));}finally{if(current===epoch.current)setBusy(false);}
 }
 const save=(share:Omit<Share,'via'>,message:string)=>act({action:'workspace-share-set',subject:{type:share.subject.type,id:share.subject.id},level:share.level,projects:share.projects,sessions:share.sessions,accounts:share.accounts},message);
 const shares=listing?.shares??[];
 const choices:Subject[]=listing?[
  ...(listing.organizationId&&!shares.some(s=>s.subject.type==='everyone')?[{type:'everyone' as const,id:listing.organizationId,name:`Everyone in ${listing.organizationName??'your organization'}`}]:[]),
  ...listing.teams.filter(t=>!shares.some(s=>sameSubject(s.subject,{type:'team',id:t.id}))).map(t=>({type:'team' as const,id:t.id,name:t.name})),
  ...listing.people.filter(p=>!shares.some(s=>sameSubject(s.subject,{type:'person',id:p.id}))).map(p=>({type:'person' as const,id:p.id,name:p.name||p.email,email:p.email})),
 ]:[];
 if(ownerOnly)return <section className="workspace-sharing-access" aria-label="Workspace access"><header className="workspace-sharing-access-heading"><div><h2>Sharing</h2><p>Only the owner of {workspaceName??'this workspace'} can change who it is shared with.</p></div></header></section>;
 return <section className="workspace-sharing-access" aria-label="Workspace access">
  <header className="workspace-sharing-access-heading"><div><h2>Sharing</h2><p>{workspaceName?`Share ${workspaceName} like a document: who, and whether they can view or edit.`:'Share this workspace like a document: who, and whether they can view or edit.'}</p></div>{listing?.organizationId&&!draft&&<Button size="sm" variant="accent" disabled={busy||loading||!choices.length} onClick={()=>{setDraft(newDraft());setNotice('');setError('');}}>Share</Button>}</header>
  {listing?.organizationId&&<WorkspaceSharingStatus workspaceId={workspaceId} hasAccess={shares.length>0} refreshKey={refresh}/>}
  {error&&<div className="workspace-sharing-access-error" role="alert"><span>{error}</span><Button size="sm" disabled={busy} onClick={()=>{setError('');void load();}}>Retry</Button></div>}
  {notice&&<p className="workspace-sharing-access-notice" role="status">{notice}</p>}
  {loading&&!listing&&<div className="workspace-sharing-access-loading" role="status">Loading sharing…<div/><div/></div>}
  {listing&&!listing.organizationId&&<div className="workspace-sharing-access-empty"><h3>Share with your organization</h3><p>Add this workspace to an organization to share it with its people and teams.</p><div className="workspace-sharing-access-attach"><label>Organization<select value={organization} onChange={e=>setOrganization(e.target.value)}><option value="">Choose an organization</option>{organizations.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label><Button disabled={busy||!organization} onClick={()=>void act({action:'organization-workspace-attach',organizationId:organization},'Workspace added to organization.')}>Add to organization</Button></div></div>}
  {draft&&<form className="workspace-share-dialog" aria-label="Share workspace" onSubmit={event=>{event.preventDefault();if(draft.subject)void save({...draft,subject:draft.subject},`Shared with ${draft.subject.name}.`);}}>
   <label className="workspace-share-who" htmlFor={`${uid}-who`}>Share with<select id={`${uid}-who`} aria-label="Share with" value={draft.subject?subjectKey(draft.subject):''} disabled={busy} onChange={e=>setDraft({...draft,subject:choices.find(c=>subjectKey(c)===e.target.value)??null})}><option value="">Choose a person, team or everyone</option>{choices.map(c=><option key={subjectKey(c)} value={subjectKey(c)}>{c.type==='team'?`Team · ${c.name}`:c.type==='person'?`${c.name}${c.email&&c.email!==c.name?` · ${c.email}`:''}`:c.name}</option>)}</select></label>
   <ShareControls share={draft} disabled={busy} onChange={next=>setDraft({...draft,...next})}/>
   <footer><Button type="button" disabled={busy} onClick={()=>setDraft(null)}>Cancel</Button><Button variant="accent" type="submit" disabled={busy||!draft.subject||!draft.projects&&!draft.sessions}>{busy?'Sharing…':'Share'}</Button></footer>
  </form>}
  {listing?.organizationId&&<ul className="workspace-share-list" aria-label="Shared with">
   {shares.map(share=><li key={subjectKey(share.subject)} className="workspace-share-row">
    <span className="workspace-share-identity"><strong>{share.subject.name}</strong><small>{share.subject.type==='team'?'Team':share.subject.type==='everyone'?'Current and future members':share.subject.email}{share.via.length?` · also via team ${share.via.join(', ')}`:''}</small></span>
    <ShareControls share={share} disabled={busy} compact onChange={next=>void save({...share,...next},'Sharing updated.')}/>
    <Button size="sm" variant="ghost" disabled={busy} aria-label={`Stop sharing with ${share.subject.name}`} onClick={()=>void act({action:'workspace-share-remove',subject:{type:share.subject.type,id:share.subject.id}},`Stopped sharing with ${share.subject.name}.`)}>Remove</Button>
   </li>)}
   {!shares.length&&!draft&&<li className="workspace-share-empty">Not shared with anyone yet.</li>}
  </ul>}
 </section>;
}
function ShareControls({share,onChange,disabled,compact=false}:{share:Pick<Share,'level'|'projects'|'sessions'|'accounts'>;onChange:(next:Partial<Share>)=>void;disabled:boolean;compact?:boolean}){
 const uid=useId();
 return <div className={`workspace-share-controls${compact?' compact':''}`}>
  <select aria-label="Access" value={share.level} disabled={disabled} onChange={e=>onChange({level:e.target.value as Level})}><option value="view">Can view</option><option value="edit">Can edit</option></select>
  {SWITCHES.map(item=><label key={item.key} className="workspace-share-switch" title={item.hint}><input type="checkbox" aria-label={item.label} aria-describedby={compact?undefined:`${uid}-${item.key}`} checked={share[item.key]} disabled={disabled||item.key==='projects'&&share.projects&&!share.sessions||item.key==='sessions'&&share.sessions&&!share.projects} onChange={e=>onChange({[item.key]:e.target.checked})}/><span>{item.label}</span>{!compact&&<small id={`${uid}-${item.key}`}>{item.hint}</small>}</label>)}
 </div>;
}
