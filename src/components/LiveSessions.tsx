import {useCallback,useEffect,useRef,useState} from 'react';
import {activeWorkspace} from '../remoteExecution/workspace';
import {isAccountWorkspace,isMemberConnection} from '../remoteExecution/accountWorkspace';
import {RemoteTerminal} from '../remoteExecution/RemoteTerminal';
import {sharedSessionClient} from '../remoteExecution/sharedSessionClient';
import {peekWorkspaceList,refreshWorkspaceList,subscribeWorkspaceList} from '../remoteExecution/workspaceListCache';
import type {ManagedWorkspace} from '../remoteExecution/ManagedWorkspaces';
import type {RemoteExecutionClient} from '../remoteExecution/client';
import {SHARED_SESSION_FOCUS_EVENT,takeAnyPendingSession} from '../readableLinks';
import {openSessionDoc} from '../sessionDoc/events';
import {liveTeamSessions} from '../teamMessaging/session';
import {Dialog} from './Dialog';
import {Button} from './ui';
import {CopyLinkButton} from './CopyLinkButton';
import {SHARED_SESSIONS_CHANGED,shareAvailability,shareTerminal,type Publication} from './shareTerminal';
import './sharedSessions.css';
type Space={id:string;name:string;owner:boolean};
type Row=Publication&{space:Space};
const POLL_MS=5000;
/** The live session a shared terminal belongs to, when this account is in the
 * owner's team and is not the owner. */
function liveRoom(p:Publication){
 const room=p.room,team=room&&liveTeamSessions().find(s=>s.team===room.team);
 if(!room||!team||team.user===room.owner)return null;
 return {ownerName:team.members()[room.owner],join:(workspaceId:string)=>openSessionDoc({kind:'join',team:room.team,owner:room.owner,ownerName:team.members()[room.owner],room:room.id,title:p.title,agent:'agent',terminal:{workspace:workspaceId,publication:p.id}})};
}
/** Running Canopy workspaces this account can see, plus the connected one. */
function spaces(list:ManagedWorkspace[]|undefined,extra:string[]):Space[]{
 const host=activeWorkspace(),out=new Map<string,Space>();
 for(const w of list??[])if(w.state==='ready')out.set(w.id,{id:w.id,name:w.name,owner:w.access?.owner===true});
 if(host&&isAccountWorkspace(host.connection)&&!out.has(host.connection.workspaceId))out.set(host.connection.workspaceId,{id:host.connection.workspaceId,name:host.connection.workspaceName,owner:!isMemberConnection(host.connection)&&list?.find(w=>w.id===host.connection.workspaceId)?.access?.owner!==false});
 for(const id of extra)if(!out.has(id))out.set(id,{id,name:list?.find(w=>w.id===id)?.name??'Workspace',owner:false});
 return [...out.values()];
}
/** Team → Live now: every terminal shared with this account, across the
 * workspaces it can see. The owner's own entries come from the connected
 * workspace, the only place the gateway lets them be stopped. */
