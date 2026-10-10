import {validChatMessage,UUID,MAX_ATTACHMENTS} from './messageSchema';
import {chatFileStore,prepareFile,sha256,bytesOf,type FileStore,type FileRecord,type PreparedFile} from './files';
import {open,seal,registration,MessageReplayError,type Envelope,type EnvelopeKind,type PublicIdentity,type Address} from './crypto';
import {deviceIdentity,rememberMessage,messageOutbox,type MessageOutbox,type PendingEnvelope,type DeviceIdentity} from './store';
import {validJobRequest,validJobStatus,validMeshMessage,validMeshStatus,type JobRequest,type JobStatus,type MeshMessage,type MeshStatus} from './jobSchema';
/** `last_seen_at` is bumped by every poll the device makes, so it is the
 * directory's only "online" signal. */
export type Device={id:string;user_id:string;public_keys:PublicIdentity;last_seen_at?:string|null;kind?:'user'|'host';workspaceIds?:string[]};
/** File metadata only: the bytes never ride in a message or through the relay. */
export type Attachment={id:string;name:string;size:number;type:string;sha256:string};
export type ChatMessage={id:string;sender:string;recipient:string|null;text:string;created:number;attachments?:Attachment[]};
export type UnavailableReason='offline'|'expired'|'denied';
type Payload={kind:'message';message:ChatMessage}|{kind:'receipt';id:string}|{kind:'signal';description:RTCSessionDescriptionInit}|{kind:'job';job:JobRequest}|{kind:'job-status';status:JobStatus}
 |{kind:'mesh';message:MeshMessage}|{kind:'mesh-status';status:MeshStatus}|{kind:'file-request';attachmentId:string;messageId:string}|{kind:'file-unavailable';attachmentId:string;reason:UnavailableReason};
/** A pull the sender could not (or would not) serve. */
export class AttachmentUnavailable extends Error{readonly reason:UnavailableReason;constructor(reason:UnavailableReason){super(reason==='offline'?'The sender is not directly connected':reason==='denied'?'This file was not shared with you':'This file is no longer available');this.reason=reason;}}
export type AttachmentState={state:'downloading';received:number;total:number}|{state:'available'}|{state:'unavailable';reason:UnavailableReason}|{state:'failed';detail:string};
export type AttachmentEvent={attachmentId:string;messageId:string}&AttachmentState;
/** One data channel per transfer, separate from the ordered message channel so
 * a large file never queues ahead of chat. */
export const FILE_CHANNEL='canopy-file-v1:';
const FILE_CHUNK=16*1024,FILE_READ=1024*1024,FILE_HIGH_WATER=1024*1024,FILE_LOW_WATER=256*1024;
/** A transfer that goes quiet this long (no channel, no chunk) is abandoned. */
const FILE_IDLE_MS=30_000;
const REASONS:UnavailableReason[]=['offline','denied','expired'];
type Download={meta:Attachment;messageId:string;devices:Set<string>;replies:Map<string,UnavailableReason>;channel?:RTCDataChannel;timer?:ReturnType<typeof setTimeout>;promise:Promise<Blob>;resolve:(blob:Blob)=>void;reject:(error:Error)=>void;progress:Set<(received:number,total:number)=>void>};
const isArrayBuffer=(value:unknown):value is ArrayBuffer=>Object.prototype.toString.call(value)==='[object ArrayBuffer]';
/** The envelope kind each payload must travel under (protocol §6.1). */
const ENVELOPE_KIND:Record<Payload['kind'],EnvelopeKind>={message:'chat',receipt:'chat',signal:'chat',job:'job','job-status':'job-status',mesh:'mesh','mesh-status':'mesh','file-request':'chat','file-unavailable':'chat'};
export type PeerRequest=<T>(body:unknown)=>Promise<T>;
/** A device polls every 2s; one quiet for longer than this is not online. */
export const DEVICE_ONLINE_MS=60_000;
export const deviceOnline=(device:Device,now=Date.now())=>{
 // A directory that predates `last_seen_at` cannot say; it does not refuse.
 if(device.last_seen_at==null)return true;
 const seen=Date.parse(device.last_seen_at);return Number.isFinite(seen)&&now-seen<=DEVICE_ONLINE_MS;
};
type Options={members?:(members:{id:string;name:string}[])=>void;request:PeerRequest;team:string;user:string;message:(message:ChatMessage)=>void;receipt:(id:string,user:string)=>void;status:(value:string)=>void;identity?:()=>Promise<DeviceIdentity>;remember?:typeof rememberMessage;rtc?:(config:RTCConfiguration)=>RTCPeerConnection;outbox?:MessageOutbox;persist?:(message:ChatMessage)=>Promise<void>;
 /** A mesh job from a team device, or this account's other device. */
 job?:(job:JobRequest,sender:Device)=>void;
 /** A step of a job this device submitted, from the device running it. */
 jobStatus?:(status:JobStatus,sender:Device,workspace?:string)=>void;
 /** An agent message from a workspace's service (host device), or its refusal of one this account sent. */
 mesh?:(message:MeshMessage,sender:Device,workspace:string)=>void;
 meshStatus?:(status:MeshStatus,sender:Device,workspace:string)=>void;
 /** Message ids with ciphertext still waiting in the restored outbox. */
 pending?:(messageIds:string[])=>void;
 /** A message's last pending delivery expired or became undeliverable. */
 expired?:(messageId:string)=>void;
 /** A pending delivery reached the relay or a direct channel on retry. */
 relayed?:(messageId:string)=>void;
 /** Local-only attachment bytes: sent copies to serve, pulled copies to keep. */
 files?:FileStore;
 /** Progress and outcome of each attachment pull. */
 attachment?:(event:AttachmentEvent)=>void};
