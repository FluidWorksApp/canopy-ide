// A share card in team chat: a PR, lines of a file, a diff, terminal output, an
// agent's report, a review request or a review outcome, sent from Canopy.
//
// The card is untrusted input (teamMessaging/cardSchema.ts parsed it), so it is
// rendered as plain text throughout — never Markdown, never HTML, no images —
// and nothing opens or runs on its own. Resolving it against the checkouts here
// is a read-only lookup; every action is a click. Terminal output is text to
// read and copy, never a command to run.
import {useEffect,useMemo,useState} from 'react';
import * as ipc from '../ipc';
import {openInOsBrowser} from '../links';
import {watchedPaths} from '../prWatchStore';
import {resolveShareCard,type ShareAction,type ShareCardLookups} from '../gitLinks';
import {routeShareAction,type ShareOpen} from '../gitLinkRouting';
import {LinkifiedText} from './LinkifiedText';
import {Button} from './ui';
import {CheckIcon,CommitIcon,CopyIcon,DocumentIcon,GlobeIcon} from './icons';
import type {ChatMessage} from '../teamMessaging/client';
import {OUTCOME_ICON,OUTCOME_LABEL,cardDraft,cardOf,cardUrl,foldOutcomes,foldPlanOutcomes,type Card,type CardExtensions,type PlanCard,type PlanOutcome,type PlanOutcomeCard,type ReviewOutcome,type ReviewOutcomeCard,type ReviewRequestCard} from '../teamMessaging/cardSchema';
import {openSessionDoc} from '../sessionDoc/events';
import {applyChatApproval} from '../plans/planStore';
import './chatCard.css';

/** Everything a card reaches outside itself, injectable for tests. */
export interface ChatCardDeps{
 lookups:ShareCardLookups;
 ghAvailable():Promise<boolean>;
 ghPrReview(repo:string,number:number,action:'approve'|'request-changes',body?:string):Promise<string>;
 revCount(repo:string,from:string,to:string):Promise<number>;
 showAt(repo:string,sha:string,path:string):Promise<string>;
 /** The open PRs as gh lists them right now — never cached; a review is
  *  checked against the live head. */
 livePrs(repo:string):Promise<ipc.PrInfo[]>;
 /** Opens a resolved target in the project holding it; false when none does. */
 open(action:ShareOpen,fallback:()=>void):boolean;
 openExternal(url:string):void;
 copy(text:string):Promise<void>;
}
/** A conversation full of PR cards would otherwise run `gh pr list` once per
 *  card; resolving shares one answer per repo for a short while. */
const PR_CACHE_MS=30_000;
const prCache=new Map<string,{at:number;list:Promise<ipc.PrInfo[]>}>();
function cachedPrs(repo:string){
 const hit=prCache.get(repo);
 if(hit&&Date.now()-hit.at<PR_CACHE_MS)return hit.list;
 const list=ipc.ghPrList(repo);prCache.set(repo,{at:Date.now(),list});
 list.catch(()=>prCache.delete(repo));
 return list;
}
let ipcDeps:ChatCardDeps|undefined;
const ipcChatCardDeps=():ChatCardDeps=>ipcDeps??=({
 lookups:{
  get repos(){return watchedPaths();},
  remoteUrl:repo=>ipc.gitRemoteUrl(repo),
  prs:cachedPrs,
  issues:repo=>ipc.ghIssueList(repo),
  commit:(repo,hash)=>ipc.gitCommitDetail(repo,hash),
  fileExists:(repo,path)=>ipc.fsRepoPath(repo,path).then(()=>true),
  head:repo=>ipc.gitShareContext(repo).then(c=>c.head),
  containedPath:(repo,path)=>ipc.fsRepoPath(repo,path),
 },
 ghAvailable:()=>ipc.ghAvailable(),
 ghPrReview:(repo,number,action,body)=>ipc.ghPrReview(repo,number,action,body),
 revCount:(repo,from,to)=>ipc.gitRevCount(repo,from,to),
 showAt:(repo,sha,path)=>ipc.gitShowAt(repo,sha,path),
 livePrs:repo=>{prCache.delete(repo);return ipc.ghPrList(repo);},
 open:(action,fallback)=>routeShareAction(action,fallback),
 openExternal:url=>openInOsBrowser(url),
 copy:text=>navigator.clipboard.writeText(text),
});