export function LiveSessions({visible=true}:{visible?:boolean}){
 const [list,setList]=useState(()=>peekWorkspaceList()?.workspaces);
 const [rows,setRows]=useState<Row[]|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[viewing,setViewing]=useState<{row:Row;client:RemoteExecutionClient;writable:boolean}|null>(null);
 const epoch=useRef(0),clients=useRef(new Map<string,Promise<RemoteExecutionClient>>()),extra=useRef<string[]>([]),wanted=useRef<{workspaceId:string;publicationId:string}|null>(null);
 const available=shareAvailability();
 useEffect(()=>{const counter=epoch;const reset=()=>{counter.current++;clients.current=new Map();extra.current=[];wanted.current=null;setRows(null);setList(undefined);setViewing(null);setError('');setBusy('');};window.addEventListener('canopy:account-changed',reset);const off=subscribeWorkspaceList(s=>setList(s.workspaces));void refreshWorkspaceList().catch(()=>{});return()=>{counter.current++;off();window.removeEventListener('canopy:account-changed',reset);};},[]);
 const clientFor=useCallback((space:Space)=>{
  const host=activeWorkspace();if(host?.connection.workspaceId===space.id)return Promise.resolve(host.client);
  let pending=clients.current.get(space.id);const current=epoch.current;
  if(!pending){pending=sharedSessionClient(space.id,()=>current===epoch.current);pending.catch(()=>{if(clients.current.get(space.id)===pending)clients.current.delete(space.id);});clients.current.set(space.id,pending);}
  return pending;
 },[]);
 const refresh=useCallback(async()=>{
  const current=epoch.current,all=spaces(list,extra.current);
  const results=await Promise.all(all.map(async space=>{try{const client=await clientFor(space);const r=await client.workspace<{sessions:Publication[]}>(space.id,'/shared-sessions');return (r?.sessions??[]).map(p=>({...p,space}));}catch{return [] as Row[];}}));
  if(current!==epoch.current)return;
  const next=results.flat();setRows(next);
  const want=wanted.current;
  if(want){wanted.current=null;const row=next.find(r=>r.space.id===want.workspaceId&&r.id===want.publicationId);if(row){const client=await clientFor(row.space).catch(()=>null);if(client&&current===epoch.current)setViewing({row,client,writable:row.mode==='interact'});}else setError("That shared session has ended, or it isn't shared with you.");}
 },[list,clientFor]);
 // A shared session link opens Team on that session (readableLinks.ts).
 useEffect(()=>{const focus=()=>{const pending=takeAnyPendingSession();if(!pending)return;wanted.current=pending;if(!extra.current.includes(pending.workspaceId))extra.current=[...extra.current,pending.workspaceId];setError('');void refresh();};focus();window.addEventListener(SHARED_SESSION_FOCUS_EVENT,focus);return()=>window.removeEventListener(SHARED_SESSION_FOCUS_EVENT,focus);},[refresh]);
 useEffect(()=>{if(!visible)return;void refresh();const timer=setInterval(()=>void refresh(),POLL_MS);const changed=()=>void refresh();window.addEventListener(SHARED_SESSIONS_CHANGED,changed);return()=>{clearInterval(timer);window.removeEventListener(SHARED_SESSIONS_CHANGED,changed);};},[visible,refresh]);
 async function open(row:Row){const room=liveRoom(row);if(room){room.join(row.space.id);return;}setError('');try{const client=await clientFor(row.space);setViewing({row,client,writable:row.mode==='interact'});}catch(e){setError(String(e).replace(/^Error:\s*/,''));}}
 async function stop(row:Row){const host=activeWorkspace();if(host?.connection.workspaceId!==row.space.id)return;const current=epoch.current;setBusy(row.id);setError('');try{const r=await host.client.workspace<{sessions:Publication[]}>(row.space.id,'/shared-sessions',{action:'revoke',id:row.id});if(current!==epoch.current)return;setRows(old=>[...(old??[]).filter(x=>x.space.id!==row.space.id),...(r?.sessions??[]).map(p=>({...p,space:row.space}))]);setViewing(v=>v?.row.id===row.id?null:v);}catch(e){if(current===epoch.current)setError(String(e).replace(/^Error:\s*/,''));}finally{if(current===epoch.current)setBusy('');}}
 const mine=(row:Row)=>row.space.owner&&activeWorkspace()?.connection.workspaceId===row.space.id;
 return <section className="live-sessions" aria-label="Live now">
  <header className="live-sessions-head"><h3>Live now{rows&&rows.length>0&&<span> · {rows.length}</span>}</h3><Button size="sm" variant="accent" disabled={!available.ok} title={available.ok?'Share one of your terminals with your team':available.reason} onClick={()=>shareTerminal()}>Share a terminal</Button></header>
  {!available.ok&&<p className="live-sessions-muted">{available.reason}</p>}
  {error&&<p role="alert" className="live-sessions-error">{error}</p>}
  {rows===null?<p role="status" className="live-sessions-muted">Looking for shared sessions…</p>:!rows.length?<p className="live-sessions-muted">Nothing shared right now. Your terminals stay private until you share one.</p>:<ul className="live-session-list">{rows.map(row=>{const own=mine(row),room=liveRoom(row);return <li key={row.space.id+row.id} className="live-session-row">
   <span className="live-session-text"><strong title={row.title}>{row.title}</strong><small>{own?'You':room?.ownerName??row.space.name} · {row.mode==='interact'?'Can type':'View only'}</small></span>
   <span className="live-session-actions">
    {(!own||row.collaborative)&&<Button size="sm" variant={room||row.mode==='interact'?'accent':undefined} title={room?'Watch this agent session live with its owner':row.mode==='interact'?'Open this shell and type with them':'Watch this terminal live'} onClick={()=>void open(row)}>{room||row.mode==='interact'?'Join':'Watch'}</Button>}
    <CopyLinkButton target={{kind:'session',workspaceId:row.space.id,projectId:row.projectId,publicationId:row.id,title:row.title}}/>
    {own&&<Button size="sm" variant="danger" disabled={busy===row.id} title={row.collaborative?'Stop sharing and end the clean shell':'Stop sharing this terminal'} onClick={()=>void stop(row)}>Stop</Button>}
   </span>
  </li>;})}</ul>}
  {viewing&&<Dialog title={`${viewing.row.title} · ${viewing.writable?'Can type':'View only'}`} size="lg" dismissLabel="Close" onDismiss={()=>setViewing(null)}><div className="live-session-viewer"><RemoteTerminal key={viewing.row.id} client={viewing.client} workspaceId={viewing.row.space.id} sessionId={0} sharedSessionId={viewing.row.id} writable={viewing.writable}/></div></Dialog>}
 </section>;
}
