import {useEffect,useId,useLayoutEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import type {ChatMessage} from '../teamMessaging/client';
import type {TeamSession,DeliveryState} from '../teamMessaging/session';
import {readReceiptsOn} from '../teamMessaging/session';
import {mentionsUser,threadRoot} from '../teamMessaging/unread';
import {mentionsFor,namesList,ago,useMentionSuggestions,type Suggestion} from './chatMessageHelpers';
import {LinkifiedText} from './LinkifiedText';
import {isSendKey} from './chatComposerKeys';
import {Button} from './ui';
import {SendIcon} from './icons';
import './chatThread.css';

const time=(t:number)=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const stamp=(t:number)=>new Date(t).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
export function MentionList({id,suggestions,active,onPick}:{id:string;suggestions:Suggestion[];active:number;onPick:(s:Suggestion)=>void}){
 if(!suggestions.length)return null;
 return <ul id={id} className="chat-mention-list" role="listbox" aria-label="Mention someone">
  {suggestions.map((s,i)=><li key={s.id} role="option" aria-selected={i===active}><button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>onPick(s)}>@{s.label}</button></li>)}
 </ul>;
}

/** Hover and focus actions on one message: reply in thread, and edit or delete your own. */
export function MessageActions({onReply,onEdit,onDelete}:{onReply?:()=>void;onEdit?:()=>void;onDelete?:()=>void}){
 if(!onReply&&!onEdit&&!onDelete)return null;
 return <span className="chat-msg-actions" role="toolbar" aria-label="Message actions">
  {onReply&&<button type="button" aria-label="Reply in thread" title="Reply in thread" onMouseDown={e=>e.preventDefault()} onClick={onReply}>↩︎</button>}
  {onEdit&&<button type="button" aria-label="Edit message" title="Edit (↑ in an empty message box)" onMouseDown={e=>e.preventDefault()} onClick={onEdit}>✎</button>}
  {onDelete&&<button type="button" aria-label="Delete message" title="Delete message" onMouseDown={e=>e.preventDefault()} onClick={onDelete}>🗑</button>}
 </span>;
}
/** Edits a message in place: Enter saves, Escape cancels. */
export function InlineEditor({initial,onSave,onCancel}:{initial:string;onSave:(text:string)=>void;onCancel:()=>void}){
 const [text,setText]=useState(initial),ref=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{const el=ref.current;if(el){el.focus();el.setSelectionRange(el.value.length,el.value.length);}},[]);
 useLayoutEffect(()=>{const el=ref.current;if(el){el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight,200)}px`;}},[text]);
 const save=()=>{if(text.trim())onSave(text);};
 return <div className="chat-inline-edit">
  <textarea ref={ref} aria-label="Edit message" value={text} maxLength={16000} onChange={e=>setText(e.target.value)}
   onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onCancel();}else if(isSendKey(e)){e.preventDefault();save();}}}/>
  <small>Enter to save · Esc to cancel · <button type="button" className="account-chat-action" onClick={save} disabled={!text.trim()}>Save</button> · <button type="button" className="account-chat-action" onClick={onCancel}>Cancel</button></small>
 </div>;
}
/** Asks before deleting, naming who keeps the message because their Canopy is older. */
export function ConfirmDelete({older,onConfirm,onCancel}:{older:string[];onConfirm:()=>void;onCancel:()=>void}){
 return <div className="chat-confirm" role="alertdialog" aria-label="Delete message" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onCancel();}}}>
  <span>Delete this message for everyone?{older.length?` ${namesList(older)} ${older.length===1?'uses':'use'} an older Canopy and will keep it.`:''}</span>
  <Button size="sm" variant="danger" autoFocus onClick={onConfirm}>Delete</Button><Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
 </div>;
}
/** Re-renders every second while `active`, for "retrying in 20s". */
function useTick(active:boolean){
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{if(!active)return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[active]);
 return now;
}
/** Status copy under your own messages; receipts and read receipts on the latest one. */
const DELIVERY_LABEL:Record<DeliveryState,string>={sending:'Sending…',sent:'Awaiting delivery',queued:'Saved on this device',waiting:'Waiting for connection',failed:'Not sent',expired:'Not delivered · expired'};
export function DeliveryLine({session,message,latest,state,detail,delivered,name,dm}:{session:TeamSession;message:ChatMessage;latest:boolean;state?:DeliveryState;detail?:string;delivered:boolean;name:(id:string)=>string;dm:boolean}){
 const {retryAt,awaiting,reads}=useSyncExternalStore(session.subscribe,session.getSnapshot);
 const due=state==='queued'?retryAt?.[message.id]:undefined,now=useTick(!!due);
 const act=(work:()=>unknown)=>{try{void Promise.resolve(work()).catch(()=>{});}catch{/* the status shows the failure */}};
 const waitingFor=awaiting?.[message.id];
 if(waitingFor&&(state==='expired'||state==='queued'||!state)&&!delivered)
  return <small>Will deliver when {namesList(waitingFor.users.map(name))} {waitingFor.users.length===1?'is':'are'} online (until {new Date(waitingFor.until).toLocaleDateString([],{month:'short',day:'numeric'})})</small>;
 if(state==='queued'){
  const left=due?Math.ceil((due-now)/1000):0;
  return <small title={detail}>Saved on this device{left>0?` · retrying in ${left}s`:''} · <button type="button" className="account-chat-action" onClick={()=>act(()=>session.retryNow(message.id))}>Retry now</button></small>;
 }
 if(state){const failed=state==='failed'||state==='expired'||state==='waiting';
  return <small title={detail}>{DELIVERY_LABEL[state]}{failed&&<> · <button type="button" className="account-chat-action" onClick={()=>act(()=>session.retry(message.id))}>Retry</button> · <button type="button" className="account-chat-action" onClick={()=>act(()=>session.discard(message.id))}>Discard</button></>}</small>;
 }
 if(!latest)return null;
 const readers=reads&&readReceiptsOn()?session.readers(message.id):[];
 if(readers.length)return dm?<small>Read</small>:<small title={`Seen by ${namesList(readers.map(name),20)}`}>Seen by {readers.length}</small>;
 return delivered?<small>Delivered</small>:null;
}
/** The text a message shows, or that it was deleted, with "(edited)". */
export function MessageText({text,deleted,editedAt,mentionsMe}:{text:string;deleted:boolean;editedAt?:number;mentionsMe?:boolean}){
 if(deleted)return <p className="chat-deleted">This message was deleted</p>;
 if(!text)return null;
 return <p className={mentionsMe?'chat-mentions-me':undefined}><LinkifiedText text={text} anyProject/>{editedAt!==undefined&&<span className="chat-edited" title={`Edited ${stamp(editedAt)}`}> (edited)</span>}</p>;
}
/** "3 replies · 5m" under a thread's root, with new replies called out. */
export function ThreadLine({replies,last,unread,onOpen}:{replies:number;last:number;unread:number;onOpen:()=>void}){
 if(!replies)return null;
 return <button type="button" className="chat-thread-line" onClick={onOpen}>{replies} {replies===1?'reply':'replies'} · {ago(last)}{unread>0&&<span className="chat-new-replies">{unread} new {unread===1?'reply':'replies'}</span>}</button>;
}

/** The replies of one thread beside the conversation, with their own composer. */
export function ChatThreadPane({session,root,peer,userId,name,active,onClose,renderMessage}:{session:TeamSession;root:string;peer:string|null;userId:string;name:(id:string)=>string;active:boolean;onClose:()=>void;renderMessage?:(m:ChatMessage)=>ReactNode}){
 const snapshot=useSyncExternalStore(session.subscribe,session.getSnapshot);
 const {messages,members,deleted,edits}=snapshot;
 const find=(id:string)=>messages.find(m=>m.id===id);
 const rootMessage=find(root);
 const replies=messages.filter(m=>threadRoot(m,find)===root);
 const [draft,setDraft]=useState(''),[error,setError]=useState('');
 const input=useRef<HTMLTextAreaElement>(null),listId=useId();
 const mention=useMentionSuggestions(draft,setDraft,input,members,userId,peer);
 useEffect(()=>{input.current?.focus({preventScroll:true});},[root]);
 // Open and in front means read.
 useEffect(()=>{if(active&&document.visibilityState==='visible'&&document.hasFocus())session.markThreadRead(root);},[active,session,root,replies.length]);
 const log=useRef<HTMLDivElement>(null);
 useEffect(()=>{const el=log.current;if(el)el.scrollTop=el.scrollHeight;},[replies.length]);
 const send=()=>{
  const text=draft;if(!text.trim())return;setDraft('');setError('');
  const {mentions,mentionsAll}=mentionsFor(text,members,userId,peer);
  session.send(text,peer,[],{thread:root,...(mentions?{mentions}:{}),...(mentionsAll?{mentionsAll}:{})}).catch((e:unknown)=>{setError(e instanceof Error?e.message:String(e));setDraft(current=>current||text);});
 };
 const show=(m:ChatMessage)=>renderMessage?renderMessage(m):<article key={m.id} className={`account-chat-msg${m.sender===userId?' own':''}`} data-message={m.id}>
  <header><strong>{name(m.sender)}</strong><time dateTime={new Date(m.created).toISOString()}>{time(m.created)}</time></header>
  <MessageText text={edits[m.id]?.text??m.text} deleted={!!deleted[m.id]} editedAt={edits[m.id]?.created} mentionsMe={mentionsUser(m,userId)}/>
 </article>;
 return <aside className="chat-thread-pane" aria-label="Thread">
  <header className="chat-thread-head"><strong>Thread</strong><Button size="sm" variant="ghost" icon aria-label="Close thread" title="Close thread (Esc)" onClick={onClose}>×</Button></header>
  <div className="chat-thread-log" ref={log} role="log" aria-label="Replies" onKeyDown={e=>{if(e.key==='Escape')onClose();}}>
   {rootMessage?show(rootMessage):<p className="chat-thread-missing">{deleted[root]?'This message was deleted':'Reply to a message not on this device'}</p>}
   <div className="chat-thread-count" role="separator">{replies.length} {replies.length===1?'reply':'replies'}</div>
   {replies.map(show)}
  </div>
  <form className="account-chat-composer chat-thread-composer" onSubmit={e=>{e.preventDefault();send();}}>
   {error&&<p role="alert">{error}</p>}
   <MentionList id={listId} {...mention} onPick={mention.pick}/>
   <div className="account-chat-input">
    <textarea ref={input} rows={1} aria-label="Reply" placeholder="Reply…" value={draft} maxLength={16000} aria-controls={mention.suggestions.length?listId:undefined}
     onChange={e=>{setDraft(e.target.value);mention.track();}} onSelect={mention.track}
     onKeyDown={e=>{if(mention.onKeyDown(e))return;if(e.key==='Escape'&&!draft){e.preventDefault();onClose();return;}if(isSendKey(e)){e.preventDefault();send();}}}/>
    <Button type="submit" variant="accent" icon aria-label="Send reply" title="Send (Enter)" disabled={!draft.trim()}><SendIcon size={14}/></Button>
   </div>
  </form>
 </aside>;
}