/** Client-chosen identity for an optimistic message: the same id is kept in the
 * encrypted history and the pending-delivery queue, so echoes and restarts reconcile. */
export type MessageDraft={id:string;created:number};
export type SendResult={id:string;queued:boolean;partial:boolean};
export class PeerClient {
 private identity?:DeviceIdentity;private devices=new Map<string,Device>();private hosts=new Map<string,Device>();private peers=new Map<string,{pc:RTCPeerConnection;channel?:RTCDataChannel}>();
 private timer?:ReturnType<typeof setTimeout>;private stopped=false;private directoryAt=0;private tail=Promise.resolve();private watchdog?:ReturnType<typeof setInterval>;
 private fallbacks=new Map<string,{timer:ReturnType<typeof setTimeout>;user:string;message:string}>();
 private registered=false;private started=false;
 private sent=new Map<string,Set<string>>();
 private iceServers:RTCIceServer[]=[];
 private options:Options;
 private outbox:MessageOutbox;
 private pending=new Map<string,PendingEnvelope>();
 private attempted=new Map<string,number>();
 private files:FileStore;
 private downloads=new Map<string,Download>();
 private serving=0;
 constructor(options:Options){this.options=options;this.outbox=options.outbox??messageOutbox(options.user,options.team);this.files=options.files??chatFileStore(options.user,options.team);}
 private address(device:string,user=this.options.user):Address{return {team:this.options.team,user,device};}
 private async request<T>(body:Record<string,unknown>){if(this.stopped)throw Error('Team connection closed');return this.options.request<T>({...body,teamId:this.options.team,deviceId:this.identity!.id});}
 async start(){
  if(this.started||this.stopped)return;this.started=true;
  this.identity=await (this.options.identity?.()??deviceIdentity(this.options.user));if(this.stopped)return;
  void this.files.prune().catch(()=>{/* retention retries next start */});
  for(const row of await this.outbox.load()){
   if(row.envelope.from.device!==this.identity.id||row.envelope.from.user!==this.options.user||row.envelope.from.team!==this.options.team||row.envelope.to.team!==this.options.team)continue;
   this.pending.set(row.envelope.id,row);
   const users=this.sent.get(row.messageId)??new Set<string>();users.add(row.envelope.to.user);this.sent.set(row.messageId,users);
  }
  if(this.stopped)return;
  this.options.pending?.([...new Set([...this.pending.values()].map(row=>row.messageId))]);
  this.watchdog=setInterval(()=>{if(Date.now()-this.directoryAt>10000){this.closePeers();this.options.status('Reconnecting securely…');}},1000);
  await this.poll();
 }
 private closePeers(){for(const value of this.peers.values())value.pc.close();this.peers.clear();}
 stop(){this.stopped=true;clearTimeout(this.timer);clearInterval(this.watchdog);for(const id of [...this.downloads.keys()])this.finish(id,new AttachmentUnavailable('offline'));this.closePeers();this.devices.clear();this.hosts.clear();for(const value of this.fallbacks.values())clearTimeout(value.timer);this.fallbacks.clear();}
 private async directory(){
  const {devices:listed,hosts=[],members=[],iceServers=[]}=await this.request<{devices:Device[];hosts?:Device[];members?:{id:string;name:string}[];iceServers?:RTCIceServer[]}>({action:'directory'});if(this.stopped)return;
  // Host devices carry workspace traffic only; they never join person chat.
  const devices=listed.filter(d=>d.kind!=='host');
  this.hosts=new Map(hosts.filter(h=>h.kind==='host'&&Array.isArray(h.workspaceIds)).map(h=>[h.id,h]));
  if(!devices.some(d=>d.id===this.identity!.id&&d.user_id===this.options.user))throw Error('This device no longer has team access');
  const next=new Map(devices.map(d=>[d.id,d]));
  for(const [id,peer] of this.peers)if(!next.has(id)||JSON.stringify(next.get(id)?.public_keys)!==JSON.stringify(this.devices.get(id)?.public_keys)){peer.pc.close();this.peers.delete(id);}
  this.options.members?.(members);
  this.devices=next;this.iceServers=iceServers;this.directoryAt=Date.now();
  // Stable initiator avoids simultaneous offers from the two devices.
  for(const d of devices)if(d.id!==this.identity!.id&&this.identity!.id<d.id&&!this.peers.has(d.id))void this.offer(d,iceServers).catch(()=>{/* encrypted relay remains available */});
 }
 private async poll(){
  if(this.stopped)return;
  try{
   if(!this.registered){await this.options.request(await registration(this.identity!.keys,this.options.user,this.identity!.id));if(this.stopped)return;this.registered=true;}
   await this.directory();if(this.stopped)return;
   await this.retryPending();if(this.stopped)return;
   const {envelopes}=await this.request<{envelopes:{id:string;envelope:Envelope}[]}>({action:'poll'});
   const acknowledged:string[]=[];
   for(const row of envelopes){try{await this.receive(row.envelope);acknowledged.push(row.id);}catch(error){if(String(error).includes('Message replay refused'))acknowledged.push(row.id);else this.options.status('A message could not be verified.');}}
   if(acknowledged.length)await this.request({action:'ack',ids:acknowledged});
   if(!this.stopped)this.options.status('Connected · end-to-end encrypted');
  }catch(error){this.directoryAt=0;this.closePeers();if(!this.stopped)this.options.status(String(error));}
  finally{if(!this.stopped)this.timer=setTimeout(()=>void this.poll(),2000);}
 }
 private async deliver(device:Device,payload:Payload,relayOnly=false){
  if(this.stopped||!this.devices.has(device.id))throw Error('Team access needs to be refreshed');
  const envelope=await seal(this.identity!.keys,device.public_keys,this.address(this.identity!.id),this.address(device.id,device.user_id),JSON.stringify(payload));
  if(this.stopped)throw Error('Team connection closed');
  if(payload.kind==='message'){
   const row={envelope,messageId:payload.message.id};await this.outbox.put(row);
   this.pending.set(envelope.id,row);this.attempted.set(envelope.id,Date.now());
  }
  await this.transmit(device,envelope,payload.kind==='message'?payload.message.id:undefined,relayOnly);
 }
 private async transmit(device:Device,envelope:Envelope,messageId?:string,relayOnly=false){
  if(this.stopped||Date.now()-this.directoryAt>10000||!this.devices.has(device.id))throw Error('Team access needs to be refreshed');
  const channel=this.peers.get(device.id)?.channel;
  if(!relayOnly&&channel?.readyState==='open'&&channel.bufferedAmount<131072){try{channel.send(JSON.stringify(envelope));
    if(messageId){
     const timer=setTimeout(()=>{this.fallbacks.delete(envelope.id);if(!this.stopped&&this.devices.has(device.id)&&Date.now()-this.directoryAt<=10000)void this.request({action:'relay',recipientDevice:device.id,envelope}).catch(()=>this.options.status('Delivery could not be confirmed.'));},3000);
     const previous=this.fallbacks.get(envelope.id);if(previous)clearTimeout(previous.timer);
     this.fallbacks.set(envelope.id,{timer,user:device.user_id,message:messageId});
    }
    return;}catch{/* relay on a failed direct send */}}
  await this.request({action:'relay',recipientDevice:device.id,envelope});
 }
 private async retryPending(){
  const discard:string[]=[];
  for(const [id,row]of this.pending){
   const device=this.devices.get(row.envelope.to.device);
   if(row.envelope.expires<=Date.now()||!device||device.user_id!==row.envelope.to.user){discard.push(id);continue;}
   if(Date.now()-(this.attempted.get(id)??0)<5000)continue;
   this.attempted.set(id,Date.now());
   if(await this.transmit(device,row.envelope,row.messageId).then(()=>true,()=>false))this.options.relayed?.(row.messageId);
  }
  if(discard.length){
   const messages=new Set(discard.map(id=>this.pending.get(id)!.messageId));
   await this.outbox.remove(discard);this.forgetPending(discard);
   for(const messageId of messages)if(![...this.pending.values()].some(row=>row.messageId===messageId))this.options.expired?.(messageId);
  }
 }
 private forgetPending(ids:string[]){for(const id of ids){this.pending.delete(id);this.attempted.delete(id);const prior=this.fallbacks.get(id);if(prior)clearTimeout(prior.timer);this.fallbacks.delete(id);}}
 /** Drops every pending delivery of a message the sender discarded. */
 async discard(messageId:string){
  const ids=[...this.pending].filter(([,row])=>row.messageId===messageId).map(([id])=>id);
  this.sent.delete(messageId);if(!ids.length)return;
  await this.outbox.remove(ids);this.forgetPending(ids);
 }

