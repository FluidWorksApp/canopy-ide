import type {AccountConversation} from './AccountChatView';
import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button,TextInput} from './ui';
import {AccountSettings} from './AccountSettings';
import './teamHub.css';
type Team={id:string;name:string;role:string;organization_id?:string|null};
type Organization={id:string;name:string;role:string};
type Member={id:string;name:string;email:string;role:string};
type Invite={id:string;name:string;email?:string};

const request=<T,>(body?:unknown)=>invoke<T>('canopy_account_request',{route:'/api/teams',body:body??null});
export function TeamHub({onOpenChat}:{onOpenChat?:(conversation:AccountConversation)=>void}){
 const [teams,setTeams]=useState<Team[]>([]),[invitations,setInvitations]=useState<Invite[]>([]),[selected,setSelected]=useState('');
 const [organizations,setOrganizations]=useState<Organization[]>([]),[organization,setOrganization]=useState('');
 const [members,setMembers]=useState<Member[]>([]),[pending,setPending]=useState<Invite[]>([]);
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[account,setAccount]=useState(false),[manage,setManage]=useState(false);
 const generation=useRef(0);
 const accountEpoch=useRef(0);
 const [selfId,setSelfId]=useState('');
 const team=teams.find(t=>t.id===selected);
 useEffect(()=>{const changed=()=>{accountEpoch.current++;generation.current++;setTeams([]);setMembers([]);setPending([]);setInvitations([]);setSelected('');setOrganizations([]);setOrganization('');setSelfId('');setNotice('');setName('');setEmail('');setBusy(false);setError('Sign in to access your teams.');};window.addEventListener('canopy:account-changed',changed);return()=>window.removeEventListener('canopy:account-changed',changed);},[]);
 async function refresh(){const epoch=accountEpoch.current;const [data,orgData]=await Promise.all([request<{teams:Team[];invitations:Invite[];selfId:string}>(),request<{organizations:Organization[]}>({action:'organization-list'})]);if(epoch!==accountEpoch.current)return;setSelfId(data.selfId);setTeams(data.teams);setInvitations(data.invitations);setSelected(current=>data.teams.some(t=>t.id===current)?current:data.teams[0]?.id??'');const options=(orgData.organizations??[]).filter(o=>o.role==='owner'||o.role==='admin');setOrganizations(options);setOrganization(current=>options.some(o=>o.id===current)?current:options[0]?.id??'');}
 useEffect(()=>{let alive=true;const load=()=>{if(alive)void refresh().catch(e=>{if(alive)setError(String(e));});};load();const timer=setInterval(load,15000);return()=>{alive=false;clearInterval(timer);};},[]);
 useEffect(()=>{const current=++generation.current;setMembers([]);setPending([]);if(!selected)return;let timer:ReturnType<typeof setTimeout>;let alive=true;
  const load=async()=>{try{const detail=await request<{members:Member[];invitations:Invite[]}>({action:'detail',teamId:selected});if(alive&&generation.current===current){setMembers(detail.members);setPending(detail.invitations);setError('');}}catch(e){if(alive&&generation.current===current){setError(String(e));}}finally{if(alive)timer=setTimeout(load,3000);}};void load();return()=>{alive=false;clearTimeout(timer);};
 },[selected]);
 async function action(body:unknown){const epoch=accountEpoch.current;setBusy(true);setError('');try{const result=await request<{emailSent?:boolean;alreadyInvited?:boolean}>(body);if(epoch!==accountEpoch.current)return null;await refresh();return epoch===accountEpoch.current?result:null;}catch(e){if(epoch===accountEpoch.current)setError(String(e));return null;}finally{if(epoch===accountEpoch.current)setBusy(false);}}
 return <section className="team-hub" aria-label="Teams">
  <header className="team-hub-head"><div><small>YOUR PEOPLE</small><h2>Teams</h2></div><Button size="sm" onClick={()=>setAccount(!account)}>Account</Button></header>
  {account&&<AccountSettings/>}
  {error&&<p role="alert" className="team-hub-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {invitations.map(i=><div className="team-hub-invite" key={i.id}><span>Invitation to <strong>{i.name}</strong></span><Button disabled={busy} onClick={()=>void action({action:'accept',invitationId:i.id})}>Join team</Button></div>)}
  <div className="team-hub-picker"><label>Team<select value={selected} onChange={e=>{setSelected(e.target.value);}}><option value="" disabled>Choose a team</option>{teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><Button size="sm" onClick={()=>setManage(!manage)}>{manage?'Back to team':'Manage'}</Button></div>
  {(manage||!teams.length)&&<div className="team-hub-management"><h3>Create a team</h3><form onSubmit={e=>{e.preventDefault();void action({action:'organization-team-create',organizationId:organization,name}).then(r=>{if(r)setName('');});}}><label>Organization<select aria-label="Team organization" value={organization} onChange={e=>setOrganization(e.target.value)}><option value="" disabled>Choose an organization</option>{organizations.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label><TextInput aria-label="Team name" placeholder="Team name" value={name} onChange={e=>setName(e.target.value)} maxLength={80}/><Button disabled={busy||!name.trim()||!organization} type="submit">Create team</Button></form><p className="team-hub-muted">Teams belong to an organization. Organization owners and admins manage their people and workspace access.</p>
   {team&&team.role!=='member'&&<><h3>Invite a teammate</h3><form onSubmit={e=>{e.preventDefault();void action({action:'invite',teamId:selected,email}).then(r=>{if(r){setNotice(r.emailSent===false?'Invitation saved. Email delivery failed; they can sign in to accept.':r.alreadyInvited?'An invitation is already waiting for this person.':'Invitation sent.');setEmail('');}});}}><TextInput aria-label="Teammate email" type="email" placeholder="name@company.com" value={email} onChange={e=>setEmail(e.target.value)}/><Button type="submit" disabled={busy||!email}>Invite</Button></form><p className="team-hub-muted">Joining enables messaging. Workspace access is granted separately.</p>{pending.map(i=><div key={i.id} className="team-hub-member"><span>{i.email}<small>Invited</small></span><Button size="sm" disabled={busy} onClick={()=>void action({action:'revoke-invitation',teamId:selected,invitationId:i.id}).then(()=>setPending(p=>p.filter(x=>x.id!==i.id)))}>Revoke</Button></div>)}</>}
   {members.map(m=><div key={m.id} className="team-hub-member"><span><strong>{m.name}</strong><small>{m.email} · {m.role}</small></span>{team?.role==='owner'&&m.role!=='owner'&&<Button size="sm" disabled={busy} onClick={()=>void action({action:'remove',teamId:selected,userId:m.id}).then(r=>{if(r)setMembers(v=>v.filter(x=>x.id!==m.id));})}>Remove</Button>}</div>)}
  </div>}
  {team&&!manage&&<nav className="team-directory" aria-label="Conversations">
   <small>CHANNEL</small><button disabled={!onOpenChat} onClick={()=>onOpenChat?.({teamId:selected,userId:selfId,peer:null,name:team.name})}><span aria-hidden="true" className="team-avatar">#</span><span><strong>{team.name}</strong><small>Everyone in this team</small></span></button>
   <small>PEOPLE · {members.length}</small>{members.filter(m=>m.id!==selfId).map(m=><button key={m.id} disabled={!onOpenChat} onClick={()=>onOpenChat?.({teamId:selected,userId:selfId,peer:m.id,name:m.name,email:m.email})}><span aria-hidden="true" className="team-avatar">{m.name.slice(0,1).toUpperCase()}</span><span><strong>{m.name}</strong><small>{m.email}</small></span></button>)}
   {!onOpenChat&&<p className="team-hub-muted">Open Teams in the sidebar to start a conversation.</p>}
  </nav>}
 </section>;
}
