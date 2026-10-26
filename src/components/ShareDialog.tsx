// Send something from Canopy to team chat: one dialog for every entry point.
// Team → conversation (the channel or one person) → optional note → the exact
// message that will be sent, card and fallback text both, with its size and a
// warning when it looks like it carries a credential. Nothing is sent until
// Send is pressed.
import {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {teamSession} from '../teamMessaging/session';
import type {ChatMessage} from '../teamMessaging/client';
import {CardError,LIMITS,cardDraft,cardFreeText,secretKinds,type Card,type CardDraft} from '../teamMessaging/cardSchema';
import {OPEN_SHARE_DIALOG_EVENT,type ShareRequest} from '../shareCards';
import {ChatCard,type ChatCardDeps} from './ChatCard';
import {Button,Select} from './ui';
import './chatCard.css';

type Team={id:string;name:string};
type Directory={teams:Team[];selfId:string};
const loadDirectory=()=>invoke<{teams?:Team[];selfId:string}>('canopy_account_request',{route:'/api/teams',body:null}).then(d=>({teams:d.teams??[],selfId:d.selfId}));

/** A preview resolves against nothing: it shows what the recipient's card
 *  looks like without a checkout, and its buttons do nothing. */
const PREVIEW_DEPS:ChatCardDeps={
 lookups:{repos:[],remoteUrl:async()=>'',prs:async()=>[],issues:async()=>[],commit:async()=>{throw Error('preview');},fileExists:async()=>false,head:async()=>'',containedPath:async()=>{throw Error('preview');}},
 ghAvailable:async()=>false,ghPrReview:async()=>{throw Error('preview');},revCount:async()=>0,showAt:async()=>{throw Error('preview');},
 open:()=>true,openExternal:()=>{},copy:async()=>{},
};

export interface ShareDialogProps{
 request:ShareRequest;
 onClose:()=>void;
 /** Test seam: the teams this account is in. */
 directory?:()=>Promise<Directory>;
}

export function ShareDialog({request,onClose,directory=loadDirectory}:ShareDialogProps){
 const [dir,setDir]=useState<Directory>(),[dirError,setDirError]=useState('');
 const [teamId,setTeamId]=useState(''),[peer,setPeer]=useState<string|null>(null),[note,setNote]=useState('');
 const [reviewers,setReviewers]=useState<string[]>([]),[error,setError]=useState(''),[sending,setSending]=useState(false);
 useEffect(()=>{
  if(request.kind==='error')return;
  let live=true;
  void directory().then(d=>{if(!live)return;setDir(d);setTeamId(t=>t||d.teams[0]?.id||'');},(e:unknown)=>{if(live)setDirError(e instanceof Error?e.message:String(e));});
  return()=>{live=false;};
 },[directory,request.kind]);
 useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[onClose]);
 const session=useMemo(()=>dir&&teamId?teamSession(teamId,dir.selfId):undefined,[dir,teamId]);
 useEffect(()=>session?.retain(),[session]);
 const snapshot=useSyncExternalStore(session?.subscribe??noopSubscribe,session?.getSnapshot??emptySnapshot);
 const members=Object.entries(snapshot.members??{}).filter(([id])=>id!==dir?.selfId).sort((a,b)=>a[1].localeCompare(b[1]));
 const name=(id:string)=>snapshot.members?.[id]??id.slice(0,8);
 // A direct message can only ask the person it goes to.
 const candidates=peer?members.filter(([id])=>id===peer):members;
 useEffect(()=>{setReviewers(current=>{const next=current.filter(r=>candidates.some(([id])=>id===r));return peer&&!next.length?[peer]:next;});},[peer,candidates.length]);// eslint-disable-line react-hooks/exhaustive-deps

 const built=useMemo(():{draft?:CardDraft;problem?:string}=>{
  if(request.kind==='error')return {problem:request.message};
  try{
   if(request.kind==='review'){
    if(!reviewers.length)return {problem:'Choose who should review it.'};
    const card:Card={...request.card,reviewers};
    return {draft:cardDraft(card,note,{mentions:reviewers})};
   }
   return {draft:cardDraft(request.card,note)};
  }catch(e){return {problem:e instanceof CardError?e.message:String(e)};}
 },[request,note,reviewers]);
 const draft=built.draft;
 const secrets=useMemo(()=>draft?secretKinds(`${cardFreeText(draft.ext.card)}\n${note}`):[],[draft,note]);
 const preview=useMemo(():ChatMessage|undefined=>draft&&dir?{id:'00000000-0000-4000-8000-000000000000',sender:dir.selfId,recipient:peer,text:draft.text,created:Date.now(),...draft.ext}:undefined,[draft,dir,peer]);

 async function send(){
  if(!session||!draft)return;
  setSending(true);setError('');
  try{await session.send(draft.text,peer,[],draft.ext);onClose();}
  catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setSending(false);}
 }
 const title=request.kind==='review'?'Request review in Canopy':request.kind==='error'?"Can't share this":'Send to team chat';
 return <div className="share-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
  <div className="share-dialog" role="dialog" aria-modal="true" aria-label={title}>
   <h2>{title}</h2>
   {request.kind==='error'?<p className="share-dialog-error" role="alert">{request.message}</p>:<>
    {dirError&&<p className="share-dialog-error" role="alert">Couldn't load your teams. {dirError}</p>}
    {dir&&!dir.teams.length&&<p className="share-dialog-error">You're not in a team yet.</p>}
    {dir&&dir.teams.length>0&&<div className="share-dialog-row">
     <label>Team<Select size="sm" width="full" aria-label="Team" value={teamId} onChange={e=>{setTeamId(e.target.value);setPeer(null);}}>{dir.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
     <label>Conversation<Select size="sm" width="full" aria-label="Conversation" value={peer??''} onChange={e=>setPeer(e.target.value||null)}>
      <option value="">Everyone in this team</option>
      {members.map(([id,n])=><option key={id} value={id}>{n}</option>)}
     </Select></label>
    </div>}
    {request.kind==='review'&&<fieldset className="share-dialog-reviewers" aria-label="Reviewers">
     {candidates.length?candidates.map(([id,n])=><label key={id}><input type="checkbox" checked={reviewers.includes(id)} disabled={!!peer} onChange={e=>setReviewers(cur=>e.target.checked?[...cur,id].slice(0,LIMITS.reviewers):cur.filter(r=>r!==id))}/>{n}</label>):<small>No teammates to ask yet.</small>}
    </fieldset>}
    <label>Note (optional)<textarea aria-label="Note" rows={2} value={note} maxLength={2000} onChange={e=>setNote(e.target.value)} placeholder="Add a note…"/></label>
    {request.kind==='share'&&request.warning&&<p className="share-dialog-warning" role="note">{request.warning}</p>}
    {secrets.length>0&&<p className="share-dialog-warning" role="alert">This looks like it contains {secrets.join(', ')}. Teammates will see it as written — remove it before sending.</p>}
    {built.problem&&<p className="share-dialog-error" role="alert">{built.problem}</p>}
    {draft&&<section className="share-dialog-preview" aria-label="Preview">
     {preview&&<ChatCard message={preview} userId={dir?.selfId??''} messages={[preview]} name={name} deps={PREVIEW_DEPS}/>}
     <small>Shown as text in older versions of Canopy:</small>
     <pre className="share-dialog-fallback" aria-label="Fallback text">{draft.text}</pre>
     <div className="share-dialog-meter"><span>{formatKb(draft.bytes.card)} of {formatKb(LIMITS.cardBytes)}</span><meter aria-label="Card size" min={0} max={LIMITS.cardBytes} high={LIMITS.cardBytes*0.85} value={draft.bytes.card}/></div>
    </section>}
    {error&&<p className="share-dialog-error" role="alert">{error}</p>}
   </>}
   <div className="share-dialog-actions">
    <Button variant="ghost" onClick={onClose}>{request.kind==='error'?'Close':'Cancel'}</Button>
    {request.kind!=='error'&&<Button variant="accent" disabled={!draft||!session||sending} onClick={()=>void send()}>{sending?'Sending…':secrets.length?'Send anyway':'Send'}</Button>}
   </div>
  </div>
 </div>;
}
const formatKb=(n:number)=>`${(n/1024).toFixed(1)} KB`;
const noopSubscribe=()=>()=>{};
const EMPTY={members:{}} as {members:Record<string,string>};
const emptySnapshot=()=>EMPTY;

/** The one share dialog, opened by openShareDialog from any entry point. */
export function ShareDialogHost(){
 const [request,setRequest]=useState<ShareRequest>();
 useEffect(()=>{
  const open=(e:Event)=>{const d=(e as CustomEvent<ShareRequest>).detail;if(d)setRequest(d);};
  window.addEventListener(OPEN_SHARE_DIALOG_EVENT,open);
  return()=>window.removeEventListener(OPEN_SHARE_DIALOG_EVENT,open);
 },[]);
 return request?<ShareDialog request={request} onClose={()=>setRequest(undefined)}/>:null;
}
