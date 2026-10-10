import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {teamSession,type DeliveryState} from '../teamMessaging/session';
import {showConversation} from '../teamMessaging/unread';
import {Button} from './ui';
import {InfoIcon,LockIcon,SendIcon} from './icons';
import {isSendKey} from './chatComposerKeys';
import './teamHub.css';
import {LinkifiedText} from './LinkifiedText';
export type AccountConversation={teamId:string;userId:string;peer:string|null;name:string;email?:string};
/** Consecutive messages from one sender within this window share one header. */
const GROUP_MS=5*60_000;
/** The composer grows with its text up to this many lines, then scrolls. */
const MAX_LINES=6;
/** How close to the newest message counts as having it in view. */
const READ_SLACK_PX=48;
const STORAGE_NOTE='End-to-end encrypted. Pending deliveries survive restarting the IDE and expire after five minutes. The latest 500 messages per team are saved encrypted on this device.';
/** Status copy under your own messages; a receipt shows "Delivered" on the latest one. */
const DELIVERY_LABEL:Record<DeliveryState,string>={sending:'Sending…',sent:'Awaiting delivery',queued:'Saved on this device',waiting:'Waiting for connection',failed:'Not sent',expired:'Not delivered · expired'};
const time=(t:number)=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const dayKey=(t:number)=>new Date(t).toDateString();
function dayLabel(t:number){
 const today=new Date(),yesterday=new Date(today);yesterday.setDate(today.getDate()-1);
 const key=dayKey(t);
 if(key===today.toDateString())return 'Today';
 if(key===yesterday.toDateString())return 'Yesterday';
 return new Date(t).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});
}
export function AccountChatView({conversation,active=true}:{conversation:AccountConversation;active?:boolean}){
 const {teamId,userId,peer,name,email}=conversation;
 const session=useMemo(()=>teamSession(teamId,userId),[teamId,userId]);
 useEffect(()=>session.retain(),[session]);
 const {messages,members,receipts,status,restoredIds,delivery={}}=useSyncExternalStore(session.subscribe,session.getSnapshot);
  // On screen: notifications for this conversation stay quiet while the window is focused.
 useEffect(()=>active?showConversation(teamId,userId,peer):undefined,[active,teamId,userId,peer]);
 const [draft,setDraft]=useState(''),[error,setError]=useState('');
 const input=useRef<HTMLTextAreaElement>(null),log=useRef<HTMLDivElement>(null),hintId=useId();
 const visible=messages.filter(m=>peer===null?m.recipient===null:(m.sender===peer&&m.recipient===userId)||(m.sender===userId&&m.recipient===peer));
 const lastOwn=visible.findLast(m=>m.sender===userId)?.id;
 const connected=status.startsWith('Connected');
 // Grow the composer with its content: one line at rest, capped at MAX_LINES.
 useLayoutEffect(()=>{
  const el=input.current;if(!el)return;
  el.style.height='auto';
  const cs=getComputedStyle(el),line=parseFloat(cs.lineHeight)||20;
  const pad=(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);
  el.style.height=`${Math.min(el.scrollHeight||line+pad,line*MAX_LINES+pad)}px`;
 },[draft]);
 // Keep the newest message in view as the conversation grows.
 const newest=visible.at(-1)?.id;
 useEffect(()=>{const el=log.current;if(el)el.scrollTop=el.scrollHeight;},[newest]);
 // Read means seen: this tab in front, the window focused and not hidden, and
 // the latest messages scrolled into view. Anything less leaves them unread.
 useEffect(()=>{
  const read=()=>{
   const el=log.current,atEnd=!el||el.scrollHeight-el.scrollTop-el.clientHeight<=READ_SLACK_PX;
   if(active&&atEnd&&document.visibilityState==='visible'&&document.hasFocus())session.markRead(peer);
  };
  read();const el=log.current;
  document.addEventListener('visibilitychange',read);window.addEventListener('focus',read);el?.addEventListener('scroll',read,{passive:true});
  return()=>{document.removeEventListener('visibilitychange',read);window.removeEventListener('focus',read);el?.removeEventListener('scroll',read);};
 },[session,peer,active,messages]);
 // Optimistic: the message joins the conversation at once and the composer
 // clears; encryption and delivery continue in the background. Only a message
 // the session refuses outright (e.g. too large) puts the text back.
 function send(){
  const text=draft;if(!text.trim())return;
  setDraft('');setError('');input.current?.focus();
  session.send(text,peer).catch((e:unknown)=>{setError(e instanceof Error?e.message:String(e));setDraft(current=>current||text);});
 }
 const act=(work:()=>unknown)=>{try{void Promise.resolve(work()).catch(()=>{});}catch{/* the message status already shows the failure */}};
 const senderName=(id:string)=>id===userId?'You':members[id]||(peer?name:`Former member (${id.slice(0,8)})`);
 return <section className="account-chat" aria-label={`Chat with ${name}`}>
  <header className="account-chat-header">
   <span aria-hidden="true" className="team-avatar">{peer?name.slice(0,1).toUpperCase():'#'}</span>
   <div className="account-chat-title"><h2>{name}</h2><span>{peer?(email||'Direct message'):'Everyone in this team'}</span></div>
   <small role="status" className={`account-chat-status${connected?' is-connected':''}`} title={status}>{connected?<><LockIcon size={12}/>Encrypted</>:status}</small>
   <span className="account-chat-info" tabIndex={0} role="img" aria-label={STORAGE_NOTE} title={STORAGE_NOTE}><InfoIcon size={14}/></span>
  </header>
  <div className="account-chat-transcript" role="log" aria-label="Messages" ref={log}>
   {!visible.length&&<div className="account-chat-empty"><LockIcon size={16}/><p>Say hello to {name}. Messages are end-to-end encrypted.</p></div>}
   {visible.map((m,i)=>{
    const prev=visible[i-1],own=m.sender===userId;
    const newDay=!prev||dayKey(prev.created)!==dayKey(m.created);
    const grouped=!newDay&&prev.sender===m.sender&&m.created-prev.created<GROUP_MS;
    const delivered=own&&!!receipts[m.id]?.length,state=own&&!delivered?delivery[m.id]?.state??(restoredIds?.includes(m.id)?'queued':'sent'):undefined;
    const failed=state==='failed'||state==='expired'||state==='waiting',pending=!!state&&!failed;
    const receipt=state?DELIVERY_LABEL[state]:delivered&&m.id===lastOwn?'Delivered':'';
    return <div key={m.id} className={`account-chat-row${own?' own':''}`}>
     {newDay&&<div className="account-chat-day" role="separator"><span>{dayLabel(m.created)}</span></div>}
     <article className={`account-chat-msg${own?' own':''}${grouped?' grouped':''}${pending?' pending':''}${failed?' failed':''}`} data-delivery={delivered?'delivered':state}>
      {!grouped&&<header><strong>{senderName(m.sender)}</strong><time dateTime={new Date(m.created).toISOString()}>{time(m.created)}</time></header>}
      <p title={time(m.created)}><LinkifiedText text={m.text}/></p>
      {receipt&&<small title={state?delivery[m.id]?.detail:undefined}>{receipt}{failed&&<> · <button type="button" className="account-chat-action" onClick={()=>act(()=>session.retry(m.id))}>Retry</button> · <button type="button" className="account-chat-action" onClick={()=>act(()=>session.discard(m.id))}>Discard</button></>}</small>}
     </article>
    </div>;
   })}
  </div>
  <form className="account-chat-composer" onSubmit={e=>{e.preventDefault();void send();}}>
   {error&&<p role="alert">{error}</p>}
   <div className="account-chat-input">
    <textarea ref={input} rows={1} aria-label="Message" aria-describedby={hintId} placeholder={`Message ${name}…`} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(isSendKey(e)){e.preventDefault();void send();}}} maxLength={16000}/>
    <Button type="submit" variant="accent" icon aria-label="Send" title="Send (Enter)" disabled={!draft.trim()}><SendIcon size={14}/></Button>
   </div>
   <small id={hintId} className="account-chat-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</small>
  </form>
 </section>;
}
