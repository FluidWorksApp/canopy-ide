import {loadChatHistory,saveChatMessage,forgetChatMessage,loadChatReadState,saveChatReadState,loadChatEvents,saveChatEvent,forgetChatEvent,saveChatRecord,loadChatRecords,forgetChatRecords} from './history';
import {BACKFILL_MS,CHAT_VERSION,EDITS_VERSION,DELETE_TEXT,MAX_TEXT_BYTES,editText,eventOf,eventRecipient,parseExtensions,parseMentions,reactionText,validEmoji} from './chatEvents';
import {applyEvent,drainPending,hasReacted,newer,nextReactionTime,EMPTY_OVERLAY,type DeleteEntry,type EditEntry,type EventOverlay,type ReactionState} from './reactions';
import {invoke} from '@tauri-apps/api/core';
import {PeerClient,AttachmentUnavailable,type Attachment,type AttachmentState,type ChatMessage,type Device,type MessageDraft} from './client';
import {prepareFile} from './files';
import {MAX_ATTACHMENTS} from './messageSchema';
import type {JobRequest,JobStatus,MeshMessage,MeshStatus,Roster,RosterRequest} from './jobSchema';
import {conversationKey,countUnread,threadRoot,type ConversationUnread} from './unread';
import {getSettings} from '../settings';

/** Local lifecycle of a message this account sent. A delivery receipt (tracked
 * in `receipts`) supersedes every state here.
 * - sending: shown optimistically; encryption, local save and delivery still running
 * - sent: accepted by the relay or a direct channel, awaiting a receipt
 * - queued: ciphertext saved in the pending-delivery queue on this device
 * - waiting: could not be encrypted while offline; resent automatically on reconnect
 * - failed: not sent; the sender can retry or discard it
 * - expired: pending delivery expired (or was never confirmed before a restart) */
export type DeliveryState='sending'|'sent'|'queued'|'waiting'|'failed'|'expired';
export type Delivery={state:DeliveryState;detail?:string};
export type SendOutcome={id:string;delivery?:Delivery};
export type {AttachmentState};
/** Who a message whose delivery expired is still waiting for, and until when
 * it will be re-sent to them (backfill) once one of their devices is online. */
export type Awaiting={users:string[];until:number};
/** Options of a new message: a reply in `thread` (a root message id) and the
 * people it names. */
export type SendOptions={thread?:string;mentions?:string[];mentionsAll?:boolean};
type Snapshot={unreadIds:string[];restoredIds:string[];members:Record<string,string>;messages:ChatMessage[];receipts:Record<string,string[]>;delivery:Record<string,Delivery>;attachments:Record<string,AttachmentState>;reactions:ReactionState;undeliveredReactions:Record<string,string[]>;status:string;
 /** Latest edit per message id. */
 edits:Record<string,EditEntry>;
 /** Deleted message ids (by their author), this run or remembered as tombstones. */
 deleted:Record<string,DeleteEntry>;
 /** When the next automatic retry of a queued message is due. */
 retryAt:Record<string,number>;
 /** Read watermarks: JSON [reader, conversation] → newest message of this account's they read. */
 reads:Record<string,string>;
 awaiting:Record<string,Awaiting>};
/** Peers refuse messages created more than five minutes before their envelope. */
const STALE_MS=4*60_000;
/** Read receipts wait this long after reading, so scrolling sends one, not many. */
export const READ_RECEIPT_DELAY_MS=1500;
/** Deleted message ids are remembered this long, so a late copy cannot bring one back. */
export const TOMBSTONE_MS=30*86_400_000;
/** Backfilled messages arriving within this window are announced together. */
const BACKFILL_SUMMARY_MS=1500;
const reason=(error:unknown)=>error instanceof Error?error.message:String(error);
const empty=(status:string):Snapshot=>({unreadIds:[],restoredIds:[],members:{},messages:[],receipts:{},delivery:{},attachments:{},reactions:{},undeliveredReactions:{},status,edits:{},deleted:{},retryAt:{},reads:{},awaiting:{}});
const watermarkKey=(user:string,conversation:string)=>JSON.stringify([user,conversation]);
const bytes=(value:string)=>new TextEncoder().encode(value).length;
/** Read receipts are reciprocal: off neither sends nor shows them. */
export const readReceiptsOn=()=>{try{return getSettings().teamReadReceipts!==false;}catch{return true;}};
type LedgerEntry={messageId:string;user:string;deviceId?:string;until:number};
const validLedger=(value:unknown):value is LedgerEntry=>{const e=value as LedgerEntry;return !!e&&typeof e==='object'&&typeof e.messageId==='string'&&typeof e.user==='string'&&(e.deviceId===undefined||typeof e.deviceId==='string')&&Number.isSafeInteger(e.until);};
type Tombstone={sender:string;at:number};
const validTombstone=(value:unknown):value is Tombstone=>{const t=value as Tombstone;return !!t&&typeof t==='object'&&typeof t.sender==='string'&&Number.isSafeInteger(t.at);};
/** Inserts by (created, id), for a message that arrives after later ones (backfill). */
function insertSorted(messages:ChatMessage[],m:ChatMessage){
 const at=messages.findIndex(x=>x.created>m.created||(x.created===m.created&&x.id>m.id));
 return at<0?[...messages,m]:[...messages.slice(0,at),m,...messages.slice(at)];
}
// One transport per account/team, shared by all conversation tabs in this IDE.
const sessions=new Map<string,TeamSession>();
const unreadListeners=new Set<()=>void>();
export const subscribeTeamUnread=(listener:()=>void)=>{unreadListeners.add(listener);return()=>{unreadListeners.delete(listener);};};
/** Unread counts per session, keyed `${user}:${team}`. Stable between changes for `useSyncExternalStore`. */
export type TeamUnreadSummary=Record<string,ConversationUnread>;
let summary:{json:string;value:TeamUnreadSummary}={json:'{}',value:{}};
export function getUnreadSummary():TeamUnreadSummary{
 const value:TeamUnreadSummary={};
 for(const [key,session] of sessions){const counts=session.unread();if(counts.total)value[key]=counts;}
 const json=JSON.stringify(value);if(json!==summary.json)summary={json,value};
 return summary.value;
}
export const getTeamUnread=()=>Object.values(getUnreadSummary()).reduce((sum,counts)=>sum+counts.total,0);
/** A message from someone else that this device had not seen before.
 * `replyToOwn`: a thread reply whose root this account wrote. `backfill`: the
 * number of messages from this sender that arrived late, after this device was
 * away (set when more than one arrived together; `message` is the newest). */
