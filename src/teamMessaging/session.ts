import {loadChatHistory,saveChatMessage,forgetChatMessage,loadChatReadState,saveChatReadState} from './history';
import {invoke} from '@tauri-apps/api/core';
import {PeerClient,type ChatMessage,type Device} from './client';
import type {JobRequest,JobStatus,MeshMessage,MeshStatus} from './jobSchema';
import {countUnread,type ConversationUnread} from './unread';

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
type Snapshot={unreadIds:string[];restoredIds:string[];members:Record<string,string>;messages:ChatMessage[];receipts:Record<string,string[]>;delivery:Record<string,Delivery>;status:string};
/** Peers refuse messages created more than five minutes before their envelope. */
const STALE_MS=4*60_000;
const reason=(error:unknown)=>error instanceof Error?error.message:String(error);
const empty=(status:string):Snapshot=>({unreadIds:[],restoredIds:[],members:{},messages:[],receipts:{},delivery:{},status});
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
/** A message from someone else that this device had not seen before. */
export type TeamMessageEvent={team:string;user:string;message:ChatMessage;senderName?:string};
const messageListeners=new Set<(event:TeamMessageEvent)=>void>();
export const subscribeTeamMessages=(listener:(event:TeamMessageEvent)=>void)=>{messageListeners.add(listener);return()=>{messageListeners.delete(listener);};};
/** Who sent a job or job status, as the envelope proved it: `user` is the
 * server-authenticated account, `device` the signing device. */
