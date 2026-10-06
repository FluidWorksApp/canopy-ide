import {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {teamSession} from '../teamMessaging/session';
import {Button} from './ui';
import './teamHub.css';
export type AccountConversation={teamId:string;userId:string;peer:string|null;name:string};
export function AccountChatView({conversation,active=true}:{conversation:AccountConversation;active?:boolean}){
 const {teamId,userId,peer,name}=conversation;
 const session=useMemo(()=>teamSession(teamId,userId),[teamId,userId]);
 useEffect(()=>session.retain(),[session]);
 const {messages,members,receipts,status,restoredIds}=useSyncExternalStore(session.subscribe,session.getSnapshot);
 useEffect(()=>{
  const read=()=>{if(active&&document.visibilityState==='visible')session.markRead(peer);};
  read();document.addEventListener('visibilitychange',read);
  return()=>document.removeEventListener('visibilitychange',read);
 },[session,peer,active,messages]);
 const [draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const visible=messages.filter(m=>peer===null?m.recipient===null:(m.sender===peer&&m.recipient===userId)||(m.sender===userId&&m.recipient===peer));
 async function send(){if(busy||!draft.trim())return;setBusy(true);setError('');try{const result=await session.send(draft,peer);setDraft('');if(result.queued)setError('Saved on this device. Sending when you reconnect.');else if(result.partial)setError('Some devices could not be reached; delivery will retry.');}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <section className="account-chat" aria-label={`Chat with ${name}`}>
  <header className="account-chat-header"><div><h2>{name}</h2><span>{peer?'Direct message':'Team channel'}</span></div><small role="status">{status}</small></header>
  <div className="account-chat-transcript" role="log" aria-label="Messages">{!visible.length&&<div className="account-chat-empty"><h3>Start the conversation</h3><p>Messages are encrypted on your device.</p></div>}{visible.map(m=><article className={m.sender===userId?'own':''} key={m.id}><header><strong>{m.sender===userId?'You':members[m.sender]||(peer?name:`Former member (${m.sender.slice(0,8)})`)}</strong><time dateTime={new Date(m.created).toISOString()}>{new Date(m.created).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></header><p>{m.text}</p>{m.sender===userId&&<small>{receipts[m.id]?.length?'Delivered':restoredIds?.includes(m.id)?'Saved on this device':'Awaiting delivery'}</small>}</article>)}</div>
  <form className="account-chat-composer" onSubmit={e=>{e.preventDefault();void send();}}>{error&&<p role="alert">{error}</p>}<div><textarea aria-label="Message" placeholder={`Message ${name}…`} value={draft} onChange={e=>setDraft(e.target.value)} maxLength={16000}/><Button type="submit" disabled={busy||!draft.trim()}>{busy?'Sending…':'Send'}</Button></div><small>Pending deliveries survive restarting the IDE and expire after five minutes. The latest 500 messages per team are saved encrypted on this device.</small></form>
 </section>;
}
