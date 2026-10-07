import {useCallback,useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import * as ipc from '../ipc';
import type {AccountStatus,AgentProfile} from '../ipc';
import {activeProfile,setActiveProfile,PROFILE_CHANGE_EVENT} from '../profiles';
import {Button,Checkbox} from '../components/ui';
import {agentCliFor} from '../projects';

type Accounts=Record<string,AccountStatus[]>;
type ImportResult={imported?:string[];updated?:string[];skipped?:string[];skippedProfiles?:string[];incomplete?:string[]};
/** What this Mac can actually copy per account; never a credential. */
type LoginState='ready'|'incomplete'|'none'|'unavailable';
type Candidate={id:string}&Record<string,LoginState|string>;
// Which CLIs can be copied is the Mac's answer (execution_remote_account_candidates),
// so no vendor list lives here.
const agentsIn=(c:Candidate|undefined)=>c?Object.keys(c).filter(key=>key!=='id'):[];
const withState=(c:Candidate|undefined,state:LoginState)=>agentsIn(c).filter(agent=>c![agent]===state);
const agentName=(agent:string)=>agentCliFor(agent)?.name??agent;

async function readProfiles(list:()=>Promise<AgentProfile[]>,accounts:(id:string)=>Promise<AccountStatus[]>){
 const profiles=await list();
 const entries=await Promise.all(profiles.map(async p=>[p.id,await accounts(p.id).catch(()=>[] as AccountStatus[])] as const));
 return {profiles,accounts:Object.fromEntries(entries) as Accounts};
}

/** Local accounts → this workspace. The local side is read straight from this
 * Mac (raw Tauri invoke); the workspace side goes through the active host. */
export function AccountSync({workspaceName}:{workspaceName:string}){
 const [local,setLocal]=useState<{profiles:AgentProfile[];accounts:Accounts;candidates:Record<string,Candidate>}|null>(null);
 const [remote,setRemote]=useState<{profiles:AgentProfile[];accounts:Accounts}|null>(null);
 const [selected,setSelected]=useState<Set<string>>(new Set());
 const [active,setActive]=useState(activeProfile());
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const refreshRemote=useCallback(()=>readProfiles(ipc.profilesList,ipc.profileAccounts).then(setRemote).catch(()=>setRemote({profiles:[],accounts:{}})),[]);
 useEffect(()=>{
  let stale=false;
  void Promise.all([readProfiles(()=>invoke<AgentProfile[]>('profiles_list'),id=>invoke<AccountStatus[]>('profile_accounts',{id})),invoke<Candidate[]>('execution_remote_account_candidates').catch(()=>[] as Candidate[])]).then(([result,list])=>{
   if(stale)return;const candidates=Object.fromEntries((list??[]).map(c=>[c.id,c]));
   setLocal({...result,candidates});setSelected(new Set(result.profiles.filter(p=>withState(candidates[p.id],'ready').length).map(p=>p.id)));
  }).catch(()=>{if(!stale)setLocal({profiles:[],accounts:{},candidates:{}});});
  void refreshRemote();
  const changed=()=>setActive(activeProfile());window.addEventListener(PROFILE_CHANGE_EVENT,changed);
  return()=>{stale=true;window.removeEventListener(PROFILE_CHANGE_EVENT,changed);};
 },[refreshRemote]);
 async function sync(){
  setBusy(true);setError('');setNotice('');
  try{
   const result=await invoke<ImportResult>('execution_remote_import_accounts',{profiles:[...selected]});
   // The default account reports agent names; named profiles report labels.
   const label=(id:string)=>agentCliFor(id)?local?.profiles.find(p=>p.id==='default')?.label??'Default':local?.profiles.find(p=>p.id===id||p.label===id)?.label??id;
   const done=[...new Set([...(result.imported??[]),...(result.updated??[])])];
   setNotice(`${done.length?`Synced ${done.map(label).join(', ')}.`:'Accounts synced.'}${result.incomplete?.length?` Not copied, sign in again on this Mac first: ${result.incomplete.join(', ')}.`:''}`);
   await refreshRemote();window.dispatchEvent(new CustomEvent(PROFILE_CHANGE_EVENT,{detail:{profileId:activeProfile()}}));
  }catch(e){setError(String(e));}finally{setBusy(false);}
 }
 if(!local)return <div className="workspace-loading" role="status"><span className="workspace-skeleton short"/>Reading accounts on this Mac…</div>;
 const synced=new Set(Object.values(local.candidates).flatMap(agentsIn));
 const remoteHeld=(id:string)=>remote?.profiles.some(p=>p.id===id)?(remote.accounts[id]??[]).filter(s=>synced.has(s.agent)&&s.state==='in'):null;
 const syncable=local.profiles.filter(p=>withState(local.candidates[p.id],'ready').length);
 const count=[...selected].filter(id=>syncable.some(p=>p.id===id)).length;
 return <div className="account-sync">
  <ul className="account-sync-list" aria-label="Agent accounts">{local.profiles.map(p=>{
   const candidate=local.candidates[p.id],copyable=withState(candidate,'ready'),stale=withState(candidate,'incomplete'),there=remoteHeld(p.id),canSync=copyable.length>0;
   const email=(agent:string)=>local.accounts[p.id]?.find(s=>s.agent===agent)?.account;
   const hint=[...copyable.map(agent=>`${agentName(agent)}${email(agent)?` · ${email(agent)}`:''}`),...stale.map(agent=>`${agentName(agent)} · expired here, run /login on this Mac`)].join('  ·  ')||'No Claude or Codex login on this Mac';
   return <li key={p.id} className={`account-sync-row${p.id===active?' is-active':''}`}>
    <Checkbox checked={canSync&&selected.has(p.id)} disabled={!canSync||busy} onChange={on=>setSelected(prev=>{const next=new Set(prev);if(on)next.add(p.id);else next.delete(p.id);return next;})} label={p.label} hint={hint}/>
    <span className={`account-sync-state ${there===null?'quiet':there.length?'running':'attention'}`}>{there===null?'Not in workspace':there.length?`Ready · ${there.map(s=>agentName(s.agent)).join(', ')}`:'Signed out'}</span>
    {p.id===active?<span className="account-sync-active">Active</span>:<Button size="sm" variant="ghost" disabled={there===null} title={there===null?'Sync this account first':`New agents in ${workspaceName} launch as ${p.label}`} onClick={()=>setActiveProfile(p.id)}>Use</Button>}
   </li>;})}</ul>
  <div className="account-sync-footer">
   <small>Syncing replaces the workspace copy with this Mac’s current login. If an agent in the workspace asks you to sign in, sync again.</small>
   <Button variant="accent" disabled={busy||!count} onClick={()=>void sync()}>{busy?'Syncing…':`Sync ${count} account${count===1?'':'s'}`}</Button>
  </div>
  {notice&&<p className="workspace-feedback" role="status">✓ {notice}</p>}
  {error&&<p className="workspace-feedback error" role="alert">{error}</p>}
 </div>;
}
