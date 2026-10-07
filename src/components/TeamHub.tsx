import type {AccountConversation} from './AccountChatView';
import type {CSSProperties} from 'react';
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {getUnreadSummary,subscribeTeamUnread} from '../teamMessaging/session';
import {badgeLabel,NO_UNREAD,rememberTeamName} from '../teamMessaging/unread';
import {invoke} from '@tauri-apps/api/core';
import {Button,Select,TextInput} from './ui';
import {AccountSettings} from './AccountSettings';
import {SettingsIcon} from './icons';
import {avatarTone,displayName,initials,secondaryEmail,type Person} from './teamHubPeople';
import './teamHub.css';
type Team={id:string;name:string;role:string;organization_id?:string|null};
type Organization={id:string;name:string;role:string};
type Member={id:string;name:string;email:string;role:string};
type Invite={id:string;name:string;email?:string};
type Directory={teams:Team[];invitations:Invite[];selfId:string;organizations:Organization[]};
type Detail={members:Member[];pending:Invite[]};

const request=<T,>(body?:unknown)=>invoke<T>('canopy_account_request',{route:'/api/teams',body:body??null});
const unauthorized=(error:unknown)=>/unauthorized|not signed in|sign in required|\b40[13]\b/i.test(String(error));
const message=(error:unknown)=>String(error).replace(/^Error:\s*/,'');
const LIST_POLL_MS=15000,DETAIL_POLL_MS=3000;

// Last-known directory for the signed-in account, kept in memory only. The
// panel unmounts whenever the sidebar switches views; without this every
// reopen painted an empty panel until the network answered. Member names and
// emails are personal data, so nothing is written to disk. An account change
// drops it before any component handler runs (this listener is registered at
// import time), so a new account never sees the previous one's people.
let cache:{directory:Directory|null;details:Record<string,Detail>;selected:string}={directory:null,details:{},selected:''};
let cacheEpoch=0;
window.addEventListener('canopy:account-changed',()=>{cacheEpoch++;cache={directory:null,details:{},selected:''};});

function Avatar({person}:{person:Person}){
 return <span aria-hidden="true" className="team-avatar" style={{'--team-tone':`var(${avatarTone(person)})`} as CSSProperties}>{initials(person)}</span>;
}
function SkeletonRows({count}:{count:number}){
 return <div className="team-skeleton" aria-hidden="true">{Array.from({length:count},(_,i)=><div key={i} className="team-row team-row-skeleton"><span className="team-skel-avatar"/><span className="team-skel-line" style={{width:`${62-i*9}%`}}/></div>)}</div>;
}
function UnreadPill({count,label}:{count:number;label:string}){
 if(count<=0)return null;
 return <span className="team-unread" aria-label={`${count} unread ${label}`} title={`${count} unread`}>{badgeLabel(count)}</span>;
}
function AccountIcon(){
 return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>;
}