export type TeamJobSender={user:string;device:string;name?:string};
/** `workspace` is set for v2 workspace traffic: the cloud workspace the envelope's signed header names. */
export type TeamJobEvent={team:string;user:string;sender:TeamJobSender;workspace?:string}&({kind:'job';job:JobRequest}|{kind:'job-status';status:JobStatus}|{kind:'mesh';message:MeshMessage}|{kind:'mesh-status';status:MeshStatus});
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
 /** Read state restored: an unconfirmed restored message without pending ciphertext was not delivered. */
 private receiptsRestored=false;
 readonly team:string;
 readonly user:string;
 constructor(team:string,user:string){
  this.team=team;this.user=user;
  this.client=new PeerClient({team,user,request:body=>invoke('canopy_account_request',{route:'/api/peers',body}),
   persist:message=>saveChatMessage(this.user,this.team,message),
   members:members=>this.update({members:Object.fromEntries(members.map(m=>[m.id,m.name]))}),
   message:message=>{
    if(this.invalid||this.discarded.has(message.id))return;
    // Own messages (including echoes from this account's other devices) and
    // repeats of a message already shown never count as unread.
    const fresh=!this.snapshot.messages.some(m=>m.id===message.id),incoming=fresh&&message.sender!==this.user;
    this.update({unreadIds:incoming?[...this.snapshot.unreadIds.slice(-499),message.id]:this.snapshot.unreadIds,messages:fresh?[...this.snapshot.messages.slice(-499),message]:this.snapshot.messages});this.persistReadState();
    if(incoming){const event={team:this.team,user:this.user,message,senderName:this.snapshot.members[message.sender]};messageListeners.forEach(fn=>{try{fn(event);}catch{/* a listener never breaks delivery */}});}
   },
   job:(job,sender)=>this.emitJob(sender,{kind:'job',job}),
   jobStatus:(status,sender,workspace)=>this.emitJob(sender,{kind:'job-status',status},workspace),
   mesh:(message,sender,workspace)=>this.emitJob(sender,{kind:'mesh',message},workspace),
   meshStatus:(status,sender,workspace)=>this.emitJob(sender,{kind:'mesh-status',status},workspace),
   receipt:(id,user)=>{if(this.invalid||!this.snapshot.messages.some(m=>m.id===id))return;this.update({receipts:{...this.snapshot.receipts,[id]:[...new Set([...(this.snapshot.receipts[id]??[]),user])].slice(-512)}});this.persistReadState();},
   status:status=>{this.update({status});if(status.startsWith('Connected'))this.resendWaiting();},
   pending:ids=>{
    const pending=new Set(ids),delivery={...this.snapshot.delivery};
    for(const m of this.snapshot.messages){
     if(m.sender!==this.user||delivery[m.id]||this.snapshot.receipts[m.id]?.length)continue;
     if(pending.has(m.id))delivery[m.id]={state:'queued'};else if(this.receiptsRestored)delivery[m.id]={state:'expired'};
    }
    this.update({delivery});
   },
   expired:id=>{if(!this.snapshot.receipts[id]?.length)this.setDelivery(id,{state:'expired'});},
   relayed:id=>{if(this.snapshot.delivery[id]?.state==='queued')this.setDelivery(id,{state:'sent'});}});
 }
 private async start(){
  try{const account=await invoke<{user:{id:string}}>('canopy_account_request',{route:'/api/me',body:null});if(this.invalid)return;if(account.user?.id!==this.user){this.clear('Sign in to the account that owns this conversation.');return;}}catch{this.clear('Sign in to restore this conversation.');return;}
  try{
   const history=await loadChatHistory(this.user,this.team);if(this.invalid)return;
   let restored=true;
   const state=await loadChatReadState(this.user,this.team).catch(()=>{restored=false;this.update({status:'Local read status could not be restored.'});return {unreadIds:history.filter(m=>m.sender!==this.user).map(m=>m.id),receipts:{}};});if(this.invalid)return;
   const ids=new Set(history.map(m=>m.id));
   // Messages sent or received while history loaded stay, after the restored ones.
   const live=this.snapshot.messages.filter(m=>!ids.has(m.id));
   this.receiptsRestored=restored;
   this.update({messages:[...history,...live].slice(-500),restoredIds:[...ids],unreadIds:[...new Set([...state.unreadIds.filter(id=>ids.has(id)),...this.snapshot.unreadIds])],receipts:{...Object.fromEntries(Object.entries(state.receipts).filter(([id])=>ids.has(id))),...this.snapshot.receipts}});
  }catch{this.update({status:'Local history could not be restored.'});}
  if(!this.invalid)await this.client.start().catch(e=>this.update({status:String(e)}));
 }
 private emitJob(sender:Device,body:{kind:'job';job:JobRequest}|{kind:'job-status';status:JobStatus}|{kind:'mesh';message:MeshMessage}|{kind:'mesh-status';status:MeshStatus},workspace?:string){
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
 async sendJobStatus(status:JobStatus,device:string){
  if(this.invalid)throw Error('Signed out of this team');
  await this.ready;return this.client.sendJobStatus(status,device);
 }
 private persistReadState(){
  if(this.invalid)return;
  const ids=new Set(this.snapshot.messages.map(m=>m.id));
  const state={unreadIds:this.snapshot.unreadIds,receipts:Object.fromEntries(Object.entries(this.snapshot.receipts).filter(([id])=>ids.has(id)))};
  void saveChatReadState(this.user,this.team,state).catch(()=>this.update({status:'Read status could not be saved on this device.'}));
 }
 private update(change:Partial<Snapshot>){if(this.invalid)return;this.snapshot={...this.snapshot,...change};this.listeners.forEach(fn=>fn());unreadListeners.forEach(fn=>fn());}
 markRead(peer:string|null){
  const ids=new Set(this.snapshot.messages.filter(m=>peer===null?m.recipient===null:m.sender===peer&&m.recipient===this.user).map(m=>m.id));
  const unreadIds=this.snapshot.unreadIds.filter(id=>!ids.has(id));
  if(unreadIds.length!==this.snapshot.unreadIds.length){this.update({unreadIds});this.persistReadState();}
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
  this.invalid=true;this.client.stop();this.snapshot=empty(status);this.saves.clear();
  if(sessions.get(`${this.user}:${this.team}`)===this)sessions.delete(`${this.user}:${this.team}`);
  this.listeners.forEach(fn=>fn());unreadListeners.forEach(fn=>fn());
 }
 /** Shows the message immediately with a client-generated id, then encrypts,
  * saves and delivers it in the background. Rejects only when the message was
  * not accepted at all (signed out or invalid text); delivery problems are
  * reported through `delivery` on the snapshot instead. */
 send(text:string,peer:string|null):Promise<SendOutcome>{
  if(this.invalid)return Promise.reject(Error('Sign in again to send messages'));
  const problem=this.problem(text,peer);if(problem)return Promise.reject(Error(problem));
  return this.dispatch(this.append(text,peer));
 }
 /** Sends a failed, expired or waiting message again as a new message at the end of the conversation. */
 retry(id:string):Promise<SendOutcome>{
  const message=this.resendable(id);if(!message)return Promise.reject(Error('This message cannot be resent'));
  this.drop(id);return this.dispatch(this.append(message.text,message.recipient));
 }
 /** Removes a message that was not delivered from this device. */
 discard(id:string){if(this.resendable(id))this.drop(id);}
 private resendable(id:string){
  const message=this.snapshot.messages.find(m=>m.id===id),state=this.snapshot.delivery[id]?.state;
  return !this.invalid&&message?.sender===this.user&&(state==='failed'||state==='expired'||state==='waiting')?message:undefined;
 }
 private problem(text:string,peer:string|null){
  const bytes=(value:string)=>new TextEncoder().encode(value).length;
  if(!text.trim())return 'Write a message first';
  if(bytes(text)>16000)return 'Write a message under 16 KB';
  if(bytes(JSON.stringify({kind:'message',message:{id:crypto.randomUUID(),sender:this.user,recipient:peer,text,created:Date.now()}}))>32000)return 'This message is too large after encoding. Split it into smaller messages.';
  return '';
 }
 private append(text:string,recipient:string|null):ChatMessage{
  // Strictly increasing timestamps keep rapid sends in order after a restart.
  const last=this.snapshot.messages.findLast(m=>m.sender===this.user)?.created??0;
  const message:ChatMessage={id:crypto.randomUUID(),sender:this.user,recipient,text,created:Math.max(Date.now(),last+1)};
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
    const result=await this.client.send(message.text,message.recipient,{id:message.id,created:message.created});
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
 private drop(id:string){
  this.discarded.add(id);
  const {[id]:_delivery,...delivery}=this.snapshot.delivery,{[id]:_receipts,...receipts}=this.snapshot.receipts;
  this.update({messages:this.snapshot.messages.filter(m=>m.id!==id),delivery,receipts,unreadIds:this.snapshot.unreadIds.filter(x=>x!==id),restoredIds:this.snapshot.restoredIds.filter(x=>x!==id)});
  void (this.saves.get(id)??Promise.resolve()).then(()=>forgetChatMessage(this.user,this.team,id)).catch(()=>{});
  void this.client.discard(id).catch(()=>{});
  this.persistReadState();
 }

}
export function teamSession(team:string,user:string){const key=`${user}:${team}`;let session=sessions.get(key);if(!session){session=new TeamSession(team,user);sessions.set(key,session);}return session;}

/** Every team transport this IDE holds open (the background keeps one per team). */
export function liveTeamSessions(){return [...sessions.values()];}

export function clearTeamSessions(){for(const session of [...sessions.values()])session.clear();}
