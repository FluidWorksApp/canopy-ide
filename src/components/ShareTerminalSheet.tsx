import {useEffect,useRef,useState} from 'react';
import {Dialog} from './Dialog';
import {activeWorkspace} from '../remoteExecution/workspace';
import {copyReadableLink} from '../readableLinks';
import {SHARE_TERMINAL_EVENT,SHARED_SESSIONS_CHANGED,shareAvailability,shareableTerminals,terminalLabel,type Publication,type ShareableTerminal} from './shareTerminal';
import './sharedSessions.css';
/** `canPair` (from the host's /projects): false for a project a clean shell
 * can't mount, such as the owner's own projects. Older hosts leave it out. */
type Project={id:string;name:string;canPair?:boolean};
type Done={title:string;text:string};
const message=(e:unknown)=>(e instanceof Error?e.message:String(e)).replace(/^Error:\s*/,'');
/** The host's refusals, in words the person sharing can act on. */
const PLAIN:Record<string,string>={
 'Invalid collaboration project':"Pair isn't available for this project: it needs a shared project teammates can edit. Share it for watching instead.",
 'Invalid session publication':"This project's terminals can't be shared from this workspace yet. The workspace host may need an update.",
 'Session is not running':'That terminal has stopped. Pick one that is still running.',
 'Shared session capacity reached':'Too many terminals are shared right now. Stop sharing one under Team → Live now, then try again.',
 'Workspace is stopped':'The workspace is stopped. Start it, then share again.',
 'Collaboration shell could not start':"The clean shell couldn't start. Try again in a moment.",
 Forbidden:'Only the workspace owner can share its terminals.',
};
const shareError=(e:unknown)=>{const text=message(e);return PLAIN[text]??text;};
/** The shared project a terminal belongs to: its own project, or the shared
 * project mount its cwd is in. None means its project isn't shared. */
function projectOf(catalog:Project[],t:ShareableTerminal){
 return catalog.find(p=>p.id===t.projectId)
  ??catalog.find(p=>!!t.cwd&&(t.cwd===`/workspace/projects/${p.id}`||t.cwd.startsWith(`/workspace/projects/${p.id}/`)))
  ??catalog.find(p=>!!t.projectName&&p.name===t.projectName);
}
const NOT_SHARED='Not shared with your team';
/** Share one terminal with teammates. Opened on a terminal it has no picker;
 * opened from the Team panel it lists the terminal tabs open in this
 * workspace, named as their tabs are ("claude · SuprFlow · main").
 * "Share — they can watch" publishes that terminal; "Pair in a fresh shell"
 * starts a clean collaboration shell in its project, offered only where the
 * workspace supports it (a shared project teammates can edit). */
