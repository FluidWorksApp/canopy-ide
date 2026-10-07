import {useCallback,useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import * as ipc from '../ipc';
import type {AccountStatus,AgentProfile} from '../ipc';
import {activeProfile,setActiveProfile,PROFILE_CHANGE_EVENT} from '../profiles';
import {Button,Checkbox} from '../components/ui';
import {agentCliFor} from '../projects';
import {signedInClis,signedOutClis,syncNotice,type ImportResult} from '../accountState';

type Accounts=Record<string,AccountStatus[]>;
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
   setNotice(syncNotice(result,local?.profiles??[]));
   await refreshRemote();window.dispatchEvent(new CustomEvent(PROFILE_CHANGE_EVENT,{detail:{profileId:activeProfile()}}));
  }catch(e){setError(String(e));}finally{setBusy(false);}
 }
 if(!local)return <div className="workspace-loading" role="status"><span className="workspace-skeleton short"/>Reading accounts on this Mac…</div>;
 const synced=new Set(Object.values(local.candidates).flatMap(agentsIn));
 // Both sides read through accountState, the same reading as the status-bar
 // switcher and Settings → Accounts: a stored, usable login, not a record.
 const remoteHeld=(id:string)=>remote?.profiles.some(p=>p.id===id)?signedInClis(remote.accounts[id]).filter(agent=>synced.has(agent)):null;
 const syncable=local.profiles.filter(p=>withState(local.candidates[p.id],'ready').length);
 const count=[...selected].filter(id=>syncable.some(p=>p.id===id)).length;
 return <div className="account-sync">
  <ul className="account-sync-list" aria-label="Agent accounts">{local.profiles.map(p=>{
   const candidate=local.candidates[p.id],copyable=withState(candidate,'ready'),stale=withState(candidate,'incomplete'),there=remoteHeld(p.id),canSync=copyable.length>0;
   const here=signedInClis(local.accounts[p.id]),lostHere=signedOutClis(local.accounts[p.id]);
   const email=(agent:string)=>local.accounts[p.id]?.find(s=>s.agent===agent)?.account;
   const hint=[...copyable.map(agent=>`${agentName(agent)}${email(agent)?` · ${email(agent)}`:''}`),...stale.map(agent=>`${agentName(agent)} · signed out on this Mac${email(agent)?` (was ${email(agent)})`:''}, sign in again here`)].join('  ·  ')||'No Claude or Codex login on this Mac';
   // A workspace copy of a login this Mac has lost is the workspace's own now.
   const onlyThere=(there??[]).filter(agent=>!here.includes(agent)&&(lostHere.includes(agent)||stale.includes(agent)));
   const stateText=there===null?'Not in workspace':there.length?`Ready · ${there.map(agentName).join(', ')}${onlyThere.length?` (signed out on this Mac: ${onlyThere.map(agentName).join(', ')})`:''}`:'Signed out';
   return <li key={p.id} className={`account-sync-row${p.id===active?' is-active':''}`}>
    <Checkbox checked={canSync&&selected.has(p.id)} disabled={!canSync||busy} onChange={on=>setSelected(prev=>{const next=new Set(prev);if(on)next.add(p.id);else next.delete(p.id);return next;})} label={p.label} hint={hint}/>
    <span className={`account-sync-state ${there===null?'quiet':there.length?'running':'attention'}`}>{stateText}</span>
    {p.id===active?<span className="account-sync-active">Active</span>:<Button size="sm" variant="ghost" disabled={there===null} title={there===null?'Sync this account first':`New agents in ${workspaceName} launch as ${p.label}`} onClick={()=>setActiveProfile(p.id)}>Use</Button>}
   </li>;})}</ul>
  <div className="account-sync-footer">
   <small>Syncing replaces the workspace copy with this Mac’s current login. A copied Claude or Codex login shares one renewable token with this Mac: when either side renews it, the other can be signed out. For an account you use on both, sign in inside the workspace instead.</small>
   <Button variant="accent" disabled={busy||!count} onClick={()=>void sync()}>{busy?'Syncing…':`Sync ${count} account${count===1?'':'s'}`}</Button>
  </div>
  {notice&&<p className="workspace-feedback" role="status">✓ {notice}</p>}
  {error&&<p className="workspace-feedback error" role="alert">{error}</p>}
 </div>;
}