const short=(sha:string)=>sha.slice(0,7);
const lines=(l?:{start:number;end:number})=>l?(l.start===l.end?`:${l.start}`:`:${l.start}-${l.end}`):'';
const KIND:Record<Card['type'],string>={pr:'Pull request',file:'File',diff:'Diff',terminal:'Terminal output',report:'Agent report','review-request':'Review requested','review-outcome':'Review',plan:'Plan for review','plan-outcome':'Plan',handoff:'Hand-off'};
/** Long text blocks start folded to this many lines. */
const FOLD_LINES=12;

function useResolved(card:Card,deps:ChatCardDeps){
 const [action,setAction]=useState<ShareAction>();
 const needs='repo' in card&&!!card.repo;
 useEffect(()=>{
  if(!needs){setAction({do:'none'});return;}
  let live=true;
  void resolveShareCard(card,deps.lookups).catch(():ShareAction=>{const url=cardUrl(card);return url&&'repo' in card&&card.repo?{do:'web',url,host:card.repo.host}:{do:'none'};}).then(a=>{if(live)setAction(a);});
  return()=>{live=false;};
 },[card,deps,needs]);
 return action;
}

/** Plain text, folded past FOLD_LINES with a toggle. */
function TextBlock({text,className,linkify=false,label}:{text:string;className?:string;linkify?:boolean;label:string}){
 const all=text.split('\n'),[open,setOpen]=useState(false),long=all.length>FOLD_LINES;
 const shown=open||!long?text:all.slice(0,FOLD_LINES).join('\n');
 return <div className="chat-card-block-wrap">
  <pre className={`chat-card-block ${className??''}`} aria-label={label} tabIndex={0}>{linkify?<LinkifiedText text={shown} anyProject/>:shown}</pre>
  {long&&<button type="button" className="account-chat-action" onClick={()=>setOpen(v=>!v)}>{open?'Show less':`Show all ${all.length} lines`}</button>}
 </div>;
}
function PatchBlock({patch}:{patch:string}){
 return <pre className="chat-card-block chat-card-patch" aria-label="Patch" tabIndex={0}>{patch.split('\n').map((line,i)=><span key={i} className={line.startsWith('+')&&!line.startsWith('+++')?'is-add':line.startsWith('-')&&!line.startsWith('---')?'is-del':line.startsWith('@@')?'is-hunk':undefined}>{line}{'\n'}</span>)}</pre>;
}
function CopyButton({text,deps,label='Copy'}:{text:string;deps:ChatCardDeps;label?:string}){
 const [done,setDone]=useState(false);
 return <Button size="sm" variant="ghost" onClick={()=>void deps.copy(text).then(()=>{setDone(true);window.setTimeout(()=>setDone(false),1500);}).catch(()=>{})}>{done?<><CheckIcon size={11}/>Copied</>:<><CopyIcon size={11}/>{label}</>}</Button>;
}

/** "Open" for a target this machine has, "Open on {host}" for one it doesn't. */
function OpenButtons({action,card,deps,label='Open'}:{action?:ShareAction;card:Card;deps:ChatCardDeps;label?:string}){
 const url=cardUrl(card),host='repo' in card&&card.repo?card.repo.host:undefined;
 const web=()=>{if(url)deps.openExternal(url);};
 if(!action)return <Button size="sm" disabled aria-busy="true">{label}</Button>;
 const target:ShareOpen|undefined=action.do==='pr'?{do:'pr',repo:action.repo,pr:action.pr}:action.do==='commit'?{do:'commit',repo:action.repo,commit:action.commit}:action.do==='file'&&action.exists?{do:'file',repo:action.repo,path:action.path,line:action.line}:undefined;
 return <>
  {target&&<Button size="sm" variant="accent" onClick={()=>{if(!deps.open(target,web))web();}}>{label}</Button>}
  {url&&host&&<Button size="sm" variant={target?'ghost':'default'} onClick={web} title={url}><GlobeIcon size={11}/>Open on {host}</Button>}
 </>;
}