export function ShareTerminalSheet({terminal,onClose}:{terminal:ShareableTerminal|null;onClose:()=>void}){
 const available=shareAvailability();
 const workspaceId=available.ok?available.workspaceId:'';
 const [open]=useState(()=>{if(terminal||!workspaceId)return [];const seen=new Set<number>();return shareableTerminals(workspaceId).filter(t=>!seen.has(t.sessionId)&&!!seen.add(t.sessionId));});
 // Session ids still running in the workspace; 'unknown' if that list failed.
 const [running,setRunning]=useState<Set<number>|'unknown'|null>(null),[picked,setPicked]=useState<ShareableTerminal|null>(terminal);
 const [catalog,setCatalog]=useState<Project[]|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState<Done|null>(null);
 const alive=useRef(true);useEffect(()=>()=>{alive.current=false;},[]);
 useEffect(()=>{
  const client=activeWorkspace()?.client;if(!workspaceId||!client)return;
  void client.workspace<{projects:Project[]}>(workspaceId,'/projects').then(r=>{if(alive.current)setCatalog(r.projects??[]);},e=>{if(alive.current)setError(shareError(e));});
  if(!terminal)void client.workspace<{id:number;exitCode:number|null}[]>(workspaceId,'/sessions').then(list=>{if(alive.current)setRunning(new Set(list.filter(s=>s.exitCode==null).map(s=>s.id)));},()=>{if(alive.current)setRunning('unknown');});
 },[workspaceId,terminal]);
 const choices=terminal||running===null?null:open.filter(t=>running==='unknown'||running.has(t.sessionId));
 const target=terminal??picked;
 const project=catalog&&target?projectOf(catalog,target):undefined;
 const canPair=!!project&&project.canPair!==false;
 const ready=available.ok&&!!project&&!busy;
 async function share(kind:'watch'|'pair'){
  const client=activeWorkspace()?.client;if(!ready||!client||!project||!target)return;
  const title=(kind==='watch'?terminalLabel(target):`Pair on ${project.name}`).slice(0,80);
  setBusy(true);setError('');
  try{
   const result=await client.workspace<{sessions:Publication[]}>(workspaceId,'/shared-sessions',kind==='watch'?{action:'publish',sessionId:target.sessionId,projectId:project.id,title,mode:'view',acknowledged:true}:{action:'create',projectId:project.id,title});
   window.dispatchEvent(new Event(SHARED_SESSIONS_CHANGED));
   const sessions=result?.sessions??[];
   const p=kind==='watch'?sessions.find(s=>s.sessionId===target.sessionId&&!s.collaborative):sessions.filter(s=>s.collaborative&&s.title===title).sort((a,b)=>b.expiresAt-a.expiresAt)[0];
   if(!p){if(alive.current)setDone({title,text:'Shared. Copy its link from Live now under Team.'});return;}
   try{await copyReadableLink({kind:'session',workspaceId,projectId:p.projectId,publicationId:p.id,title:p.title});if(alive.current)setDone({title,text:'Shared. Link copied. Paste it to your team.'});}
   catch(e){if(alive.current)setDone({title,text:`Shared, but the link wasn't copied: ${message(e)}`});}
  }catch(e){if(alive.current)setError(shareError(e));}
  finally{if(alive.current)setBusy(false);}
 }
 const heading=terminal?`Share “${terminalLabel(terminal)}”`:'Share a terminal';
 if(!available.ok)return <Dialog title={heading} body={available.reason} dismissLabel="Close" onDismiss={onClose}/>;
 if(done)return <Dialog title={heading} variant="accent" actions={[{label:'Done',primary:true,onClick:onClose}]} onDismiss={onClose}><p role="status" className="share-sheet-done"><strong>{done.title}</strong> {done.text} It's listed under Team → Live now.</p></Dialog>;
 const unshared=!!catalog&&!!target&&!project;
 return <Dialog title={heading} size="md" dismissLabel="Cancel" onDismiss={onClose} footnote="Your team sees it under Team → Live now."
  actions={[...(canPair?[{label:'Pair in a fresh shell',disabled:!ready,onClick:()=>void share('pair')}]:[]),{label:busy?'Sharing…':'Share — they can watch',primary:true,disabled:!ready,onClick:()=>void share('watch')}]}>
  <div className="share-sheet">
   {!terminal&&<div className="share-terminal-list" role="group" aria-label="Terminal">
    {choices===null?<span className="share-sheet-note" role="status">Loading terminals…</span>:!choices.length?<span className="share-sheet-note">No open terminals in this workspace.</span>:choices.map(t=>{const blocked=!!catalog&&!projectOf(catalog,t);return <button type="button" key={t.sessionId} disabled={blocked} className={`share-terminal-card${picked?.sessionId===t.sessionId?' is-picked':''}`} aria-pressed={picked?.sessionId===t.sessionId} onClick={()=>setPicked(t)}><strong>{terminalLabel(t)}</strong>{blocked&&<small>{NOT_SHARED}</small>}</button>;})}
   </div>}
   {terminal&&unshared&&<p className="share-sheet-note">{NOT_SHARED}: its project isn't one your team can open.</p>}
   {project&&<p className="share-sheet-note">They also see what's already on screen.</p>}
   {error&&<p role="alert" className="share-sheet-error">{error}</p>}
  </div>
 </Dialog>;
}
/** One sheet for the whole window, opened by `shareTerminal()`. */
export function ShareTerminalHost(){
 const [request,setRequest]=useState<{terminal:ShareableTerminal|null;nonce:number}|null>(null);
 useEffect(()=>{const open=(e:Event)=>setRequest({terminal:(e as CustomEvent<ShareableTerminal|null>).detail??null,nonce:Date.now()});const reset=()=>setRequest(null);window.addEventListener(SHARE_TERMINAL_EVENT,open);window.addEventListener('canopy:account-changed',reset);return()=>{window.removeEventListener(SHARE_TERMINAL_EVENT,open);window.removeEventListener('canopy:account-changed',reset);};},[]);
 return request?<ShareTerminalSheet key={request.nonce} terminal={request.terminal} onClose={()=>setRequest(null)}/>:null;
}