export function TeamHub({onOpenChat}:{onOpenChat?:(conversation:AccountConversation)=>void}){
 const [epoch,setEpoch]=useState(cacheEpoch);
 const [directory,setDirectory]=useState<Directory|null>(cache.directory);
 const [details,setDetails]=useState<Record<string,Detail>>(cache.details);
 const [selected,setSelectedState]=useState(cache.selected);
 const [listLoading,setListLoading]=useState(true),[listError,setListError]=useState('');
 const [detailLoading,setDetailLoading]=useState(''),[detailError,setDetailError]=useState<{team:string;text:string}|null>(null);
 const [retry,setRetry]=useState(0);
 const [organization,setOrganization]=useState(cache.directory?.organizations[0]?.id??'');
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[actionError,setActionError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[account,setAccount]=useState(false),[manage,setManage]=useState(false);
 const listInFlight=useRef(false);

 const teams=directory?.teams??[],invitations=directory?.invitations??[],organizations=directory?.organizations??[],selfId=directory?.selfId??'';
 const team=teams.find(t=>t.id===selected);
 const detail=selected?details[selected]:undefined;
 const members=detail?.members??[],pending=detail?.pending??[];

 const setSelected=useCallback((id:string)=>{cache.selected=id;setSelectedState(id);},[]);
 const storeDetail=useCallback((teamId:string,next:Detail)=>{cache.details={...cache.details,[teamId]:next};setDetails(cache.details);},[]);

 // Account switch: forget everything visible now and go straight back to
 // loading. The old panel showed a sign-in error and waited for the next
 // 15s poll, which is the "blank, then it shows up again" the user saw.
 useEffect(()=>{const changed=()=>{setEpoch(cacheEpoch);setDirectory(null);setDetails({});setSelectedState('');setOrganization('');setNotice('');setName('');setEmail('');setBusy(false);setActionError('');setListError('');setDetailError(null);setListLoading(true);};window.addEventListener('canopy:account-changed',changed);return()=>window.removeEventListener('canopy:account-changed',changed);},[]);

 const loadDirectory=useCallback(async()=>{
  const current=cacheEpoch;listInFlight.current=true;
  try{
   const [data,orgData]=await Promise.all([request<{teams:Team[];invitations:Invite[];selfId:string}>(),request<{organizations:Organization[]}>({action:'organization-list'})]);
   if(current!==cacheEpoch)return;
   const next:Directory={teams:data.teams??[],invitations:data.invitations??[],selfId:data.selfId,organizations:(orgData?.organizations??[]).filter(o=>o.role==='owner'||o.role==='admin')};
   for(const t of next.teams)rememberTeamName(t.id,t.name);
   cache.directory=next;setDirectory(next);setListError('');
   const keep=next.teams.some(t=>t.id===cache.selected)?cache.selected:next.teams[0]?.id??'';
   cache.selected=keep;setSelectedState(keep);
   setOrganization(o=>next.organizations.some(x=>x.id===o)?o:next.organizations[0]?.id??'');
  }catch(e){
   if(current!==cacheEpoch)return;
   if(unauthorized(e)){cache={directory:null,details:{},selected:''};setDirectory(null);setDetails({});setSelectedState('');}
   setListError(unauthorized(e)?'Sign in to see your teams.':message(e));
  }finally{if(current===cacheEpoch){listInFlight.current=false;setListLoading(false);}}
 },[]);

 useEffect(()=>{let alive=true;setListLoading(true);void loadDirectory();const timer=setInterval(()=>{if(alive&&!listInFlight.current)void loadDirectory();},LIST_POLL_MS);return()=>{alive=false;clearInterval(timer);};},[epoch,retry,loadDirectory]);

 useEffect(()=>{
  if(!selected)return;
  const current=cacheEpoch;let alive=true,first=true;let timer:ReturnType<typeof setTimeout>;
  setDetailLoading(selected);
  const load=async()=>{
   try{const next=await request<{members:Member[];invitations:Invite[]}>({action:'detail',teamId:selected});if(alive&&current===cacheEpoch){storeDetail(selected,{members:next.members??[],pending:next.invitations??[]});setDetailError(null);}}
   catch(e){if(alive&&current===cacheEpoch)setDetailError({team:selected,text:message(e)});}
   finally{if(alive){if(first){first=false;setDetailLoading(t=>t===selected?'':t);}timer=setTimeout(load,DETAIL_POLL_MS);}}
  };
  void load();return()=>{alive=false;clearTimeout(timer);};
 },[selected,epoch,retry,storeDetail]);

 async function action(body:unknown){const current=cacheEpoch;setBusy(true);setActionError('');try{const result=await request<{emailSent?:boolean;alreadyInvited?:boolean}>(body);if(current!==cacheEpoch)return null;await loadDirectory();return current===cacheEpoch?result:null;}catch(e){if(current===cacheEpoch)setActionError(message(e));return null;}finally{if(current===cacheEpoch)setBusy(false);}}
 const patchDetail=(update:(d:Detail)=>Detail)=>{const base=cache.details[selected];if(base)storeDetail(selected,update(base));};

 const firstLoad=!directory&&listLoading&&!listError;
 const refreshing=!!directory&&(listLoading||(!!detail&&detailLoading===selected));
 const signedOut=!directory&&!!listError&&/sign in/i.test(listError);
 const peopleError=detailError?.team===selected?detailError.text:'';
 const shownError=directory?(listError||peopleError):'';
 const self=members.find(m=>m.id===selfId);
 const unread=useSyncExternalStore(subscribeTeamUnread,getUnreadSummary);
 const unreadFor=(teamId:string)=>(selfId&&unread[`${selfId}:${teamId}`])||NO_UNREAD;
 const here=unreadFor(selected);
 const elsewhere=teams.reduce((sum,t)=>t.id===selected?sum:sum+unreadFor(t.id).total,0);
 const others=members.filter(m=>m.id!==selfId);

 return <section className="team-hub" aria-label="Teams" aria-busy={firstLoad||refreshing}>
  <header className="team-hub-head">
   <h2>Teams</h2>
   {refreshing&&<span className="team-hub-sync" role="status" aria-label="Refreshing"/>}
   <Button icon size="sm" variant="ghost" aria-label="Account" title="Account" aria-pressed={account} onClick={()=>setAccount(!account)}><AccountIcon/></Button>
  </header>
  {account&&<AccountSettings/>}

  {firstLoad&&<div className="team-hub-loading"><span role="status" className="team-hub-sr">Loading teams…</span><div className="team-hub-picker"><span className="team-skel-select"/></div><SkeletonRows count={4}/></div>}

  {!directory&&listError&&!listLoading&&<div className="team-hub-state" role="alert"><p>{signedOut?'Sign in to see your teams and message teammates.':`Couldn't load teams. ${listError}`}</p>{signedOut?<Button size="sm" variant="accent" onClick={()=>setAccount(true)}>Sign in</Button>:<Button size="sm" onClick={()=>setRetry(r=>r+1)}>Retry</Button>}</div>}

  {shownError&&<div className="team-hub-banner" role="alert"><span>Couldn't refresh. {shownError}</span><Button size="sm" variant="ghost" onClick={()=>setRetry(r=>r+1)}>Retry</Button></div>}
  {actionError&&<p role="alert" className="team-hub-error">{actionError}</p>}{notice&&<p role="status" className="team-hub-notice">{notice}</p>}

  {invitations.map(i=><div className="team-hub-invite" key={i.id}><span>Invited to <strong>{i.name}</strong></span><Button size="sm" variant="accent" disabled={busy} onClick={()=>void action({action:'accept',invitationId:i.id})}>Join</Button></div>)}

  {directory&&teams.length>0&&<div className="team-hub-picker">
   <Select size="sm" width="full" aria-label="Team" value={selected} onChange={e=>setSelected(e.target.value)}>{teams.map(t=>{const n=unreadFor(t.id).total;return <option key={t.id} value={t.id}>{n?`${t.name} · ${badgeLabel(n)} unread`:t.name}</option>;})}</Select>
   {elsewhere>0&&<span className="team-hub-picker-dot" role="img" aria-label={`${elsewhere} unread in other teams`} title={`${elsewhere} unread in other teams`}/>}
   <Button icon size="sm" variant="ghost" aria-label="Manage teams" title={manage?'Back to team':'Manage teams'} aria-pressed={manage} onClick={()=>setManage(!manage)}><SettingsIcon size={14}/></Button>
  </div>}

  {directory&&(manage||!teams.length)&&<div className="team-hub-management">
   {!teams.length&&<p className="team-hub-muted">You're not in a team yet. Create one, or ask an organization admin to invite you.</p>}
   <h3>Create a team</h3>
   <form onSubmit={e=>{e.preventDefault();void action({action:'organization-team-create',organizationId:organization,name}).then(r=>{if(r)setName('');});}}>
    <Select size="sm" width="full" aria-label="Team organization" value={organization} onChange={e=>setOrganization(e.target.value)}><option value="" disabled>Choose an organization</option>{organizations.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</Select>
    <div className="team-hub-inline"><TextInput aria-label="Team name" placeholder="Team name" value={name} onChange={e=>setName(e.target.value)} maxLength={80}/><Button size="sm" disabled={busy||!name.trim()||!organization} type="submit">Create team</Button></div>
   </form>
   <p className="team-hub-muted">Teams belong to an organization. Organization owners and admins manage their people and workspace access.</p>
   {team&&team.role!=='member'&&<>
    <h3>Invite to {team.name}</h3>
    <form onSubmit={e=>{e.preventDefault();void action({action:'invite',teamId:selected,email}).then(r=>{if(r){setNotice(r.emailSent===false?'Invitation saved. Email delivery failed; they can sign in to accept.':r.alreadyInvited?'An invitation is already waiting for this person.':'Invitation sent.');setEmail('');}});}}><div className="team-hub-inline"><TextInput aria-label="Teammate email" type="email" placeholder="name@company.com" value={email} onChange={e=>setEmail(e.target.value)}/><Button size="sm" type="submit" disabled={busy||!email}>Invite</Button></div></form>
    <p className="team-hub-muted">Joining enables messaging. Workspace access is granted separately.</p>
    {pending.map(i=><div key={i.id} className="team-row"><Avatar person={{id:i.id,email:i.email}}/><span className="team-row-text"><strong>{i.email}</strong><small>Invited</small></span><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void action({action:'revoke-invitation',teamId:selected,invitationId:i.id}).then(()=>patchDetail(d=>({...d,pending:d.pending.filter(x=>x.id!==i.id)})))}>Revoke</Button></div>)}
   </>}
   {team&&<>
    <h3>Members</h3>
    {!detail?<SkeletonRows count={3}/>:members.map(m=><div key={m.id} className="team-row"><Avatar person={m}/><span className="team-row-text"><strong>{displayName(m)}{m.id===selfId&&<em> (you)</em>}</strong><small>{m.role}</small></span>{team.role==='owner'&&m.role!=='owner'&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void action({action:'remove',teamId:selected,userId:m.id}).then(r=>{if(r)patchDetail(d=>({...d,members:d.members.filter(x=>x.id!==m.id)}));})}>Remove</Button>}</div>)}
   </>}
  </div>}

  {team&&!manage&&<nav className="team-directory" aria-label="Conversations">
   <h3 className="team-hub-section">Channel</h3>
   <button className={`team-row${here.channel?' is-unread':''}`} disabled={!onOpenChat} onClick={()=>onOpenChat?.({teamId:selected,userId:selfId,peer:null,name:team.name})}><span aria-hidden="true" className="team-avatar team-avatar-channel">#</span><span className="team-row-text"><strong>{team.name}</strong><small>Everyone in this team</small></span><UnreadPill count={here.channel} label="in the channel"/></button>
   <h3 className="team-hub-section">People{detail&&<span> · {members.length}</span>}</h3>
   {!detail?(peopleError?null:<SkeletonRows count={3}/>):<>
    {self&&<div className="team-row team-row-self"><Avatar person={self}/><span className="team-row-text"><strong>{displayName(self)} <em>(you)</em></strong>{secondaryEmail(self)&&<small>{secondaryEmail(self)}</small>}</span>{self.role!=='member'&&<span className="team-role">{self.role}</span>}</div>}
    {others.map(m=>{const n=here.peers[m.id]??0;return <button key={m.id} className={`team-row${n?' is-unread':''}`} disabled={!onOpenChat} onClick={()=>onOpenChat?.({teamId:selected,userId:selfId,peer:m.id,name:displayName(m),email:m.email})}><Avatar person={m}/><span className="team-row-text"><strong>{displayName(m)}</strong>{secondaryEmail(m)&&<small>{secondaryEmail(m)}</small>}</span>{m.role!=='member'&&<span className="team-role">{m.role}</span>}<UnreadPill count={n} label={`from ${displayName(m)}`}/></button>;})}
    {!others.length&&<p className="team-hub-muted">No teammates yet.{team.role!=='member'?' Invite people from Manage.':''}</p>}
   </>}
   {!onOpenChat&&<p className="team-hub-muted">Open Teams in the sidebar to start a conversation.</p>}
  </nav>}
 </section>;
}