 /** `files` may be raw files or ones already hashed by `prepareFile` (so an
  * optimistic copy and this send carry the same attachment ids). */
 async send(text:string,recipient:string|null,draft?:MessageDraft,files:(PreparedFile|(Blob&{name?:string}))[]=[]):Promise<SendResult>{
  if(files.length>MAX_ATTACHMENTS)throw Error(`Attach up to ${MAX_ATTACHMENTS} files per message`);
  if((!text.trim()&&!files.length)||new TextEncoder().encode(text).length>16000)throw Error('Write a message under 16 KB');
  if(this.fallbacks.size>=500)throw Error('Wait for pending messages to finish sending');
  try{await this.directory();}catch(error){
   // A sender may retain pending ciphertext while offline, but never deliver
   // through a stale directory. A fresh poll authorizes the eventual retry.
   if(!this.devices.size||navigator.onLine!==false)throw error;
   this.directoryAt=0;this.closePeers();
  }
  const devices=[...this.devices.values()].filter(d=>d.user_id!==this.options.user&&(!recipient||d.user_id===recipient));
  if(!devices.length)throw Error('No recipient devices are registered yet. Ask your teammate to sign in to Canopy.');
  const prepared=await Promise.all(files.map(file=>'meta' in file?file:prepareFile(file)));
  const message:ChatMessage={id:draft?.id??crypto.randomUUID(),sender:this.options.user,recipient,text,created:draft?.created??Date.now(),...(prepared.length?{attachments:prepared.map(p=>p.meta)}:{})};
  if(!validChatMessage(message))throw Error('Invalid message');
  if(new TextEncoder().encode(JSON.stringify({kind:'message',message})).length>32000)throw Error('This message is too large after encoding. Split it into smaller messages.');
  // Bytes stay on this device; only the metadata travels in the sealed message.
  // The recipients at send time are the only accounts this copy will serve.
  const allowedUsers=[...new Set(devices.map(d=>d.user_id))];
  for(const p of prepared)await this.files.put({id:p.meta.id,meta:p.meta,messageId:message.id,origin:'sent',allowedUsers,blob:p.blob,created:Date.now()});
  await this.options.persist?.(message);
  this.sent.set(message.id,new Set(devices.map(d=>d.user_id)));if(this.sent.size>500)this.sent.delete(this.sent.keys().next().value!);
  const outcomes=await Promise.allSettled(devices.map(d=>this.deliver(d,{kind:'message',message})));
  const queued=[...this.pending.values()].some(row=>row.messageId===message.id);
  if(outcomes.every(result=>result.status==='rejected')&&!queued)throw Error('Message could not be saved or sent. Try again.');
  this.options.message(message);return {id:message.id,queued:outcomes.every(result=>result.status==='rejected'),partial:outcomes.some(result=>result.status==='rejected')};
 }
 /** This team's devices as of the last directory refresh, this one included. */
 directoryDevices():Device[]{return [...this.devices.values()];}
 deviceId(){return this.identity?.id;}
 /** Sends a job to one online device of `recipient` (this account's own user id
  * reaches its other machines). One device, never a fan-out: two machines
  * running the same job is the failure a job must not have. */
 async sendJob(job:JobRequest,recipient:string,device?:string):Promise<Device>{
  if(!validJobRequest(job))throw Error('Invalid job');
  if(new TextEncoder().encode(JSON.stringify({kind:'job',job})).length>32000)throw Error('This job is too large after encoding. Shorten the brief.');
  await this.directory();
  const candidates=[...this.devices.values()].filter(d=>d.user_id===recipient&&d.id!==this.identity!.id&&(!device||d.id===device));
  if(!candidates.length)throw Error(device?`Device ${device} is not on this team.`:recipient===this.options.user?'This account has no other device on this team.':'That teammate has no device registered on this team yet.');
  const online=candidates.filter(d=>deviceOnline(d)).sort((a,b)=>Date.parse(b.last_seen_at??'')-Date.parse(a.last_seen_at??''));
  if(!online.length)throw Error('Not connected: no device of that member is online in Canopy right now.');
  await this.deliver(online[0],{kind:'job',job});
  return online[0];
 }
 /** Host devices of workspaces this account can reach, as of the last directory refresh. */
 directoryHosts():Device[]{return [...this.hosts.values()];}
 private async hostFor(workspace:string){
  await this.directory();
  const host=[...this.hosts.values()].filter(h=>h.workspaceIds?.includes(workspace)).sort((a,b)=>Date.parse(b.last_seen_at??'')-Date.parse(a.last_seen_at??''))[0];
  if(!host)throw Error('That workspace has no Canopy service registered yet, or you no longer have access to it.');
  return host;
 }
 private async deliverWorkspace(host:Device,workspace:string,payload:Payload){
  const text=JSON.stringify(payload);if(new TextEncoder().encode(text).length>32000)throw Error('This is too large after encoding. Shorten it.');
  const envelope=await seal(this.identity!.keys,host.public_keys,this.address(this.identity!.id),this.address(host.id,host.user_id),text,Date.now(),{version:2,kind:ENVELOPE_KIND[payload.kind],workspace});
  if(this.stopped)throw Error('Team connection closed');
  // Workspace traffic always goes through the durable relay: the host drains it while nobody is watching.
  await this.request({action:'relay',recipientDevice:host.id,envelope});
 }
 /** Sends a job to the service of a cloud workspace; it waits on the relay up to seven days. */
 async sendWorkspaceJob(job:JobRequest,workspace:string):Promise<Device>{
  if(!validJobRequest(job)||job.workspace!==workspace)throw Error('Invalid job');
  const host=await this.hostFor(workspace);await this.deliverWorkspace(host,workspace,{kind:'job',job});return host;
 }
 /** Sends an agent message to the service of a cloud workspace. */
 async sendWorkspaceMessage(message:MeshMessage,workspace:string):Promise<Device>{
  if(!validMeshMessage(message))throw Error('Invalid message');
  const host=await this.hostFor(workspace);await this.deliverWorkspace(host,workspace,{kind:'mesh',message});return host;
 }
 /** Reports a job's progress to the device that submitted it. */
 async sendJobStatus(status:JobStatus,device:string){
  if(!validJobStatus(status))throw Error('Invalid job status');
  if(Date.now()-this.directoryAt>10000)await this.directory();
  const target=this.devices.get(device);if(!target)throw Error('The submitting device is no longer on this team.');
  await this.deliver(target,{kind:'job-status',status});
 }
 private receive(envelope:Envelope):Promise<void>{
  const task=this.tail.catch(()=>{}).then(async()=>{
   if(this.stopped||Date.now()-this.directoryAt>10000)throw Error('Team access expired');
   const sender=this.devices.get(envelope.from?.device)??this.hosts.get(envelope.from?.device);if(!sender)throw Error('Sender is no longer a team member');
   let text:string;
   try{text=await open(this.identity!.keys,sender.public_keys,this.address(sender.id,sender.user_id),this.address(this.identity!.id),envelope,this.options.remember??rememberMessage,Date.now(),async decoded=>{
    if(this.stopped||Date.now()-this.directoryAt>10000||!this.currentSender(sender))throw Error('Team access expired');
    const payload=JSON.parse(decoded) as Payload;
    if(payload.kind==='message'){this.validateMessage(payload.message,sender,envelope);await this.options.persist?.(payload.message);
     // Remember which device holds the bytes, so a later pull asks only it.
     for(const meta of payload.message.attachments??[])await this.files.add({id:meta.id,meta,messageId:payload.message.id,origin:'received',allowedUsers:[],device:sender.id,created:Date.now()}).catch(()=>{});}
   });}
   catch(error){if(error instanceof MessageReplayError){if(sender.kind==='host')return;const prior=JSON.parse(error.plaintext) as Payload;if(prior.kind==='message'){this.validateMessage(prior.message,sender,envelope);await this.deliver(sender,{kind:'receipt',id:prior.message.id});return;}if(prior.kind==='receipt'){await this.acceptReceipt(prior.id,sender);return;}
    // The same job arriving twice (direct channel and relay) acts once.
    if(prior.kind==='job'||prior.kind==='job-status'||prior.kind==='file-request'||prior.kind==='file-unavailable')return;}throw error;}
   if(this.stopped||Date.now()-this.directoryAt>10000||!this.currentSender(sender))return;
   const payload=JSON.parse(text) as Payload,workspace=this.routed(envelope,sender,payload);
   if(payload.kind==='message'){
    const m=payload.message;this.validateMessage(m,sender,envelope);
    this.options.message(m);await this.deliver(sender,{kind:'receipt',id:m.id});
   }else if(payload.kind==='receipt'){await this.acceptReceipt(payload.id,sender);}
   else if(payload.kind==='signal')await this.signal(sender,payload.description);
   else if(payload.kind==='job'){this.validateTimed(payload.job,validJobRequest,envelope);this.options.job?.(payload.job,sender);}
   else if(payload.kind==='job-status'){this.validateTimed(payload.status,validJobStatus,envelope);this.options.jobStatus?.(payload.status,sender,workspace);}
   else if(payload.kind==='mesh'&&workspace){this.validateTimed(payload.message,validMeshMessage,envelope);this.options.mesh?.(payload.message,sender,workspace);}
   else if(payload.kind==='mesh-status'&&workspace){this.validateTimed(payload.status,validMeshStatus,envelope);this.options.meshStatus?.(payload.status,sender,workspace);}
   else if(payload.kind==='file-request')await this.serveFile(payload,sender);
   else if(payload.kind==='file-unavailable')this.fileUnavailable(payload,sender);
   else throw Error('Unknown peer message');
  });this.tail=task;return task;
 }
 private async acceptReceipt(id:string,sender:Device){
  if(typeof id!=='string'||!this.sent.get(id)?.has(sender.user_id))throw Error('Invalid receipt');
  const delivered=[...this.pending].filter(([,row])=>row.messageId===id&&row.envelope.to.user===sender.user_id).map(([key])=>key);
  // Storage failure keeps the queue intact; an authenticated duplicate receipt
  // can retry this cleanup after restarting without rerendering the message.
  await this.outbox.remove(delivered);
  for(const key of delivered){this.pending.delete(key);this.attempted.delete(key);}
  for(const [key,pending]of this.fallbacks)if(pending.message===id&&pending.user===sender.user_id){clearTimeout(pending.timer);this.fallbacks.delete(key);}
  this.options.receipt(id,sender.user_id);
 }
 /** The verified routing of a payload: its envelope kind must match, and a host
  * speaks only in v2 workspace traffic for a workspace it serves. */
 private routed(envelope:Envelope,sender:Device,payload:Payload):string|undefined{
  const expected=ENVELOPE_KIND[payload?.kind];if(!expected)throw Error('Unknown peer message');
  if(envelope.version===1){if(sender.kind==='host'||expected==='mesh')throw Error('Invalid peer message');return undefined;}
  if(envelope.kind!==expected)throw Error('Envelope kind does not match its payload');
  const workspace=envelope.to.workspace;
  if(sender.kind==='host'&&(!workspace||!sender.workspaceIds?.includes(workspace)||expected==='chat'||expected==='job'))throw Error('Host sent traffic outside its workspace');
  return workspace;
 }
 private currentSender(sender:Device){const current=this.devices.get(sender.id)??this.hosts.get(sender.id);return current?.user_id===sender.user_id&&JSON.stringify(current.public_keys)===JSON.stringify(sender.public_keys);}
 private validateMessage(m:ChatMessage,sender:Device,envelope:Envelope){
  if(!validChatMessage(m)||m.sender!==sender.user_id||(m.recipient!==null&&m.recipient!==this.options.user)||typeof m.text!=='string'||new TextEncoder().encode(m.text).length>16000||!Number.isSafeInteger(m.created)||m.created<envelope.created-300000||m.created>envelope.expires)throw Error('Invalid peer message');
 }
 /** Same freshness rule as a chat message: created inside the envelope's window. */
 private validateTimed<T extends {created:number}>(value:unknown,valid:(value:unknown)=>value is T,envelope:Envelope){
  if(!valid(value)||value.created<envelope.created-300000||value.created>envelope.expires)throw Error('Invalid peer message');
 }
 /** This device's stored copy of an attachment, if any. */
 async localFile(id:string){return (await this.files.get(id).catch(()=>undefined))?.blob;}
 /** Pulls an attachment straight from the device that sent it, over a new data
  * channel on the existing direct connection. A copy already on this device
  * (sent from here, or pulled before) is returned without asking anyone. */
 async requestAttachment(message:ChatMessage,attachmentId:string,progress?:(received:number,total:number)=>void):Promise<Blob>{
  const meta=message.attachments?.find(a=>a.id===attachmentId);
  if(!meta||!validChatMessage(message))throw Error('Unknown attachment');
  const local=await this.files.get(attachmentId).catch(()=>undefined);
  const mine=local&&local.messageId===message.id&&local.meta.sha256===meta.sha256&&local.meta.size===meta.size;
  if(mine&&local.blob?.size===meta.size)return local.blob;
  if(message.sender===this.options.user)throw new AttachmentUnavailable('expired');
  const running=this.downloads.get(attachmentId);
  if(running&&running.messageId===message.id){if(progress)running.progress.add(progress);return running.promise;}
  if(running||this.downloads.size>=20)throw Error('Wait for other downloads to finish');
  if(this.stopped||!this.identity)throw new AttachmentUnavailable('offline');
  if(Date.now()-this.directoryAt>10000)await this.directory().catch(()=>{throw new AttachmentUnavailable('offline');});
  const origin=mine&&local.origin==='received'?local.device:undefined;
  const holders=[...this.devices.values()].filter(d=>d.user_id===message.sender&&d.id!==this.identity!.id&&(!origin||d.id===origin));
  // The sending device left the team: nobody holds the bytes any more.
  if(!holders.length)throw new AttachmentUnavailable('expired');
  const online=holders.filter(d=>deviceOnline(d));
  if(!online.length){this.emit({attachmentId,messageId:message.id,state:'unavailable',reason:'offline'});throw new AttachmentUnavailable('offline');}
  let resolve!:(blob:Blob)=>void,reject!:(error:Error)=>void;
  const promise=new Promise<Blob>((ok,fail)=>{resolve=ok;reject=fail;});
  const download:Download={meta,messageId:message.id,devices:new Set(online.map(d=>d.id)),replies:new Map(),promise,resolve,reject,progress:new Set(progress?[progress]:[])};
  this.downloads.set(attachmentId,download);this.idle(attachmentId);
  this.emit({attachmentId,messageId:message.id,state:'downloading',received:0,total:meta.size});
  const asked=await Promise.allSettled(online.map(d=>this.deliver(d,{kind:'file-request',attachmentId,messageId:message.id})));
  if(asked.every(r=>r.status==='rejected'))this.finish(attachmentId,new AttachmentUnavailable('offline'));
  return promise;
 }
 private emit(event:AttachmentEvent){try{this.options.attachment?.(event);}catch{/* a listener never breaks a transfer */}}
 /** (Re)arms the inactivity timeout of a pull. */
 private idle(id:string){const d=this.downloads.get(id);if(!d)return;clearTimeout(d.timer);d.timer=setTimeout(()=>this.finish(id,new AttachmentUnavailable('offline')),FILE_IDLE_MS);}
 private finish(id:string,result:Blob|Error){
  const d=this.downloads.get(id);if(!d)return;this.downloads.delete(id);clearTimeout(d.timer);
  if(result instanceof Blob){d.resolve(result);this.emit({attachmentId:id,messageId:d.messageId,state:'available'});return;}
  if(d.channel?.readyState!=='closed')d.channel?.close();d.reject(result);
  this.emit(result instanceof AttachmentUnavailable?{attachmentId:id,messageId:d.messageId,state:'unavailable',reason:result.reason}:{attachmentId:id,messageId:d.messageId,state:'failed',detail:result.message});
 }
 /** Sender side of a pull. `sender` is the device that signed the request, so
  * the bytes go to exactly that device, and only over its direct connection. */
 private async serveFile(p:{attachmentId:string;messageId:string},sender:Device){
  if(typeof p.attachmentId!=='string'||!UUID.test(p.attachmentId)||typeof p.messageId!=='string'||!UUID.test(p.messageId))throw Error('Invalid peer message');
  const refuse=(reason:UnavailableReason)=>this.deliver(sender,{kind:'file-unavailable',attachmentId:p.attachmentId,reason});
  const record=await this.files.get(p.attachmentId).catch(()=>undefined);
  // Only a copy this device sent is ever served; pulled copies are not re-shared.
  if(!record||record.origin!=='sent'||record.messageId!==p.messageId||!record.blob)return refuse('expired');
  if(!record.allowedUsers.includes(sender.user_id))return refuse('denied');
  const pc=this.peers.get(sender.id)?.pc;
  if(!pc||pc.connectionState!=='connected'||this.serving>=4)return refuse('offline');
  this.serving++;void this.stream(pc,record).catch(()=>{/* the recipient times out and can ask again */}).finally(()=>{this.serving--;});
 }
 private async stream(pc:RTCPeerConnection,record:FileRecord){
  const channel=pc.createDataChannel(FILE_CHANNEL+record.id,{ordered:true});channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=FILE_LOW_WATER;
  // Any wait ends when the channel closes, so a vanished peer never pins this.
  let wake=()=>{};channel.onclose=()=>wake();
  const until=(ready:()=>boolean,ms:number)=>new Promise<void>((resolve,reject)=>{if(ready())return resolve();if(channel.readyState==='closing'||channel.readyState==='closed')return reject(Error('File channel closed'));const timer=setTimeout(()=>{wake=()=>{};reject(Error('File transfer stalled'));},ms);wake=()=>{clearTimeout(timer);wake=()=>{};if(ready())resolve();else reject(Error('File channel closed'));};channel.onopen=channel.onbufferedamountlow=()=>wake();});
  try{
   await until(()=>channel.readyState==='open',FILE_IDLE_MS);
   channel.send(JSON.stringify({id:record.id,size:record.meta.size,sha256:record.meta.sha256}));
   for(let at=0;at<record.meta.size;at+=FILE_READ){
    const slab=await bytesOf(record.blob!.slice(at,at+FILE_READ));
    for(let i=0;i<slab.byteLength;i+=FILE_CHUNK){
     if(this.stopped||channel.readyState!=='open')throw Error('File channel closed');
     if(channel.bufferedAmount>FILE_HIGH_WATER)await until(()=>channel.readyState==='open'&&channel.bufferedAmount<=FILE_LOW_WATER,FILE_IDLE_MS);
     channel.send(slab.slice(i,i+FILE_CHUNK));
    }
   }
   channel.send(JSON.stringify({done:true}));
   // The recipient closes once verified; this only reclaims an abandoned channel.
   setTimeout(()=>channel.close(),FILE_IDLE_MS*2);
  }catch(error){channel.close();throw error;}
 }
 private fileUnavailable(p:{attachmentId:string;reason:UnavailableReason},sender:Device){
  if(typeof p.attachmentId!=='string'||!REASONS.includes(p.reason))throw Error('Invalid peer message');
  const d=this.downloads.get(p.attachmentId);if(!d||!d.devices.has(sender.id)||d.channel)return;
  d.replies.set(sender.id,p.reason);
  // With several candidate devices, wait for all; "offline" (the holder exists
  // but has no direct link) is the most useful answer, then "denied".
  if(d.replies.size===d.devices.size)this.finish(p.attachmentId,new AttachmentUnavailable(REASONS.find(r=>[...d.replies.values()].includes(r))!));
 }
 /** Recipient side: only a channel for a pull this device started, opened by a
  * device it asked, on that device's current connection, is read at all. */
 private acceptFile(device:Device,pc:RTCPeerConnection,channel:RTCDataChannel){
  const id=channel.label.slice(FILE_CHANNEL.length),d=this.downloads.get(id);
  if(!d||!d.devices.has(device.id)||d.channel||this.peers.get(device.id)?.pc!==pc){channel.close();return;}
  d.channel=channel;channel.binaryType='arraybuffer';this.idle(id);
  const chunks:ArrayBuffer[]=[];let received=0,header=false,done=false;
  const fail=(detail:string)=>{done=true;this.finish(id,Error(detail));};
  channel.onclose=()=>{if(!done)fail('The transfer was interrupted');};
  channel.onmessage=e=>{
   if(done)return;this.idle(id);
   if(typeof e.data==='string'){
    let value:{id?:unknown;size?:unknown;sha256?:unknown;done?:unknown};try{value=JSON.parse(e.data);}catch{return fail('Malformed file transfer');}
    if(!header){if(value?.id!==id||value.size!==d.meta.size||value.sha256!==d.meta.sha256)return fail('The file does not match the message');header=true;return;}
    if(value?.done!==true)return fail('Malformed file transfer');
    done=true;void this.completeFile(id,device,new Blob(chunks,{type:d.meta.type}));return;
   }
   if(!header||!isArrayBuffer(e.data))return fail('Malformed file transfer');
   received+=e.data.byteLength;if(received>d.meta.size)return fail('The file is larger than the message declared');
   chunks.push(e.data);for(const fn of d.progress)try{fn(received,d.meta.size);}catch{/* progress is advisory */}
   this.emit({attachmentId:id,messageId:d.messageId,state:'downloading',received,total:d.meta.size});
  };
 }
 private async completeFile(id:string,device:Device,blob:Blob){
  const d=this.downloads.get(id);if(!d)return;
  d.channel?.close();
  // Size and hash come from the signed message, never from the transfer itself.
  if(blob.size!==d.meta.size)return this.finish(id,Error('The file arrived incomplete'));
  if(await sha256(blob).catch(()=>'')!==d.meta.sha256)return this.finish(id,Error('The file failed its integrity check'));
  await this.files.put({id,meta:d.meta,messageId:d.messageId,origin:'received',allowedUsers:[],device:device.id,blob,created:Date.now()}).catch(()=>{/* still usable this session */});
  this.finish(id,blob);
 }
 private connection(device:Device,iceServers:RTCIceServer[]=this.iceServers){
  const pc=this.options.rtc?.({iceServers})??new RTCPeerConnection({iceServers});const peer:{pc:RTCPeerConnection;channel?:RTCDataChannel}={pc};this.peers.set(device.id,peer);
  const attach=(channel:RTCDataChannel)=>{peer.channel=channel;channel.onmessage=e=>{if(typeof e.data!=='string'||e.data.length>50000)return;try{void this.receive(JSON.parse(e.data)).catch(()=>this.options.status('A direct message could not be verified.'));}catch{/* reject malformed peer input */}};};
  // File transfers get their own channel and handler; the message channel's stays as is.
  pc.ondatachannel=e=>{if(e.channel.label.startsWith(FILE_CHANNEL))this.acceptFile(device,pc,e.channel);else attach(e.channel);};pc.onconnectionstatechange=()=>{if(['closed','failed'].includes(pc.connectionState)&&this.peers.get(device.id)===peer){pc.close();this.peers.delete(device.id);}};
  return {pc,attach};
 }
 private async gathered(pc:RTCPeerConnection){
  if(pc.iceGatheringState==='complete')return;
  await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);resolve();};const changed=()=>{if(pc.iceGatheringState==='complete')finish();};const timer=setTimeout(finish,4000);pc.addEventListener('icegatheringstatechange',changed);});
 }
 private async offer(device:Device,iceServers:RTCIceServer[]){
  const {pc,attach}=this.connection(device,iceServers);attach(pc.createDataChannel('canopy-im-v1',{ordered:true}));
  try{await pc.setLocalDescription(await pc.createOffer());await this.gathered(pc);if(pc.localDescription&&!this.stopped)await this.deliver(device,{kind:'signal',description:pc.localDescription.toJSON()},true);}catch(error){pc.close();this.peers.delete(device.id);throw error;}
 }
 private async signal(device:Device,description:RTCSessionDescriptionInit){
  if(!description||!['offer','answer'].includes(description.type)||typeof description.sdp!=='string'||description.sdp.length>20000)throw Error('Invalid peer offer');
  if(description.type==='offer'){
   if(device.id>this.identity!.id)return;
   this.peers.get(device.id)?.pc.close();const {pc}=this.connection(device);
   await pc.setRemoteDescription(description);await pc.setLocalDescription(await pc.createAnswer());await this.gathered(pc);
   if(pc.localDescription)await this.deliver(device,{kind:'signal',description:pc.localDescription.toJSON()},true);
  }else{const pc=this.peers.get(device.id)?.pc;if(pc?.signalingState==='have-local-offer')await pc.setRemoteDescription(description);}
 }
}
