import {useEffect,useRef,useState} from 'react';
import {Dialog} from './Dialog';
import {Checkbox,Radio,Select} from './ui';
import {activeWorkspace} from '../remoteExecution/workspace';
import {copyReadableLink} from '../readableLinks';
import {SHARE_TERMINAL_EVENT,SHARED_SESSIONS_CHANGED,shareAvailability,type Publication,type ShareableTerminal} from './shareTerminal';
import './sharedSessions.css';
type Project={id:string;name:string};
type Done={title:string;text:string};
const message=(e:unknown)=>(e instanceof Error?e.message:String(e)).replace(/^Error:\s*/,'');
/** Share one terminal with teammates. Opened on a terminal it has no picker;
 * opened from the Team panel it lists the workspace's running terminals.
 * Watch only publishes that terminal; Pair starts a clean collaboration shell,
 * because the workspace only lets people type in one of those. */
export function ShareTerminalSheet({terminal,onClose}:{terminal:ShareableTerminal|null;onClose:()=>void}){
 const available=shareAvailability();
 const [running,setRunning]=useState<ShareableTerminal[]|null>(terminal?[terminal]:null),[picked,setPicked]=useState<ShareableTerminal|null>(terminal);
 const [catalog,setCatalog]=useState<Project[]|null>(null),[projectChoice,setProjectChoice]=useState('');
 const [mode,setMode]=useState<'view'|'pair'>('view'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState<Done|null>(null);
 const alive=useRef(true);useEffect(()=>()=>{alive.current=false;},[]);
 const workspaceId=available.ok?available.workspaceId:'';
 useEffect(()=>{
  const client=activeWorkspace()?.client;if(!workspaceId||!client)return;
  void client.workspace<{projects:Project[]}>(workspaceId,'/projects').then(r=>{if(alive.current)setCatalog(r.projects??[]);},e=>{if(alive.current){setCatalog([]);setError(message(e));}});
  if(!terminal)void client.workspace<{id:number;title:string;exitCode:number|null}[]>(workspaceId,'/sessions').then(list=>{if(alive.current)setRunning(list.filter(s=>s.exitCode==null).map(s=>({sessionId:s.id,title:s.title})));},e=>{if(alive.current){setRunning([]);setError(message(e));}});
 },[workspaceId,terminal]);
 const target=terminal??picked;
 const derived=catalog?(catalog.find(p=>p.id===target?.projectId)??catalog.find(p=>!!target?.projectName&&p.name===target.projectName)??(catalog.length===1?catalog[0]:undefined)):undefined;
 const project=derived??catalog?.find(p=>p.id===projectChoice);
 const title=(mode==='view'?target?.title:target?.title||(project?`Pair on ${project.name}`:''))?.trim().slice(0,80)||'Shared terminal';
 const ready=available.ok&&!!project&&(mode==='pair'||!!target)&&!busy;
 async function share(){
  const client=activeWorkspace()?.client;if(!ready||!client||!project)return;
  setBusy(true);setError('');
  try{
   const result=await client.workspace<{sessions:Publication[]}>(workspaceId,'/shared-sessions',mode==='view'?{action:'publish',sessionId:target!.sessionId,projectId:project.id,title,mode:'view',acknowledged:true}:{action:'create',projectId:project.id,title});
   window.dispatchEvent(new Event(SHARED_SESSIONS_CHANGED));
   const sessions=result?.sessions??[];
   const p=mode==='view'?sessions.find(s=>s.sessionId===target!.sessionId&&!s.collaborative):sessions.filter(s=>s.collaborative&&s.title===title).sort((a,b)=>b.expiresAt-a.expiresAt)[0];
   if(!p){if(alive.current)setDone({title,text:'Shared. Copy its link from Live now under Team.'});return;}
   try{await copyReadableLink({kind:'session',workspaceId,projectId:p.projectId,publicationId:p.id,title:p.title});if(alive.current)setDone({title,text:'Shared. Link copied. Paste it to your team.'});}
   catch(e){if(alive.current)setDone({title,text:`Shared, but the link wasn't copied: ${message(e)}`});}
  }catch(e){if(alive.current)setError(message(e));}
  finally{if(alive.current)setBusy(false);}
 }
 const heading=terminal?`Share “${terminal.title}”`:'Share a terminal';
 if(!available.ok)return <Dialog title={heading} body={available.reason} dismissLabel="Close" onDismiss={onClose}/>;
 if(done)return <Dialog title={heading} variant="accent" actions={[{label:'Done',primary:true,onClick:onClose}]} onDismiss={onClose}><p role="status" className="share-sheet-done"><strong>{done.title}</strong> {done.text} It's listed under Team → Live now.</p></Dialog>;
 return <Dialog title={heading} size="md" dismissLabel="Cancel" onDismiss={onClose} actions={[{label:busy?'Sharing…':'Share + copy link',primary:true,disabled:!ready,onClick:()=>void share()}]}>
  <div className="share-sheet">
   {!terminal&&mode==='view'&&<><span className="share-sheet-label" id="share-terminal-label">Terminal</span><div className="share-terminal-list" role="group" aria-labelledby="share-terminal-label">
    {running===null?<span className="share-sheet-note" role="status">Loading terminals…</span>:!running.length?<span className="share-sheet-note">No running terminals in this workspace.</span>:running.map(t=><button type="button" key={t.sessionId} className={`share-terminal-card${picked?.sessionId===t.sessionId?' is-picked':''}`} aria-pressed={picked?.sessionId===t.sessionId} onClick={()=>setPicked(t)}><strong>{t.title}</strong><small>Terminal {t.sessionId}</small></button>)}
   </div></>}
   <span className="share-sheet-label">Who sees it</span>
   {/* Visibility follows project access in the workspace; there is no per-share audience to pick, so this says who rather than offering a choice that changes nothing. */}
   <div className="share-sheet-control"><span className="share-sheet-value">Everyone who can open {project?.name??'this project'} in {available.workspaceName}</span>
    <small className="share-sheet-note">They find it under Team → Live now. Change who that is in the workspace's Access tab.</small></div>
   {catalog!==null&&!derived&&<><span className="share-sheet-label">Project</span><div className="share-sheet-control"><Select size="sm" width="full" aria-label="Project" value={projectChoice} onChange={e=>setProjectChoice(e.target.value)}><option value="" disabled>Choose a project</option>{catalog.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></div></>}
   <span className="share-sheet-label">Access</span>
   <div className="share-sheet-control share-sheet-modes" role="radiogroup" aria-label="Access">
    <Radio name="share-mode" checked={mode==='view'} onChange={()=>setMode('view')} label="Watch only" hint="They see this terminal live. Only you type."/>
    <Radio name="share-mode" checked={mode==='pair'} onChange={()=>setMode('pair')} label="Pair (can type)" hint="Everyone types in one shell."/>
    {mode==='pair'&&<Checkbox checked disabled onChange={()=>{}} label="Start a clean shell instead (no Git or agent logins, ends after 1 hour)" hint="Typing in an existing terminal isn't available, so Pair always starts a clean shell in this project. Anyone invited can edit its files."/>}
   </div>
   <span/><small className="share-sheet-note">{mode==='view'?'Viewers see earlier output too.':'The shell ends after 1 hour, or when you stop sharing.'}</small>
   {error&&<><span/><p role="alert" className="share-sheet-error">{error}</p></>}
  </div>
 </Dialog>;
}
/** One sheet for the whole window, opened by `shareTerminal()`. */
export function ShareTerminalHost(){
 const [request,setRequest]=useState<{terminal:ShareableTerminal|null;nonce:number}|null>(null);
 useEffect(()=>{const open=(e:Event)=>setRequest({terminal:(e as CustomEvent<ShareableTerminal|null>).detail??null,nonce:Date.now()});const reset=()=>setRequest(null);window.addEventListener(SHARE_TERMINAL_EVENT,open);window.addEventListener('canopy:account-changed',reset);return()=>{window.removeEventListener(SHARE_TERMINAL_EVENT,open);window.removeEventListener('canopy:account-changed',reset);};},[]);
 return request?<ShareTerminalSheet key={request.nonce} terminal={request.terminal} onClose={()=>setRequest(null)}/>:null;
}