/** A file card's working copy is at another commit: say so, and offer the
 *  shared revision read-only. */
function FileAt({card,action,deps}:{card:Extract<Card,{type:'file'}>;action:Extract<ShareAction,{do:'file'}>;deps:ChatCardDeps}){
 const [text,setText]=useState<string>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const stale=!!action.head&&action.head!==card.rev;
 const view=()=>{setBusy(true);setError('');void deps.showAt(action.repo,card.rev,card.path).then(setText,(e:unknown)=>setError(`Can't show it at ${short(card.rev)}: ${e instanceof Error?e.message:String(e)}`)).finally(()=>setBusy(false));};
 const excerpt=useMemo(()=>{
  if(text===undefined)return '';
  const all=text.split('\n'),from=Math.max(1,(card.lines?.start??1)-3),to=Math.min(all.length,(card.lines?.end??Math.min(all.length,40))+3);
  const width=String(to).length;
  return all.slice(from-1,to).map((l,i)=>`${String(from+i).padStart(width)}  ${l}`).join('\n');
 },[text,card.lines]);
 if(!stale&&action.exists)return null;
 return <div className="chat-card-banner" role="note">
  {stale?<span>Shared at <code>{short(card.rev)}</code>; your checkout is at <code>{short(action.head)}</code>.</span>:<span>This file isn't in your working copy.</span>}
  {text===undefined?<Button size="sm" disabled={busy} onClick={view}>View at {short(card.rev)}</Button>:<TextBlock text={excerpt} label={`${card.path} at ${short(card.rev)}`}/>}
  {error&&<span role="alert" className="chat-card-error">{error}</span>}
 </div>;
}

type ReviewAction='approve'|'request-changes';
/** Approve… / Request changes…, on the reviewer's machine, through gh. Always
 *  confirmed first; changes need a comment; a head that moved since the request
 *  asks again; a gh failure posts nothing. */
function ReviewControls({card,request,action,deps,onReply}:{card:ReviewRequestCard;request:ChatMessage;action?:ShareAction;deps:ChatCardDeps;onReply?:(text:string,ext:CardExtensions)=>Promise<unknown>}){
 const [gh,setGh]=useState<boolean>();
 useEffect(()=>{let live=true;void deps.ghAvailable().catch(()=>false).then(v=>{if(live)setGh(v);});return()=>{live=false;};},[deps]);
 const [mode,setMode]=useState<ReviewAction>(),[body,setBody]=useState(''),[moved,setMoved]=useState<{head:string;note:string}>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState('');
 const repo=action&&(action.do==='pr'||action.do==='web')?action.repo:undefined;
 const ready=!!repo&&gh===true&&!!onReply;
 const reset=()=>{setMode(undefined);setBody('');setMoved(undefined);setError('');};
 const why=!action?'Looking for a checkout…':!repo?`No checkout of ${card.repo.slug} here`:gh===false?'GitHub CLI (gh) is not available':gh===undefined?'Checking gh…':'';
 async function submit(confirmedHead?:string){
  if(!repo||!mode||!onReply)return;
  if(mode==='request-changes'&&!body.trim()){setError('Say what needs to change.');return;}
  setBusy(true);setError('');
  try{
   // The head now, not the one in the request: a review is of what is there.
   const live=(await deps.livePrs(repo)).find(p=>p.number===card.number);
   if(!live)throw Error(`#${card.number} is no longer open.`);
   const head=live.head_sha||undefined;
   if(head&&head!==card.head&&head!==confirmedHead){
    const n=await deps.revCount(repo,card.head,head).catch(()=>undefined);
    setMoved({head,note:n?`${n} new commit${n===1?'':'s'} since the request`:`The PR's head moved from ${short(card.head)} to ${short(head)} since the request`});
    return;
   }
   await deps.ghPrReview(repo,card.number,mode,body.trim()||undefined);
   const outcome:ReviewOutcomeCard={type:'review-outcome',v:1,request:request.id,repo:card.repo,number:card.number,outcome:mode==='approve'?'approved':'changes-requested',...(head?{head}:{})};
   const draft=cardDraft(outcome,'',{thread:{root:request.id}});
   setDone(mode==='approve'?'Approved':'Changes requested');reset();
   await onReply(draft.text,draft.ext).catch(()=>{/* the message's own delivery state shows a failure */});
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 }
 if(done)return <p className="chat-card-note" role="status">{done} on GitHub.</p>;
 if(!ready)return <div className="chat-card-actions"><OpenButtons action={action} card={card} deps={deps}/>{why&&<small className="chat-card-why">{why}</small>}</div>;
 if(!mode)return <div className="chat-card-actions">
  <OpenButtons action={action} card={card} deps={deps}/>
  <Button size="sm" onClick={()=>setMode('approve')}>Approve…</Button>
  <Button size="sm" onClick={()=>setMode('request-changes')}>Request changes…</Button>
 </div>;
 const label=mode==='approve'?'Approve':'Request changes';
 return <div className="chat-card-confirm" role="group" aria-label={`${label} ${card.repo.slug}#${card.number}`}>
  <p>{mode==='approve'?`Approve ${card.repo.slug}#${card.number} on GitHub as you?`:`Request changes on ${card.repo.slug}#${card.number} on GitHub as you?`}</p>
  <textarea aria-label={mode==='approve'?'Comment (optional)':'What needs to change'} placeholder={mode==='approve'?'Comment (optional)':'What needs to change (required)'} value={body} onChange={e=>setBody(e.target.value)} rows={2} maxLength={8000}/>
  {moved&&<p className="chat-card-warning" role="alert">{moved.note}. Review the latest anyway?</p>}
  {error&&<p className="chat-card-error" role="alert">{error}</p>}
  <div className="chat-card-actions">
   <Button size="sm" variant={mode==='approve'?'accent':'danger'} disabled={busy||(mode==='request-changes'&&!body.trim())} onClick={()=>void submit(moved?.head)}>{busy?'Submitting…':moved?`${label} the latest`:label}</Button>
   <Button size="sm" variant="ghost" disabled={busy} onClick={reset}>Cancel</Button>
  </div>
 </div>;
}

function OutcomeChips({request,messages,name}:{request:ChatMessage;messages:readonly ChatMessage[];name:(id:string)=>string}){
 const card=cardOf(request) as ReviewRequestCard;
 const folded=useMemo(()=>foldOutcomes(request,messages),[request,messages]);
 const by=new Map(folded.map(f=>[f.reviewer,f]));
 const chip=(o?:ReviewOutcome)=>o?`${OUTCOME_ICON[o]} ${o==='approved'?'Approved':o==='changes-requested'?'Changes requested':'Commented'}`:'Pending';
 return <ul className="chat-card-chips" aria-label="Reviews">
  {card.reviewers.map(r=>{const f=by.get(r);return <li key={r} className={`chat-card-chip is-${f?.outcome??'pending'}`} title={f?.head?`at ${short(f.head)}`:undefined}><strong>{name(r)}</strong> {chip(f?.outcome)}</li>;})}
 </ul>;
}

export function ChatCard({message,userId,messages,name,onReply,deps:given}:{
 message:ChatMessage;userId:string;
 /** The conversation's messages, for folding review outcomes. */
 messages:readonly ChatMessage[];
 name:(id:string)=>string;
 /** Posts into this conversation (for review outcomes). */
 onReply?:(text:string,ext:CardExtensions)=>Promise<unknown>;
 deps?:ChatCardDeps;
}){
 const card=useMemo(()=>cardOf(message),[message]);
 const deps=useMemo(()=>given??ipcChatCardDeps(),[given]);
 if(!card)return null;
 return <CardBody card={card} message={message} userId={userId} messages={messages} name={name} onReply={onReply} deps={deps}/>;
}

function CardBody({card,message,userId,messages,name,onReply,deps}:{card:Card;message:ChatMessage;userId:string;messages:readonly ChatMessage[];name:(id:string)=>string;onReply?:(text:string,ext:CardExtensions)=>Promise<unknown>;deps:ChatCardDeps}){
 const action=useResolved(card,deps);
 const [patch,setPatch]=useState(false);
 const head=(icon:React.ReactNode,ref:string)=><div className="chat-card-head"><span className="chat-card-icon">{icon}</span><span className="chat-card-kind">{KIND[card.type]}</span><span className="chat-card-ref" title={ref}>{ref}</span></div>;
 switch(card.type){
  case 'pr':return <div className="chat-card" data-type="pr">
   {head(<CommitIcon size={13}/>,`${card.repo.slug}#${card.number}${card.head?` · ${short(card.head)}`:''}`)}
   <div className="chat-card-title">{card.title}</div>
   <div className="chat-card-actions"><OpenButtons action={action} card={card} deps={deps}/></div>
  </div>;
  case 'file':return <div className="chat-card" data-type="file">
   {head(<DocumentIcon size={13}/>,`${card.repo.slug} · ${short(card.rev)}`)}
   <div className="chat-card-title chat-card-path">{card.path}{lines(card.lines)}</div>
   {card.snippet&&<TextBlock text={numbered(card.snippet,card.lines?.start??1)} label={`${card.path} lines`}/>}
   {action?.do==='file'&&<FileAt card={card} action={action} deps={deps}/>}
   <div className="chat-card-actions"><OpenButtons action={action} card={card} deps={deps}/>{card.snippet&&<CopyButton text={card.snippet} deps={deps}/>}</div>
  </div>;
  case 'diff':return <div className="chat-card" data-type="diff">
   {head(<CommitIcon size={13}/>,`${card.repo.slug} · ${short(card.base)}..${short(card.head)}${card.pr?` · #${card.pr}`:''}`)}
   <div className="chat-card-title chat-card-path">{card.path}{card.lines?`${lines(card.lines)} (${card.lines.side})`:''}</div>
   {patch&&<PatchBlock patch={card.patch}/>}
   <div className="chat-card-actions">
    <OpenButtons action={action} card={card} deps={deps} label={action?.do==='pr'?'Open PR files':action?.do==='commit'?'Open commit':'Open'}/>
    <Button size="sm" variant="ghost" aria-expanded={patch} onClick={()=>setPatch(v=>!v)}>{patch?'Hide patch':'Show patch'}</Button>
   </div>
  </div>;
  case 'terminal':return <div className="chat-card" data-type="terminal">
   {head(<span aria-hidden="true">›_</span>,card.exit!==undefined?`exit ${card.exit}`:'')}
   <div className="chat-card-title">{card.title}</div>
   {card.command&&<code className="chat-card-command">$ {card.command}</code>}
   <TextBlock text={card.output} className="chat-card-terminal" label="Terminal output"/>
   {card.truncated&&<small className="chat-card-why">Output was truncated by the sender.</small>}
   <div className="chat-card-actions"><CopyButton text={card.output} deps={deps} label="Copy output"/>{card.command&&<CopyButton text={card.command} deps={deps} label="Copy command"/>}</div>
  </div>;
  case 'report':return <div className="chat-card is-agent-made" data-type="report">
   {head(<span aria-hidden="true">✦</span>,card.repo&&card.pr?`${card.repo.slug}#${card.pr}`:'')}
   <div className="chat-card-title">{card.title}</div>
   <small className="chat-card-byline">Written by an agent: {card.agent}</small>
   <TextBlock text={card.body} linkify label="Report"/>
   <div className="chat-card-actions">{card.repo&&card.pr?<OpenButtons action={action} card={card} deps={deps} label="Open PR"/>:null}<CopyButton text={card.body} deps={deps}/></div>
  </div>;
  case 'review-request':{
   const own=message.sender===userId,reviewer=card.reviewers.includes(userId);
   return <div className="chat-card" data-type="review-request">
    {head(<CommitIcon size={13}/>,`${card.repo.slug}#${card.number} · head ${short(card.head)}`)}
    <div className="chat-card-title">{card.title}</div>
    <OutcomeChips request={message} messages={messages} name={name}/>
    {own||!reviewer?<div className="chat-card-actions"><OpenButtons action={action} card={card} deps={deps}/></div>:<ReviewControls card={card} request={message} action={action} deps={deps} onReply={onReply}/>}
   </div>;
  }
  case 'handoff':return <div className="chat-card is-agent-made" data-type="handoff">
   {head(<span aria-hidden="true">⇄</span>,card.repo?card.repo.slug:card.dir??'')}
   <div className="chat-card-title">{card.title}</div>
   <small className="chat-card-byline">A {card.agent} session handed off{message.sender===userId?'':` by ${name(message.sender)}`}</small>
   <TextBlock text={card.packet} label="Hand-off packet"/>
   {card.truncated&&<small className="chat-card-why">The packet was shortened to fit a chat message.</small>}
   <div className="chat-card-actions">
    {message.sender!==userId&&<Button size="sm" variant="accent" onClick={()=>openSessionDoc({kind:'received',title:card.title,agent:card.agent,session:card.session,packet:card.packet,from:name(message.sender),...(card.dir?{dir:card.dir}:{}),...(card.repo?{repo:card.repo}:{})})}>Take over</Button>}
    <CopyButton text={card.packet} deps={deps} label="Copy packet"/>
   </div>
  </div>;
  case 'review-outcome':return <div className="chat-card is-compact" data-type="review-outcome">
   <span>{OUTCOME_ICON[card.outcome]} {OUTCOME_LABEL[card.outcome]} {card.repo.slug}#{card.number}{card.head?` at ${short(card.head)}`:''}</span>
  </div>;
  case 'plan':{
   const own=message.sender===userId;
   return <div className="chat-card is-agent-made" data-type="plan">
    {head(<span aria-hidden="true">◇</span>,`${card.risk} risk · ${card.size}`)}
    <div className="chat-card-title">{card.goal}</div>
    {card.decisions?.length?<div className="chat-card-plan-section"><small className="chat-card-byline">Decisions</small><ul>{card.decisions.map((d,i)=><li key={i}>{d.q} <strong>→ {d.a}</strong></li>)}</ul></div>:null}
    {card.acceptance.length?<div className="chat-card-plan-section"><small className="chat-card-byline">Done when</small><ul>{card.acceptance.map((a,i)=><li key={i}>{a}</li>)}</ul></div>:null}
    {card.wontDo?.length?<div className="chat-card-plan-section"><small className="chat-card-byline">Won't do</small><ul>{card.wontDo.map((w,i)=><li key={i}>{w}</li>)}</ul></div>:null}
    <p className="chat-card-note">{card.approvers?.length?<>Approvers: {card.approvers.map(name).join(', ')}</>:<>No approvers were named, so this plan can't be approved from chat.</>}</p>
    <PlanOutcomes request={message} messages={messages} name={name} own={own}/>
    {!own&&(card.approvers??[]).includes(userId)&&<PlanControls card={card} request={message} onReply={onReply}/>}
    {!own&&!(card.approvers??[]).includes(userId)&&card.approvers?.length?<p className="chat-card-note">Only the approvers can approve this plan. Reply in the thread to comment.</p>:null}
   </div>;
  }
  case 'plan-outcome':return <div className="chat-card is-compact" data-type="plan-outcome">
   <span>{card.outcome==='approved'?'✅ Approved the plan':'🔁 Asked for changes to the plan'}</span>
  </div>;
 }
}
/** Approvals already carried to this machine's ledger, so a re-render of the
 *  conversation does not append the same status change again. */
const carried=new Set<string>();
/** The plan card's thread answers: who approved, who asked for changes. The
 *  author's copy carries the first approval into the plan's ledger entry —
 *  the round trip that lets a teammate's yes start the waiting agent. */
function PlanOutcomes({request,messages,name,own}:{request:ChatMessage;messages:readonly ChatMessage[];name:(id:string)=>string;own:boolean}){
 const card=cardOf(request) as PlanCard;
 const folded=useMemo(()=>foldPlanOutcomes(request,messages),[request,messages]);
 const approval=folded.find(f=>f.outcome==='approved');
 useEffect(()=>{
  if(!own||!approval||carried.has(card.plan))return;
  carried.add(card.plan);
  void applyChatApproval(card.plan,{id:approval.by,name:name(approval.by)}).catch(()=>carried.delete(card.plan));
 },[own,approval,card.plan,name]);
 if(!folded.length)return <p className="chat-card-note">No answers yet. Approvers can approve; anyone can comment in the thread.</p>;
 return <ul className="chat-card-chips" aria-label="Plan answers">
  {folded.map(f=><li key={f.by} className={`chat-card-chip is-${f.outcome}`}><strong>{name(f.by)}</strong> {f.outcome==='approved'?'✅ Approved':'🔁 Changes asked'}</li>)}
 </ul>;
}
/** Approve / Ask for changes on a teammate's plan: posts a plan-outcome card
 *  in the plan's thread, with the comment as its note. */
function PlanControls({card,request,onReply}:{card:PlanCard;request:ChatMessage;onReply?:(text:string,ext:CardExtensions)=>Promise<unknown>}){
 const [mode,setMode]=useState<PlanOutcome>(),[body,setBody]=useState(''),[done,setDone]=useState(''),[busy,setBusy]=useState(false);
 if(!onReply)return null;
 if(done)return <p className="chat-card-note" role="status">{done}</p>;
 if(!mode)return <div className="chat-card-actions">
  <Button size="sm" variant="accent" onClick={()=>setMode('approved')}>Approve plan…</Button>
  <Button size="sm" onClick={()=>setMode('changes-requested')}>Ask for changes…</Button>
 </div>;
 const submit=async()=>{
  if(mode==='changes-requested'&&!body.trim())return;
  setBusy(true);
  const outcome:PlanOutcomeCard={type:'plan-outcome',v:1,request:request.id,plan:card.plan,outcome:mode};
  try{
   const draft=cardDraft(outcome,body.trim(),{thread:{root:request.id}});
   await onReply(draft.text,draft.ext);
   setDone(mode==='approved'?'You approved this plan.':'You asked for changes.');
  }catch{/* the message's own delivery state shows a failure */}
  finally{setBusy(false);}
 };
 return <div className="chat-card-confirm" role="group" aria-label={mode==='approved'?'Approve plan':'Ask for changes to the plan'}>
  <textarea aria-label={mode==='approved'?'Comment (optional)':'What should change'} placeholder={mode==='approved'?'Comment (optional)':'What should change (required)'} value={body} onChange={e=>setBody(e.target.value)} rows={2} maxLength={1800}/>
  <div className="chat-card-actions">
   <Button size="sm" variant={mode==='approved'?'accent':'danger'} disabled={busy||(mode==='changes-requested'&&!body.trim())} onClick={()=>void submit()}>{busy?'Sending…':mode==='approved'?'Approve':'Ask for changes'}</Button>
   <Button size="sm" variant="ghost" disabled={busy} onClick={()=>{setMode(undefined);setBody('');}}>Cancel</Button>
  </div>
 </div>;
}
const numbered=(text:string,start:number)=>{const all=text.split('\n'),width=String(start+all.length-1).length;return all.map((l,i)=>`${String(start+i).padStart(width)}  ${l}`).join('\n');};
