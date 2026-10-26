import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type DragEvent,type MouseEvent} from 'react';
import {teamSession,type DeliveryState,type AttachmentState,type TeamSession} from '../teamMessaging/session';
import type {Attachment,ChatMessage} from '../teamMessaging/client';
import {formatBytes} from '../teamMessaging/files';
import {MAX_ATTACHMENTS,MAX_ATTACHMENT_BYTES} from '../teamMessaging/messageSchema';
import {showConversation} from '../teamMessaging/unread';
import {Button} from './ui';
import {CheckIcon,CopyIcon,DocumentIcon,DownloadIcon,InfoIcon,LockIcon,SendIcon} from './icons';
import {ContextMenu,useContextMenu,type MenuItem} from './ContextMenu';
import {registerSelectAll} from '../selectAll';
import {isSendKey} from './chatComposerKeys';
import './teamHub.css';
import {LinkifiedText} from './LinkifiedText';
import {AddReactionButton,MessageReactions,ReactionPicker} from './MessageReactions';
import {reactionChips} from '../teamMessaging/reactions';
import {ChatLinkCards} from './ChatLinkCards';
import {ChatCard} from './ChatCard';
import {cardCaption,cardOf} from '../teamMessaging/cardSchema';
export type AccountConversation={teamId:string;userId:string;peer:string|null;name:string;email?:string};
/** Consecutive messages from one sender within this window share one header. */
const GROUP_MS=5*60_000;
/** The composer grows with its text up to this many lines, then scrolls. */
const MAX_LINES=6;
/** How close to the newest message counts as having it in view. */
const READ_SLACK_PX=48;
/** How long a copy button shows that it copied. */
const COPIED_MS=1500;
const STORAGE_NOTE='End-to-end encrypted. Pending deliveries survive restarting the IDE and expire after five minutes. The latest 500 messages per team are saved encrypted on this device. Files go directly between devices and are never uploaded: the sender\'s device keeps them for 7 days, yours for 30.';
/** Images up to this size are pulled and previewed without a click. */
const AUTO_IMAGE_BYTES=10*1024*1024;
/** Saves through the webview's download path; the bytes never leave this device. */
function saveBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.rel='noopener';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000);}
/** One attachment in a message: its pull state, an image preview, or Save. */
function AttachmentChip({session,message,file,own,state,sender}:{session:TeamSession;message:ChatMessage;file:Attachment;own:boolean;state?:AttachmentState;sender:string}){
 const [blob,setBlob]=useState<Blob>(),[url,setUrl]=useState<string>();
 const image=file.type.startsWith('image/')&&file.size<=AUTO_IMAGE_BYTES;
 const load=()=>session.attachment(message.id,file.id).then(b=>{setBlob(b);return b;});
 // Own files are already on this device; small received images pull on sight.
 const auto=image&&(own||!state||state.state==='available');
 useEffect(()=>{if(auto&&!blob)void load().catch(()=>{/* shown through state */});},[auto]);// eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{if(!blob||!image)return;const next=URL.createObjectURL(blob);setUrl(next);return()=>URL.revokeObjectURL(next);},[blob,image]);
 const save=()=>void (blob?Promise.resolve(blob):load()).then(b=>saveBlob(b,file.name)).catch(()=>{});
 const retry=()=>void load().catch(()=>{});
 const status=state?.state==='downloading'?<span>Downloading {Math.floor(state.received*100/Math.max(1,state.total))}%</span>
  :state?.state==='unavailable'?state.reason==='offline'?<span>Waiting for {sender} to come online · <button type="button" className="account-chat-action" onClick={retry}>Retry</button></span>:<span>{state.reason==='denied'?'Not shared with you':'No longer available'}</span>
  :state?.state==='failed'?<span title={state.detail}>Failed · <button type="button" className="account-chat-action" onClick={retry}>Retry</button></span>
  :own||blob||state?.state==='available'?(image&&url?null:<button type="button" className="account-chat-action" onClick={save}>Save</button>)
  :<button type="button" className="account-chat-action" onClick={retry}><DownloadIcon size={11}/>Download</button>;
 return <div className="account-chat-file" data-state={state?.state??(own?'available':'idle')}>
  {url?<button type="button" className="account-chat-thumb" onClick={save} title={`Save ${file.name}`}><img src={url} alt={file.name}/></button>:null}
  <div className="account-chat-file-row"><DocumentIcon size={13}/><span className="account-chat-file-name" title={file.name}>{file.name}</span><span className="account-chat-file-size">{formatBytes(file.size)}</span>{status&&<span className="account-chat-file-state">{status}</span>}</div>
 </div>;
}
/** Status copy under your own messages; a receipt shows "Delivered" on the latest one. */
const DELIVERY_LABEL:Record<DeliveryState,string>={sending:'Sending…',sent:'Awaiting delivery',queued:'Saved on this device',waiting:'Waiting for connection',failed:'Not sent',expired:'Not delivered · expired'};
const time=(t:number)=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const dayKey=(t:number)=>new Date(t).toDateString();
/** Whether `el` is a field the user may be typing in right now (on screen and editable). */
const typingIn=(el:Element|null)=>!!el&&el instanceof HTMLElement&&(el.isContentEditable||(el.matches('input,textarea,select')&&!(el as HTMLInputElement).readOnly&&!(el as HTMLInputElement).disabled))&&el.getClientRects().length>0;
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
 const {messages,members,receipts,status,restoredIds,delivery={},attachments={},reactions={},undeliveredReactions={}}=useSyncExternalStore(session.subscribe,session.getSnapshot);
  // On screen: notifications for this conversation stay quiet while the window is focused.
 useEffect(()=>active?showConversation(teamId,userId,peer):undefined,[active,teamId,userId,peer]);
 const [draft,setDraft]=useState(''),[error,setError]=useState('');
 const [files,setFiles]=useState<File[]>([]),[dropping,setDropping]=useState(false);
 const input=useRef<HTMLTextAreaElement>(null),log=useRef<HTMLDivElement>(null),picker=useRef<HTMLInputElement>(null),hintId=useId(),root=useRef<HTMLElement>(null);
 // Opening or switching to a conversation puts the cursor in its message box.
 // Only then: later updates never move focus, and a field the user is typing
 // in elsewhere on screen keeps it.
 useEffect(()=>{
  if(!active)return;const el=input.current;if(!el||el.disabled||el.readOnly)return;
  const current=document.activeElement;if(current!==el&&!root.current?.contains(current)&&typingIn(current))return;
  el.focus({preventScroll:true});
 },[active,teamId,userId,peer]);
 const [reacting,setReacting]=useState<string>(),pickerId=useId();
 const react=(messageId:string,emoji:string)=>{setReacting(undefined);setError('');session.react(messageId,emoji).catch((e:unknown)=>setError(e instanceof Error?e.message:String(e)));};
 const closePicker=(messageId:string)=>{setReacting(undefined);log.current?.querySelector<HTMLElement>(`[data-message="${messageId}"] .account-chat-react`)?.focus();};
 /** Files only join the composer here, so every route (picker, drop, paste) shares the limits. */
 const addFiles=(list:File[])=>{
  if(!list.length)return;const big=list.find(f=>f.size>MAX_ATTACHMENT_BYTES),empty=list.find(f=>!f.size);
  setError(big?`${big.name} is larger than 100 MB`:empty?`${empty.name} is empty`:'');
  setFiles(current=>{const next=[...current,...list.filter(f=>f.size&&f.size<=MAX_ATTACHMENT_BYTES)];if(next.length>MAX_ATTACHMENTS)setError(`Attach up to ${MAX_ATTACHMENTS} files per message`);return next.slice(0,MAX_ATTACHMENTS);});
 };
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
  const text=draft,attached=files;if(!text.trim()&&!attached.length)return;
  setDraft('');setFiles([]);setError('');input.current?.focus();
  (attached.length?session.send(text,peer,attached):session.send(text,peer)).catch((e:unknown)=>{setError(e instanceof Error?e.message:String(e));setDraft(current=>current||text);setFiles(current=>current.length?current:attached);});
 }
 const act=(work:()=>unknown)=>{try{void Promise.resolve(work()).catch(()=>{});}catch{/* the message status already shows the failure */}};
 const senderName=(id:string)=>id===userId?'You':members[id]||(peer?name:`Former member (${id.slice(0,8)})`);
 const menu=useContextMenu(),[copied,setCopied]=useState<string>(),copiedTimer=useRef<number>(undefined);
 useEffect(()=>()=>window.clearTimeout(copiedTimer.current),[]);
 const copy=(text:string,id:string)=>void navigator.clipboard.writeText(text).then(()=>{setCopied(id);window.clearTimeout(copiedTimer.current);copiedTimer.current=window.setTimeout(()=>setCopied(undefined),COPIED_MS);}).catch(()=>{});
 // Select All inside the transcript selects the conversation, not the app.
 useEffect(()=>{const el=log.current;return el?registerSelectAll(el,()=>window.getSelection()?.selectAllChildren(el)):undefined;},[]);
 const transcriptMenu=(e:MouseEvent<HTMLDivElement>)=>{
  const sel=window.getSelection(),picked=sel&&!sel.isCollapsed&&log.current?.contains(sel.anchorNode)?sel.toString():'';
  const id=(e.target as HTMLElement).closest<HTMLElement>('[data-message]')?.dataset.message,text=visible.find(m=>m.id===id)?.text;
  const items:MenuItem[]=[];
  if(picked.trim())items.push({label:'Copy',onClick:()=>copy(picked,'selection')});
  if(id&&text)items.push({label:'Copy message',onClick:()=>copy(text,id)});
  if(items.length)menu.open(e,items);
 };
 const hasFiles=(e:DragEvent)=>[...e.dataTransfer.types].includes('Files');
 return <section ref={root} className={`account-chat${dropping?' is-dropping':''}`} aria-label={`Chat with ${name}`}
  onDragOver={e=>{if(!hasFiles(e))return;e.preventDefault();setDropping(true);}} onDragLeave={e=>{if(e.currentTarget===e.target)setDropping(false);}}
  onDrop={e=>{if(!hasFiles(e))return;e.preventDefault();setDropping(false);addFiles([...e.dataTransfer.files]);}}>
  <header className="account-chat-header">
   <span aria-hidden="true" className="team-avatar">{peer?name.slice(0,1).toUpperCase():'#'}</span>
   <div className="account-chat-title"><h2>{name}</h2><span>{peer?(email||'Direct message'):'Everyone in this team'}</span></div>
   <small role="status" className={`account-chat-status${connected?' is-connected':''}`} title={status}>{connected?<><LockIcon size={12}/>Encrypted</>:status}</small>
   <span className="account-chat-info" tabIndex={0} role="img" aria-label={STORAGE_NOTE} title={STORAGE_NOTE}><InfoIcon size={14}/></span>
  </header>
  <div className="account-chat-transcript" role="log" aria-label="Messages" ref={log} tabIndex={-1} onContextMenu={transcriptMenu}>
   {!visible.length&&<div className="account-chat-empty"><LockIcon size={16}/><p>Say hello to {name}. Messages are end-to-end encrypted.</p></div>}
   {visible.map((m,i)=>{
    const prev=visible[i-1],own=m.sender===userId;
    const newDay=!prev||dayKey(prev.created)!==dayKey(m.created);
    const grouped=!newDay&&prev.sender===m.sender&&m.created-prev.created<GROUP_MS;
    const delivered=own&&!!receipts[m.id]?.length,state=own&&!delivered?delivery[m.id]?.state??(restoredIds?.includes(m.id)?'queued':'sent'):undefined;
    const failed=state==='failed'||state==='expired'||state==='waiting',pending=!!state&&!failed;
    const receipt=state?DELIVERY_LABEL[state]:delivered&&m.id===lastOwn?'Delivered':'';
    const card=cardOf(m),caption=card?cardCaption(m.text,card):m.text;
    return <div key={m.id} className={`account-chat-row${own?' own':''}`}>
     {newDay&&<div className="account-chat-day" role="separator"><span>{dayLabel(m.created)}</span></div>}
     <article className={`account-chat-msg${own?' own':''}${grouped?' grouped':''}${pending?' pending':''}${failed?' failed':''}`} data-delivery={delivered?'delivered':state} data-message={m.id}>
      {m.text&&<button type="button" className={`account-chat-copy${copied===m.id?' is-copied':''}`} aria-label={copied===m.id?'Copied':'Copy message'} title={copied===m.id?'Copied':'Copy message'} onMouseDown={e=>e.preventDefault()} onClick={()=>copy(m.text,m.id)}>{copied===m.id?<><CheckIcon size={12}/>Copied</>:<CopyIcon size={12}/>}</button>}
      {!grouped&&<header><strong>{senderName(m.sender)}</strong><time dateTime={new Date(m.created).toISOString()}>{time(m.created)}</time></header>}
      {caption&&<p title={time(m.created)}><LinkifiedText text={caption} anyProject/></p>}
      <AddReactionButton open={reacting===m.id} controls={pickerId} className={m.text?'beside-copy':undefined} onToggle={()=>setReacting(current=>current===m.id?undefined:m.id)}/>
      {m.text&&!card&&<ChatLinkCards text={m.text}/>}
      {card&&<ChatCard message={m} userId={userId} messages={visible} name={senderName} onReply={(text,ext)=>session.send(text,peer,[],ext)}/>}
      {m.attachments?.map(file=><AttachmentChip key={file.id} session={session} message={m} file={file} own={own} state={attachments[file.id]} sender={senderName(m.sender)}/>)}
      <MessageReactions chips={reactionChips(reactions,m.id,userId)} undelivered={undeliveredReactions[m.id]} name={senderName} onToggle={emoji=>react(m.id,emoji)}
       picker={reacting===m.id?<ReactionPicker id={pickerId} onPick={emoji=>{closePicker(m.id);react(m.id,emoji);}} onClose={()=>closePicker(m.id)} onDismiss={()=>setReacting(undefined)}/>:undefined}/>
      {receipt&&<small title={state?delivery[m.id]?.detail:undefined}>{receipt}{failed&&<> · <button type="button" className="account-chat-action" onClick={()=>act(()=>session.retry(m.id))}>Retry</button> · <button type="button" className="account-chat-action" onClick={()=>act(()=>session.discard(m.id))}>Discard</button></>}</small>}
     </article>
    </div>;
   })}
  </div>
  {menu.menu&&<ContextMenu x={menu.menu.x} y={menu.menu.y} items={menu.menu.items} onClose={menu.close}/>}
  <form className="account-chat-composer" onSubmit={e=>{e.preventDefault();void send();}}>
   {error&&<p role="alert">{error}</p>}
   {files.length>0&&<ul className="account-chat-pending" aria-label="Attachments">{files.map((f,i)=><li key={`${f.name}:${i}`}><span title={f.name}>{f.name}</span> · {formatBytes(f.size)}<button type="button" aria-label={`Remove ${f.name}`} onClick={()=>setFiles(current=>current.filter((_,j)=>j!==i))}>×</button></li>)}</ul>}
   <div className="account-chat-input">
    <input ref={picker} type="file" multiple hidden aria-hidden="true" tabIndex={-1} onChange={e=>{addFiles([...(e.target.files??[])]);e.currentTarget.value='';}}/>
    <Button type="button" variant="ghost" icon className="account-chat-attach" aria-label="Attach files" title="Attach files · sent directly between devices, never uploaded" onClick={()=>picker.current?.click()}>📎</Button>
    <textarea ref={input} rows={1} aria-label="Message" aria-describedby={hintId} placeholder={`Message ${name}…`} value={draft} onChange={e=>setDraft(e.target.value)} onPaste={e=>{const pasted=[...(e.clipboardData?.files??[])];if(!pasted.length)return;e.preventDefault();addFiles(pasted);}} onKeyDown={e=>{if(isSendKey(e)){e.preventDefault();void send();}}} maxLength={16000}/>
    <Button type="submit" variant="accent" icon aria-label="Send" title="Send (Enter)" disabled={!draft.trim()&&!files.length}><SendIcon size={14}/></Button>
   </div>
   <small id={hintId} className="account-chat-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</small>
  </form>
 </section>;
}