export type TeamMessageEvent={team:string;user:string;message:ChatMessage;senderName?:string;replyToOwn?:boolean;backfill?:number};
const messageListeners=new Set<(event:TeamMessageEvent)=>void>();
export const subscribeTeamMessages=(listener:(event:TeamMessageEvent)=>void)=>{messageListeners.add(listener);return()=>{messageListeners.delete(listener);};};
/** Who sent a job or job status, as the envelope proved it: `user` is the
 * server-authenticated account, `device` the signing device. */
export type TeamJobSender={user:string;device:string;name?:string};
/** `workspace` is set for v2 workspace traffic: the cloud workspace the envelope's signed header names. */
export type TeamJobEvent={team:string;user:string;sender:TeamJobSender;workspace?:string}&({kind:'job';job:JobRequest}|{kind:'job-status';status:JobStatus}|{kind:'mesh';message:MeshMessage}|{kind:'mesh-status';status:MeshStatus}|{kind:'roster';roster:Roster});
const jobListeners=new Set<(event:TeamJobEvent)=>void>();
export const subscribeTeamJobs=(listener:(event:TeamJobEvent)=>void)=>{jobListeners.add(listener);return()=>{jobListeners.delete(listener);};};
export class TeamSession {
 private listeners=new Set<()=>void>();
 private client:PeerClient;
 private refs=0;
 private invalid=false;
 private releaseGeneration=0;
 private snapshot:Snapshot=empty('Connecting securely…');
 /** Resolves once history is restored and the transport has its device identity. */
 private ready:Promise<void>=Promise.resolve();
 /** Sends run one at a time so rapid messages keep their order. */
 private outgoing:Promise<unknown>=Promise.resolve();
 private saves=new Map<string,Promise<unknown>>();
 private discarded=new Set<string>();
 /** Bytes of files this account is sending, until the transport has stored them locally. */
 private blobs=new Map<string,Blob>();
 /** Read state restored: an unconfirmed restored message without pending ciphertext was not delivered. */
 private receiptsRestored=false;
 /** Deleted message ids and their authors (30 days), so a late or backfilled copy stays deleted. */
 private tombstones=new Map<string,Tombstone>();
 /** This account's own events by id (for backfill), and every edit event id per target (to forget on delete). */
 private ownEvents=new Map<string,ChatMessage>();
 private editEvents=new Map<string,Set<string>>();
 /** Expired deliveries to backfill, by `${messageId}:${deviceId ?? '*'+user}`. */
 private ledger=new Map<string,LedgerEntry>();
 /** Watermarks this account sent (JSON [author, conversation] → id), and ones waiting for the debounce. */
 private readSent:Record<string,string>={};
 private readQueue=new Map<string,{author:string;id:string}>();
 private readTimer?:ReturnType<typeof setTimeout>;
 private backfillBatch=new Map<string,ChatMessage[]>();
 private backfillTimer?:ReturnType<typeof setTimeout>;
 readonly team:string;
 readonly user:string;
 constructor(team:string,user:string){
  this.team=team;this.user=user;
  this.client=new PeerClient({team,user,request:body=>invoke('canopy_account_request',{route:'/api/peers',body}),
   // Events (reactions, edits, deletes) are saved apart from messages, outside
   // the 500-message cap. A deleted message is never saved again.
   persist:message=>eventOf(message)?saveChatEvent(this.user,this.team,message):this.tombstoned(message)?Promise.resolve():saveChatMessage(this.user,this.team,message),
   members:members=>this.update({members:Object.fromEntries(members.map(m=>[m.id,m.name]))}),
   message:(message,meta)=>this.receive(message,meta?.backfill===true),
   job:(job,sender)=>this.emitJob(sender,{kind:'job',job}),
   jobStatus:(status,sender,workspace)=>this.emitJob(sender,{kind:'job-status',status},workspace),
   mesh:(message,sender,workspace)=>this.emitJob(sender,{kind:'mesh',message},workspace),
   meshStatus:(status,sender,workspace)=>this.emitJob(sender,{kind:'mesh-status',status},workspace),
   roster:(roster,sender,workspace)=>this.emitJob(sender,{kind:'roster',roster},workspace),
   receipt:(id,user)=>{
    if(this.invalid)return;
    this.settleLedger(id,user);
    if(!this.snapshot.messages.some(m=>m.id===id))return;
    const {[id]:_retry,...retryAt}=this.snapshot.retryAt;
    this.update({receipts:{...this.snapshot.receipts,[id]:[...new Set([...(this.snapshot.receipts[id]??[]),user])].slice(-512)},retryAt});this.persistReadState();
   },
   read:(id,reader)=>this.acceptRead(id,reader),
   retrying:(id,at)=>{if(!this.invalid&&this.snapshot.messages.some(m=>m.id===id)&&this.snapshot.retryAt[id]!==at)this.update({retryAt:{...this.snapshot.retryAt,[id]:at}});},
   undelivered:(id,device)=>this.recordUndelivered(id,device),
   online:device=>this.deviceOnline(device),
   status:status=>{this.update({status});if(status.startsWith('Connected'))this.resendWaiting();},
   pending:ids=>{
    const pending=new Set(ids),delivery={...this.snapshot.delivery};
    for(const m of this.snapshot.messages){
     if(m.sender!==this.user||delivery[m.id]||this.snapshot.receipts[m.id]?.length)continue;
     if(pending.has(m.id))delivery[m.id]={state:'queued'};else if(this.receiptsRestored)delivery[m.id]={state:'expired'};
    }
    this.update({delivery});
   },
   expired:id=>{if(!this.snapshot.receipts[id]?.length)this.setDelivery(id,{state:'expired'});const {[id]:_retry,...retryAt}=this.snapshot.retryAt;if(_retry!==undefined)this.update({retryAt});},
   relayed:id=>{if(this.snapshot.delivery[id]?.state==='queued')this.setDelivery(id,{state:'sent'});},
   attachment:({attachmentId,messageId:_message,...state})=>this.setAttachment(attachmentId,state as AttachmentState)});
 }
 private async start(){
  try{const account=await invoke<{user:{id:string}}>('canopy_account_request',{route:'/api/me',body:null});if(this.invalid)return;if(account.user?.id!==this.user){this.clear('Sign in to the account that owns this conversation.');return;}}catch{this.clear('Sign in to restore this conversation.');return;}
  await this.restoreRecords();if(this.invalid)return;
  try{
   const history=(await loadChatHistory(this.user,this.team)).filter(m=>!this.tombstoned(m));if(this.invalid)return;
   let restored=true;
   const state=await loadChatReadState(this.user,this.team).catch(()=>{restored=false;this.update({status:'Local read status could not be restored.'});return {unreadIds:history.filter(m=>m.sender!==this.user).map(m=>m.id),receipts:{}} as Awaited<ReturnType<typeof loadChatReadState>>;});if(this.invalid)return;
   const ids=new Set(history.map(m=>m.id));
   // Messages sent or received while history loaded stay, after the restored ones.
   const live=this.snapshot.messages.filter(m=>!ids.has(m.id));
   this.receiptsRestored=restored;this.readSent={...(state.readSent??{})};
   this.update({messages:[...history,...live].slice(-500),restoredIds:[...ids],unreadIds:[...new Set([...state.unreadIds.filter(id=>ids.has(id)),...this.snapshot.unreadIds])],receipts:{...Object.fromEntries(Object.entries(state.receipts).filter(([id])=>ids.has(id))),...this.snapshot.receipts},reads:{...(state.reads??{}),...this.snapshot.reads}});
  }catch{this.update({status:'Local history could not be restored.'});}
  try{const events=await loadChatEvents(this.user,this.team);if(this.invalid)return;this.applyEvents(events);}
  catch{this.update({status:'Local reactions could not be restored.'});}
  this.refreshAwaiting();
  if(!this.invalid)await this.client.start().catch(e=>this.update({status:String(e)}));
 }
 /** Tombstones and the backfill ledger. Either failing to load leaves it empty. */
 private async restoreRecords(){
  const now=Date.now();
  try{
   const stones=await loadChatRecords(this.user,this.team,'tombstone');const stale:string[]=[];
   for(const [id,t] of Object.entries(stones)){if(!validTombstone(t)||now-t.at>TOMBSTONE_MS)stale.push(id);else this.tombstones.set(id,t);}
   void forgetChatRecords(this.user,this.team,'tombstone',stale).catch(()=>{});
   if(this.tombstones.size)this.overlay={...this.overlay,deleted:{...this.overlay.deleted,...Object.fromEntries([...this.tombstones].map(([id,t])=>[id,{created:t.at,id:'tombstone'}]))}};
  }catch{/* nothing remembered */}
  try{
   const rows=await loadChatRecords(this.user,this.team,'ledger');const stale:string[]=[];
   for(const [key,e] of Object.entries(rows)){if(!validLedger(e)||e.until<=now)stale.push(key);else this.ledger.set(key,e);}
   void forgetChatRecords(this.user,this.team,'ledger',stale).catch(()=>{});
  }catch{/* nothing to backfill */}
  this.update({deleted:this.overlay.deleted});
 }
 private emitJob(sender:Device,body:{kind:'job';job:JobRequest}|{kind:'job-status';status:JobStatus}|{kind:'mesh';message:MeshMessage}|{kind:'mesh-status';status:MeshStatus}|{kind:'roster';roster:Roster},workspace?:string){
  if(this.invalid)return;
  const event:TeamJobEvent={team:this.team,user:this.user,sender:{user:sender.user_id,device:sender.id,name:this.snapshot.members[sender.user_id]},...(workspace?{workspace}:{}),...body};
  jobListeners.forEach(fn=>{try{fn(event);}catch{/* a listener never breaks delivery */}});
 }
 /** Team members by account id, as the directory last named them. */
 members(){return this.snapshot.members;}
 devices(){return this.invalid?[]:this.client.directoryDevices();}
 deviceId(){return this.client.deviceId();}
 async submitJob(job:JobRequest,recipient:string,device?:string){
  if(this.invalid)throw Error('Sign in again to submit jobs');
  await this.ready;return this.client.sendJob(job,recipient,device);
 }
 hosts(){return this.invalid?[]:this.client.directoryHosts();}
 async submitWorkspaceJob(job:JobRequest,workspace:string){
  if(this.invalid)throw Error('Sign in again to submit jobs');
  await this.ready;return this.client.sendWorkspaceJob(job,workspace);
 }
 async sendWorkspaceMessage(message:MeshMessage,workspace:string){
  if(this.invalid)throw Error('Sign in again to message agents');
  await this.ready;return this.client.sendWorkspaceMessage(message,workspace);
 }
 async requestWorkspaceRoster(request:RosterRequest,workspace:string){
  if(this.invalid)throw Error('Sign in again to reach cloud workspaces');
  await this.ready;return this.client.sendWorkspaceRosterRequest(request,workspace);
 }
 async sendJobStatus(status:JobStatus,device:string){
  if(this.invalid)throw Error('Signed out of this team');
  await this.ready;return this.client.sendJobStatus(status,device);
 }
 private persistReadState(){
  if(this.invalid)return;
  const ids=new Set(this.snapshot.messages.map(m=>m.id));
  const keep=(map:Record<string,string>)=>Object.fromEntries(Object.entries(map).slice(-1000));
  const state={unreadIds:this.snapshot.unreadIds,receipts:Object.fromEntries(Object.entries(this.snapshot.receipts).filter(([id])=>ids.has(id))),
   ...(Object.keys(this.snapshot.reads).length?{reads:keep(this.snapshot.reads)}:{}),...(Object.keys(this.readSent).length?{readSent:keep(this.readSent)}:{})};
  void saveChatReadState(this.user,this.team,state).catch(()=>this.update({status:'Read status could not be saved on this device.'}));
 }
 /** Reactions and other events laid over the messages; waiting events sit in `overlay.pending`. */
 private overlay:EventOverlay=EMPTY_OVERLAY;
 private find=(id:string)=>this.snapshot.messages.find(m=>m.id===id);
 private setOverlay(next:EventOverlay){
  if(next===this.overlay)return;
  const prior=this.overlay;this.overlay=next;
  const change:Partial<Snapshot>={};
  if(next.reactions!==prior.reactions)change.reactions=next.reactions;
  if(next.edits!==prior.edits)change.edits=next.edits;
  if(next.deleted!==prior.deleted){
   change.deleted=next.deleted;
   for(const id of Object.keys(next.deleted))if(!prior.deleted[id])this.removeDeleted(id);
  }
  if(Object.keys(change).length)this.update(change);
 }
 private applyEvents(events:ChatMessage[]){
  if(this.invalid)return;let next=this.overlay;
  for(const event of events){
   const e=eventOf(event);
   if(e?.type==='edit'){const ids=this.editEvents.get(e.target)??new Set<string>();ids.add(event.id);this.editEvents.set(e.target,ids);}
   if(event.sender===this.user&&this.ownEvents.size<2000)this.ownEvents.set(event.id,event);
   next=applyEvent(next,event,this.find);
  }
  this.setOverlay(next);
 }
 private drainEvents(){if(!this.invalid)this.setOverlay(drainPending(this.overlay,this.find));}
 private tombstoned(m:Pick<ChatMessage,'id'|'sender'>){const t=this.tombstones.get(m.id);return !!t&&t.sender===m.sender;}
 /** A message from the transport: a new or repeated message, or an event. */
 private receive(message:ChatMessage,backfill:boolean){
  if(this.invalid||this.discarded.has(message.id))return;
  // An event changes an earlier message; it is not a message itself, so it
  // never joins the transcript or unreadIds and never reaches the message
  // listeners: no unread badge, no notification.
  if(eventOf(message)){this.applyEvents([message]);return;}
  // A deleted message stays deleted, whether its copy arrives late or backfilled.
  if(this.tombstoned(message))return;
  // Own messages (including echoes from this account's other devices) and
  // repeats of a message already shown never count as unread.
  const fresh=!this.snapshot.messages.some(m=>m.id===message.id),incoming=fresh&&message.sender!==this.user;
  const last=this.snapshot.messages.at(-1),late=!!last&&(last.created>message.created||(last.created===message.created&&last.id>message.id));
  const messages=fresh?(backfill&&late?insertSorted(this.snapshot.messages,message):[...this.snapshot.messages,message]).slice(-500):this.snapshot.messages;
  this.update({unreadIds:incoming?[...this.snapshot.unreadIds.slice(-499),message.id]:this.snapshot.unreadIds,messages});this.persistReadState();
  if(fresh)this.drainEvents();
  if(!incoming)return;
  if(backfill){this.queueBackfillSummary(message);return;}
  this.emitMessage(message);
 }
 private emitMessage(message:ChatMessage,backfill?:number){
  const root=threadRoot(message,this.find),replyToOwn=!!root&&this.find(root)?.sender===this.user;
  const event:TeamMessageEvent={team:this.team,user:this.user,message,senderName:this.snapshot.members[message.sender],...(replyToOwn?{replyToOwn}:{}),...(backfill&&backfill>1?{backfill}:{})};
  messageListeners.forEach(fn=>{try{fn(event);}catch{/* a listener never breaks delivery */}});
 }
 /** Messages that arrive late (backfill) are announced once per sender. */
 private queueBackfillSummary(message:ChatMessage){
  const list=this.backfillBatch.get(message.sender)??[];list.push(message);this.backfillBatch.set(message.sender,list);
  clearTimeout(this.backfillTimer);
  this.backfillTimer=setTimeout(()=>{
   const batches=[...this.backfillBatch.values()];this.backfillBatch.clear();
   for(const batch of batches){const newest=batch.reduce((a,b)=>b.created>a.created?b:a);if(!this.tombstoned(newest))this.emitMessage(newest,batch.length);}
  },BACKFILL_SUMMARY_MS);
 }
 /** Adds `emoji` to a message, or removes it when this account already has it
  * there. Shown at once, saved, then sent to the conversation's devices that
  * understand reactions. Rejects only when it could not be sent at all. */
 async react(messageId:string,emoji:string){
  if(this.invalid)throw Error('Sign in again to react');
  if(!validEmoji(emoji))throw Error('Pick a single emoji');
  const target=this.find(messageId);if(!target)throw Error('This message is not in the conversation');
  if(this.snapshot.deleted[messageId])throw Error('This message was deleted');
  const op=hasReacted(this.snapshot.reactions,messageId,this.user,emoji)?'remove':'add';
  const event:ChatMessage={id:crypto.randomUUID(),sender:this.user,recipient:eventRecipient(target,this.user),text:reactionText(emoji,op,target),created:nextReactionTime(this.snapshot.reactions,messageId,this.user,emoji),v:CHAT_VERSION,event:{type:'reaction',target:messageId,emoji,op}};
  this.applyEvents([event]);
  const saved=saveChatEvent(this.user,this.team,event).catch(()=>this.update({status:'Reactions could not be saved on this device.'}));
  await this.ready.catch(()=>{});await saved;if(this.invalid)return;
  const result=await this.client.sendEvent(event);if(this.invalid)return;
  // Nobody in the conversation is known to run a Canopy with reactions: say so on
  // the chip instead of looking sent, and remember to deliver it when one of
  // their devices next comes online on 0.4.11 or later (the ledger).
  if(result.devices===0){
   const members=Object.keys(this.snapshot.members).filter(u=>u!==this.user);
   const users=target.recipient!==null?[eventRecipient(target,this.user)!]:members.length?members:['*'];
   for(const user of users.slice(0,200))this.putLedger({messageId:event.id,user,until:event.created+BACKFILL_MS});
  }
  this.refreshAwaiting();
 }
 /** Changes the text of one of this account's messages. Shown at once and sent
  * only to devices that understand edits (0.4.11+); older ones keep the
  * original. Never notifies anyone. */
 async edit(messageId:string,text:string){
  if(this.invalid)throw Error('Sign in again to edit messages');
  const target=this.find(messageId);
  if(!target||target.sender!==this.user)throw Error('You can only edit your own messages');
  if(this.snapshot.deleted[messageId])throw Error('This message was deleted');
  if(!text.trim())throw Error('Write a message first');
  if(bytes(text)>MAX_TEXT_BYTES)throw Error('Write a message under 16 KB');
  if(text===(this.snapshot.edits[messageId]?.text??target.text))return;
  const mentions=this.mentionsIn(text);
  const created=Math.max(Date.now(),(this.snapshot.edits[messageId]?.created??target.created)+1);
  const event:ChatMessage={id:crypto.randomUUID(),sender:this.user,recipient:eventRecipient(target,this.user),text:editText(text),created,v:CHAT_VERSION,event:{type:'edit',target:messageId,text,...(mentions?{mentions}:{})}};
  if(bytes(JSON.stringify({kind:'message',message:event}))>32000)throw Error('This edit is too large after encoding.');
  await this.sendOwnEvent(event,'Edits could not be saved on this device.');
 }
 /** People in the conversation of `peer` (null: the channel) with a device on
  * an older Canopy: they keep a message this account deletes, and see its
  * original text after an edit. */
 olderRecipients(peer:string|null):string[]{return this.invalid?[]:this.client.usersBelow?.(EDITS_VERSION,peer)??[];}
 /** Deletes one of this account's messages here and on every device that
  * understands deletes (0.4.11+). Rejects only when nothing could be done. */
 async remove(messageId:string){
  if(this.invalid)throw Error('Sign in again to delete messages');
  const target=this.find(messageId);
  if(!target||target.sender!==this.user)throw Error('You can only delete your own messages');
  if(this.snapshot.deleted[messageId])return;
  const event:ChatMessage={id:crypto.randomUUID(),sender:this.user,recipient:eventRecipient(target,this.user),text:DELETE_TEXT,created:Math.max(Date.now(),target.created+1),v:CHAT_VERSION,event:{type:'delete',target:messageId}};
  // Pending deliveries of the original stop; nobody gets it from here any more.
  void this.client.discard(messageId).catch(()=>{});
  this.dropLedger(messageId);
  await this.sendOwnEvent(event,'The delete could not be saved on this device.');
 }
 private async sendOwnEvent(event:ChatMessage,saveError:string){
  this.applyEvents([event]);
  const saved=saveChatEvent(this.user,this.team,event).catch(()=>this.update({status:saveError}));
  await this.ready.catch(()=>{});await saved;if(this.invalid)return;
  await this.client.sendEvent(event);
 }
 /** A message was deleted by its author: forget it everywhere on this device. */
 private removeDeleted(id:string){
  const target=this.find(id);
  if(!target){return;}
  const tombstone={sender:target.sender,at:Date.now()};
  const quietly=(work:()=>Promise<unknown>|undefined)=>{try{void work()?.catch(()=>{});}catch{/* storage is best effort */}};
  if(!this.tombstones.has(id)){this.tombstones.set(id,tombstone);quietly(()=>saveChatRecord(this.user,this.team,'tombstone',id,tombstone));}
  quietly(()=>forgetChatMessage(this.user,this.team,id));
  for(const eventId of this.editEvents.get(id)??[])quietly(()=>forgetChatEvent(this.user,this.team,eventId));
  this.editEvents.delete(id);
  if(target.attachments?.length){for(const a of target.attachments)this.blobs.delete(a.id);if(target.sender!==this.user)quietly(()=>this.client.forgetReceivedFiles?.(target));}
  // The transcript keeps a stub, so its thread and the "deleted" line stay in place.
  const stub:ChatMessage={id:target.id,sender:target.sender,recipient:target.recipient,text:'',created:target.created};
  this.update({messages:this.snapshot.messages.map(m=>m.id===id?stub:m),unreadIds:this.snapshot.unreadIds.filter(x=>x!==id)});
  this.persistReadState();
 }
 private update(change:Partial<Snapshot>){if(this.invalid)return;this.snapshot={...this.snapshot,...change};this.listeners.forEach(fn=>fn());unreadListeners.forEach(fn=>fn());}
 /** Marks a conversation read: its messages and its replies in threads this
  * account follows stay unread until that thread is opened (`markThreadRead`). */
 markRead(peer:string|null){
  const inConversation=(m:ChatMessage)=>peer===null?m.recipient===null:m.sender===peer&&m.recipient===this.user;
  this.clearUnread(m=>inConversation(m)&&!threadRoot(m,this.find));
 }
 /** Marks the replies of one thread read. */
 markThreadRead(root:string){this.clearUnread(m=>threadRoot(m,this.find)===root);}
 private clearUnread(match:(m:ChatMessage)=>boolean){
  const unread=new Set(this.snapshot.unreadIds),read=this.snapshot.messages.filter(m=>unread.has(m.id)&&match(m));
  if(!read.length)return;
  const ids=new Set(read.map(m=>m.id));
  this.update({unreadIds:this.snapshot.unreadIds.filter(id=>!ids.has(id))});this.persistReadState();
  this.queueReadReceipts(read);
 }
 /** Read receipts: the newest message read per author and conversation,
  * sent once reading settles. */
 private queueReadReceipts(read:ChatMessage[]){
  if(!readReceiptsOn())return;
  for(const m of read){
   if(m.sender===this.user)continue;
   const key=watermarkKey(m.sender,conversationKey(m,this.user)),prior=this.readQueue.get(key),priorMessage=prior&&this.find(prior.id);
   if(!priorMessage||newer(m,priorMessage))this.readQueue.set(key,{author:m.sender,id:m.id});
  }
  if(!this.readQueue.size)return;
  clearTimeout(this.readTimer);
  this.readTimer=setTimeout(()=>void this.flushReadReceipts(),READ_RECEIPT_DELAY_MS);
 }
 private async flushReadReceipts(){
  const queued=[...this.readQueue];this.readQueue.clear();
  if(this.invalid||!readReceiptsOn())return;
  for(const [key,{author,id}] of queued){
   this.readSent[key]=id;
   await this.client.sendReadReceipt?.(id,author).catch(()=>0);
  }
  this.persistReadState();
 }
 /** A teammate read up to `id` of this account's messages. Accepted only for
  * an own message this device has, from someone in its conversation; `reader`
  * is the account the envelope authenticated. */
 private acceptRead(id:string,reader:string){
  if(this.invalid||!readReceiptsOn()||reader===this.user)return;
  const target=this.find(id);
  if(!target||target.sender!==this.user)return;
  if(target.recipient===null?Object.keys(this.snapshot.members).length>0&&!(reader in this.snapshot.members):target.recipient!==reader)return;
  const key=watermarkKey(reader,conversationKey(target,this.user)),prior=this.snapshot.reads[key],priorMessage=prior?this.find(prior):undefined;
  if(prior===id||(priorMessage&&!newer(target,priorMessage)))return;
  const {[key]:_old,...rest}=this.snapshot.reads;
  this.update({reads:Object.fromEntries([...Object.entries(rest),[key,id]].slice(-1000))});this.persistReadState();
 }
 /** Who has read an own message (by watermark), when read receipts are on. */
 readers(messageId:string):string[]{
  const m=this.find(messageId);if(!m||m.sender!==this.user||!readReceiptsOn())return [];
  const conversation=conversationKey(m,this.user),out:string[]=[];
  for(const [key,id] of Object.entries(this.snapshot.reads)){
   let reader:string,conv:string;try{[reader,conv]=JSON.parse(key) as [string,string];}catch{continue;}
   if(conv!==conversation)continue;
   const mark=this.find(id);if(mark&&(mark.created>m.created||(mark.created===m.created&&mark.id>=m.id)))out.push(reader);
  }
  return out;
 }
 /** A teammate's device came online: re-send read watermarks, and backfill what expired on the way to it. */
 private deviceOnline(device:Device){
  if(this.invalid)return;
  if(readReceiptsOn())for(const [key,id] of Object.entries(this.readSent)){
   let author:string;try{[author]=JSON.parse(key) as [string];}catch{continue;}
   if(author===device.user_id)void this.client.sendReadReceipt?.(id,author,device.id).catch(()=>0);
  }
  void this.backfillTo(device);
 }
 private async backfillTo(device:Device){
  await this.ready.catch(()=>{});
  const now=Date.now(),due=[...this.ledger].filter(([,e])=>(e.user===device.user_id||e.user==='*')&&(!e.deviceId||e.deviceId===device.id)&&e.until>now);
  for(const [key,e] of due.sort(([,a],[,b])=>(this.lookup(a.messageId)?.created??0)-(this.lookup(b.messageId)?.created??0))){
   const message=this.lookup(e.messageId);
   if(!message||this.snapshot.deleted[e.messageId]){this.forgetLedger([key]);continue;}
   const target=eventOf(message)?.target;if(target&&this.snapshot.deleted[target]&&eventOf(message)?.type!=='delete'){this.forgetLedger([key]);continue;}
   const sent=await this.client.backfill?.(device.id,message).catch(()=>false);
   // An "any device" entry (a reaction nobody could read) is settled by the first capable device.
   if(sent&&!e.deviceId){this.forgetLedger([key]);this.putLedger({...e,user:device.user_id,deviceId:device.id});}
  }
  this.refreshAwaiting();
 }
 private lookup(id:string){return this.find(id)??this.ownEvents.get(id);}
 private ledgerKey(e:LedgerEntry){return `${e.messageId}:${e.deviceId??'*'+e.user}`;}
 private putLedger(e:LedgerEntry){
  const key=this.ledgerKey(e);if(this.ledger.has(key)&&this.ledger.get(key)!.until===e.until)return;
  this.ledger.set(key,e);try{void saveChatRecord(this.user,this.team,'ledger',key,e).catch(()=>{});}catch{/* kept for this run */}
 }
 private forgetLedger(keys:string[]){if(!keys.length)return;for(const k of keys)this.ledger.delete(k);try{void forgetChatRecords(this.user,this.team,'ledger',keys).catch(()=>{});}catch{/* expires on its own */}}
 private dropLedger(messageId:string){this.forgetLedger([...this.ledger].filter(([,e])=>e.messageId===messageId).map(([k])=>k));this.refreshAwaiting();}
 /** A delivery receipt settles the ledger for that account. */
 private settleLedger(id:string,user:string){
  const keys=[...this.ledger].filter(([,e])=>e.messageId===id&&e.user===user).map(([k])=>k);
  if(keys.length){this.forgetLedger(keys);this.refreshAwaiting();}
 }
 private recordUndelivered(messageId:string,device:Device){
  if(this.invalid)return;
  const message=this.lookup(messageId);
  if(!message||message.sender!==this.user||this.snapshot.deleted[messageId])return;
  const until=message.created+BACKFILL_MS;if(until<=Date.now())return;
  this.putLedger({messageId,user:device.user_id,deviceId:device.id,until});
  this.refreshAwaiting();
 }
 /** Derives `awaiting` and `undeliveredReactions` from the ledger. */
 private refreshAwaiting(){
  if(this.invalid)return;
  const awaiting:Record<string,Awaiting>={},reactions:Record<string,string[]>={};
  for(const e of this.ledger.values()){
   const event=this.ownEvents.get(e.messageId),reaction=event?eventOf(event):undefined;
   if(reaction?.type==='reaction'){
    if(!e.deviceId&&hasReacted(this.snapshot.reactions,reaction.target,this.user,reaction.emoji)&&!(reactions[reaction.target]??=[]).includes(reaction.emoji))reactions[reaction.target].push(reaction.emoji);
    continue;
   }
   if(!this.find(e.messageId))continue;
   const a=awaiting[e.messageId]??={users:[],until:e.until};
   if(!a.users.includes(e.user))a.users.push(e.user);a.until=Math.max(a.until,e.until);
  }
  for(const [k,v] of Object.entries(reactions))if(!v.length)delete reactions[k];
  if(JSON.stringify(awaiting)!==JSON.stringify(this.snapshot.awaiting))this.update({awaiting});
  if(JSON.stringify(reactions)!==JSON.stringify(this.snapshot.undeliveredReactions))this.update({undeliveredReactions:reactions});
 }
 /** Unread counts per conversation for this account and team. */
 unread():ConversationUnread{const {messages,unreadIds}=this.snapshot;if(this.unreadCache?.messages!==messages||this.unreadCache.unreadIds!==unreadIds)this.unreadCache={messages,unreadIds,counts:countUnread(messages,unreadIds,this.user)};return this.unreadCache.counts;}
 private unreadCache?:{messages:ChatMessage[];unreadIds:string[];counts:ConversationUnread};
 getSnapshot=()=>this.snapshot;
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 retain(){
  const generation=++this.releaseGeneration;
  if(this.refs++===0&&!this.invalid&&generation===1)this.ready=this.start();
  let released=false;return()=>{if(released)return;released=true;this.refs--;const closing=++this.releaseGeneration;queueMicrotask(()=>{if(this.refs===0&&closing===this.releaseGeneration)this.clear('Conversation closed.');});};
 }
 clear(status='Signed out. Sign in again to open this conversation.'){
  this.invalid=true;this.client.stop();this.snapshot=empty(status);this.overlay=EMPTY_OVERLAY;this.saves.clear();
  clearTimeout(this.readTimer);clearTimeout(this.backfillTimer);this.readQueue.clear();this.backfillBatch.clear();this.ledger.clear();this.tombstones.clear();this.ownEvents.clear();this.editEvents.clear();
  if(sessions.get(`${this.user}:${this.team}`)===this)sessions.delete(`${this.user}:${this.team}`);
  this.listeners.forEach(fn=>fn());unreadListeners.forEach(fn=>fn());
 }
 /** Account ids among the team's members named as `@Name` in `text`. */
 private mentionsIn(text:string){
  const ids=Object.entries(this.snapshot.members).filter(([id,name])=>id!==this.user&&name&&text.includes(`@${name}`)).map(([id])=>id);
  return parseMentions(ids.slice(0,50));
 }
 /** Shows the message immediately with a client-generated id, then encrypts,
  * saves and delivers it in the background. Rejects only when the message was
  * not accepted at all (signed out or invalid text); delivery problems are
  * reported through `delivery` on the snapshot instead. */
 send(text:string,peer:string|null,files:(Blob&{name?:string})[]=[],options:SendOptions={}):Promise<SendOutcome>{
  if(this.invalid)return Promise.reject(Error('Sign in again to send messages'));
  if(files.length>MAX_ATTACHMENTS)return Promise.reject(Error(`Attach up to ${MAX_ATTACHMENTS} files per message`));
  let extras:Extras;
  try{extras=this.extras(peer,options);}catch(error){return Promise.reject(error);}
  const problem=this.problem(text,peer,undefined,extras);if(problem&&!(files.length&&problem==='Write a message first'))return Promise.reject(Error(problem));
  if(!files.length)return this.dispatch(this.append(text,peer,undefined,extras));
  // Hashing runs before the optimistic copy so it already carries the metadata
  // the recipients will verify the bytes against.
  return Promise.all(files.map(file=>prepareFile(file))).then(prepared=>{
   if(this.invalid)throw Error('Sign in again to send messages');
   const attachments=prepared.map(p=>p.meta),problem=this.problem(text,peer,attachments,extras);if(problem)throw Error(problem);
   for(const p of prepared)this.blobs.set(p.meta.id,p.blob);
   return this.dispatch(this.append(text,peer,attachments,extras));
  });
 }
 /** Checks and normalizes reply and mention options: a reply's root is in the
  * same conversation, and a reply to a reply joins the first message's thread. */
 private extras(peer:string|null,options:SendOptions):Extras{
  const out:Extras={};
  if(options.thread!==undefined){
   const root=this.find(options.thread);
   const sameConversation=(m:ChatMessage)=>peer===null?m.recipient===null:m.recipient!==null&&[m.sender,m.recipient].sort().join('\u0000')===[this.user,peer].sort().join('\u0000');
   if(!root||!sameConversation(root))throw Error('Reply to a message in this conversation');
   out.thread={root:threadRoot(root,this.find)??root.id};
  }
  if(options.mentions?.length){
   const known=options.mentions.filter(id=>id!==this.user&&(id in this.snapshot.members||id===peer));
   const mentions=parseMentions([...new Set(known)].slice(0,50));if(mentions)out.mentions=mentions;
  }
  if(options.mentionsAll&&peer===null)out.mentionsAll=true;
  return out;
 }
 /** The bytes of an attachment: this device's copy, or pulled from the sender's
  * device over a direct connection. State changes land in `attachments`. */
 async attachment(messageId:string,attachmentId:string):Promise<Blob>{
  const message=this.snapshot.messages.find(m=>m.id===messageId);
  if(this.invalid||!message?.attachments?.some(a=>a.id===attachmentId))throw Error('This attachment is not in the conversation');
  const memory=this.blobs.get(attachmentId);if(memory)return memory;
  await this.ready.catch(()=>{});
  try{const blob=await this.client.requestAttachment(message,attachmentId);this.setAttachment(attachmentId,{state:'available'});return blob;}
  catch(error){this.setAttachment(attachmentId,error instanceof AttachmentUnavailable?{state:'unavailable',reason:error.reason}:{state:'failed',detail:reason(error)});throw error;}
 }
 private setAttachment(id:string,state:AttachmentState){if(!this.invalid)this.update({attachments:{...this.snapshot.attachments,[id]:state}});}
 /** Sends a failed, expired or waiting message again as a new message at the end of the conversation. */
 retry(id:string):Promise<SendOutcome>{
  const message=this.resendable(id);if(!message)return Promise.reject(Error('This message cannot be resent'));
  const {thread,mentions,mentionsAll}=parseExtensions(message);
  this.drop(id,false);return this.dispatch(this.append(message.text,message.recipient,message.attachments,{...(thread?{thread}:{}),...(mentions?{mentions}:{}),...(mentionsAll?{mentionsAll}:{})}));
 }
 /** Retries a queued message's deliveries now instead of at its next scheduled retry. */
 async retryNow(id:string){
  if(this.invalid)throw Error('Sign in again to send messages');
  await this.ready.catch(()=>{});
  return this.client.retryNow(id);
 }
 /** Removes a message that was not delivered from this device. */
 discard(id:string){if(this.resendable(id))this.drop(id);}
 private resendable(id:string){
  const message=this.snapshot.messages.find(m=>m.id===id),state=this.snapshot.delivery[id]?.state;
  return !this.invalid&&message?.sender===this.user&&(state==='failed'||state==='expired'||state==='waiting')?message:undefined;
 }
 private problem(text:string,peer:string|null,attachments?:Attachment[],extras:Extras={}){
  if(!text.trim()&&!attachments?.length)return 'Write a message first';
  if(bytes(text)>16000)return 'Write a message under 16 KB';
  if(bytes(JSON.stringify({kind:'message',message:{id:crypto.randomUUID(),sender:this.user,recipient:peer,text,created:Date.now(),attachments,v:CHAT_VERSION,...extras}}))>32000)return 'This message is too large after encoding. Split it into smaller messages.';
  return '';
 }
 private append(text:string,recipient:string|null,attachments?:Attachment[],extras:Extras={}):ChatMessage{
  // Strictly increasing timestamps keep rapid sends in order after a restart.
  const last=this.snapshot.messages.findLast(m=>m.sender===this.user)?.created??0;
  const message:ChatMessage={id:crypto.randomUUID(),sender:this.user,recipient,text,created:Math.max(Date.now(),last+1),...(attachments?.length?{attachments}:{}),v:CHAT_VERSION,...extras};
  this.update({messages:[...this.snapshot.messages.slice(-499),message],delivery:{...this.snapshot.delivery,[message.id]:{state:'sending'}}});
  // The encrypted local copy (with this id) is written right away, so a restart
  // keeps the message and the transport's own save reconciles with it.
  this.saves.set(message.id,saveChatMessage(this.user,this.team,message).catch(()=>{}));
  return message;
 }
 private dispatch(message:ChatMessage):Promise<SendOutcome>{
  const outcome=()=>({id:message.id,delivery:this.snapshot.delivery[message.id]});
  const run=this.outgoing.then(async()=>{
   await this.ready.catch(()=>{});await this.saves.get(message.id);this.saves.delete(message.id);
   if(this.invalid||this.discarded.has(message.id))return outcome();
   if(Date.now()-message.created>STALE_MS){this.setDelivery(message.id,{state:'failed',detail:'Sending took too long.'});return outcome();}
   try{
    const files=await Promise.all((message.attachments??[]).map(async meta=>{const blob=this.blobs.get(meta.id)??await this.client.localFile(meta.id);if(!blob)throw Error(`${meta.name} is no longer on this device`);return {meta,blob};}));
    const {thread,mentions,mentionsAll}=parseExtensions(message);
    const draft:MessageDraft={id:message.id,created:message.created,...(thread?{thread}:{}),...(mentions?{mentions}:{}),...(mentionsAll?{mentionsAll}:{})};
    const result=await (files.length?this.client.send(message.text,message.recipient,draft,files):this.client.send(message.text,message.recipient,draft));
    // The transport now holds the bytes in local storage; drop the in-memory copy.
    for(const f of files)this.blobs.delete(f.meta.id);
    if(this.discarded.has(message.id)){void this.client.discard(message.id).catch(()=>{});void forgetChatMessage(this.user,this.team,message.id).catch(()=>{});return outcome();}
    this.setDelivery(message.id,result.queued?{state:'queued'}:{state:'sent',...(result.partial?{detail:'Some devices could not be reached; delivery will retry.'}:{})});
   }catch(error){
    const offline=navigator.onLine===false||/^(Connecting|Reconnecting)/.test(this.snapshot.status);
    this.setDelivery(message.id,{state:offline?'waiting':'failed',detail:reason(error)});
   }
   return outcome();
  });
  this.outgoing=run.catch(()=>{});return run;
 }
 private resendWaiting(){for(const m of this.snapshot.messages)if(this.snapshot.delivery[m.id]?.state==='waiting')void this.retry(m.id).catch(()=>{});}
 private setDelivery(id:string,delivery:Delivery){if(this.snapshot.messages.some(m=>m.id===id))this.update({delivery:{...this.snapshot.delivery,[id]:delivery}});}
 private drop(id:string,forgetFiles=true){
  this.discarded.add(id);
  if(forgetFiles)for(const a of this.snapshot.messages.find(m=>m.id===id)?.attachments??[])this.blobs.delete(a.id);
  const {[id]:_delivery,...delivery}=this.snapshot.delivery,{[id]:_receipts,...receipts}=this.snapshot.receipts,{[id]:_retry,...retryAt}=this.snapshot.retryAt;
  this.update({messages:this.snapshot.messages.filter(m=>m.id!==id),delivery,receipts,retryAt,unreadIds:this.snapshot.unreadIds.filter(x=>x!==id),restoredIds:this.snapshot.restoredIds.filter(x=>x!==id)});
  void (this.saves.get(id)??Promise.resolve()).then(()=>forgetChatMessage(this.user,this.team,id)).catch(()=>{});
  void this.client.discard(id).catch(()=>{});
  this.dropLedger(id);
  this.persistReadState();
 }

}
type Extras={thread?:{root:string};mentions?:string[];mentionsAll?:true};
export function teamSession(team:string,user:string){const key=`${user}:${team}`;let session=sessions.get(key);if(!session){session=new TeamSession(team,user);sessions.set(key,session);}return session;}

/** Every team transport this IDE holds open (the background keeps one per team). */
export function liveTeamSessions(){return [...sessions.values()];}

export function clearTeamSessions(){for(const session of [...sessions.values()])session.clear();}
