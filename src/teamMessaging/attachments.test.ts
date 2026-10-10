// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {waitFor} from '@testing-library/react';
import {PeerClient,AttachmentUnavailable,FILE_CHANNEL,type AttachmentEvent,type ChatMessage} from './client';
import {createIdentity} from './crypto';
import {memoryFileStore,prepareFile,sha256} from './files';
import {registrationProof,relayEnvelope} from '../../packages/control-plane/lib/peer-messaging.mjs';
beforeAll(()=>vi.stubGlobal('crypto',webcrypto));
const clients:PeerClient[]=[];afterEach(()=>{clients.splice(0).forEach(c=>c.stop());connections.length=0;offers.clear();});

/** In-memory WebRTC: an offer and its answer pair two connections; data
 * channels pair across them and deliver strings and ArrayBuffers in order. */
class FakeChannel{
 readyState:RTCDataChannelState='connecting';binaryType='blob';bufferedAmount=0;bufferedAmountLowThreshold=0;peer?:FakeChannel;
 onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onmessage:((e:{data:unknown})=>void)|null=null;onbufferedamountlow:(()=>void)|null=null;
 label:string;pc:FakePC;
 constructor(label:string,pc:FakePC){this.label=label;this.pc=pc;}
 send(data:string|ArrayBuffer){
  if(this.readyState!=='open')throw Error('InvalidStateError');
  const size=typeof data==='string'?data.length:data.byteLength,copy=typeof data==='string'?data:data.slice(0);this.bufferedAmount+=size;
  setTimeout(()=>{this.bufferedAmount-=size;if(this.peer?.readyState==='open')this.peer.onmessage?.({data:copy});if(this.bufferedAmount<=this.bufferedAmountLowThreshold)this.onbufferedamountlow?.();},0);
 }
 open(){this.readyState='open';this.onopen?.();}
 close(){if(this.readyState==='closed')return;this.readyState='closed';setTimeout(()=>this.onclose?.(),0);this.peer?.close();}
}
const offers=new Map<string,FakePC>(),connections:FakePC[]=[];
class FakePC extends EventTarget{
 connectionState:RTCPeerConnectionState='new';signalingState:RTCSignalingState='stable';iceGatheringState:RTCIceGatheringState='complete';
 localDescription:(RTCSessionDescriptionInit&{toJSON:()=>RTCSessionDescriptionInit})|null=null;
 remote?:FakePC;channels:FakeChannel[]=[];
 ondatachannel:((e:{channel:FakeChannel})=>void)|null=null;onconnectionstatechange:(()=>void)|null=null;
 owner:string;
 constructor(owner:string){super();this.owner=owner;connections.push(this);}
 async createOffer(){return {type:'offer' as const,sdp:`offer-${crypto.randomUUID()}`};}
 async createAnswer(){return {type:'answer' as const,sdp:`answer-${crypto.randomUUID()}`};}
 async setLocalDescription(d:RTCSessionDescriptionInit){this.localDescription={...d,toJSON:()=>({type:d.type,sdp:d.sdp})};if(d.type==='offer'){this.signalingState='have-local-offer';offers.set(d.sdp!,this);}else{this.signalingState='stable';offers.set(d.sdp!,this);}}
 async setRemoteDescription(d:RTCSessionDescriptionInit){
  if(d.type==='offer'){this.remote=offers.get(d.sdp!);this.signalingState='have-remote-offer';return;}
  const answerer=offers.get(d.sdp!)!;this.signalingState='stable';this.remote=answerer;answerer.remote=this;
  for(const pc of [this,answerer]){pc.connectionState='connected';pc.onconnectionstatechange?.();}
  for(const channel of this.channels)this.pair(channel);
 }
 createDataChannel(label:string){const channel=new FakeChannel(label,this);this.channels.push(channel);if(this.connectionState==='connected')this.pair(channel);return channel as unknown as RTCDataChannel;}
 private pair(channel:FakeChannel){
  const remote=this.remote!,other=new FakeChannel(channel.label,remote);channel.peer=other;other.peer=channel;
  setTimeout(()=>{remote.ondatachannel?.({channel:other});if(other.readyState!=='closed'){other.open();channel.open();}},0);
 }
 close(){this.connectionState='closed';for(const c of this.channels)c.close();}
}

const ALICE='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',BOB='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',CAROL='cccccccc-cccc-cccc-cccc-cccccccccccc';
/** A team of endpoints over the real relay envelope checks. `direct` decides
 * which users get a working RTCPeerConnection. */
async function team(direct=new Set(['alice','bob','carol'])){
 const devices=new Map<string,{id:string;user_id:string;public_keys:ReturnType<typeof registrationProof>}>();
 const queue:{id:string;recipient:string;envelope:unknown}[]=[];const wire:unknown[]=[];
 const api=(user:string)=>async<T,>(value:unknown):Promise<T>=>{
  const b=value as Record<string,any>;wire.push(value);
  if(b.action==='register'){devices.set(b.deviceId,{id:b.deviceId,user_id:user,public_keys:registrationProof(user,b)});return {} as T;}
  if(b.action==='directory')return {devices:[...devices.values()]} as T;
  if(b.action==='poll')return {envelopes:queue.filter(e=>e.recipient===b.deviceId)} as T;
  if(b.action==='ack'){for(let i=queue.length-1;i>=0;i--)if(b.ids.includes(queue[i].id)&&queue[i].recipient===b.deviceId)queue.splice(i,1);return {} as T;}
  if(b.action==='relay'){const sender=devices.get(b.deviceId)!,recipient=devices.get(b.recipientDevice)!;queue.push({id:crypto.randomUUID(),recipient:recipient.id,envelope:relayEnvelope(b,user,sender,recipient)});return {} as T;}
  throw Error('Unexpected peer operation');
 };
 async function endpoint(user:string,id:string){
  const keys=await createIdentity(),seen=new Set<string>(),files=memoryFileStore(),messages:ChatMessage[]=[],events:AttachmentEvent[]=[];
  const client=new PeerClient({user,team:'team',identity:async()=>({id,keys}),request:api(user),outbox:{load:async()=>[],put:async()=>{},remove:async()=>{}},files,
   remember:async key=>{if(seen.has(key))return false;seen.add(key);return true;},
   rtc:()=>{if(!direct.has(user))throw Error('Direct transport unavailable');return new FakePC(user) as unknown as RTCPeerConnection;},
   message:m=>messages.push(m),receipt:()=>{},status:()=>{},attachment:e=>events.push(e)});
  clients.push(client);await client.start();return {client,files,messages,events,id};
 }
 return {endpoint,wire};
}
const connected=(a:string,b:string)=>connections.some(pc=>pc.owner===a&&pc.remote?.owner===b&&pc.connectionState==='connected');
const file=(text:string,name='notes.txt')=>Object.assign(new Blob([text],{type:'text/plain'}),{name});
const big=()=>{const bytes=new Uint8Array(70_000);for(let i=0;i<bytes.length;i++)bytes[i]=i*7%251;return Object.assign(new Blob([bytes],{type:'application/octet-stream'}),{name:'build.bin'});};

it('pulls a file peer to peer over its own data channel, verified against the signed hash',async()=>{
 const {endpoint,wire}=await team();const alice=await endpoint('alice',ALICE),bob=await endpoint('bob',BOB);
 await waitFor(()=>expect(connected('alice','bob')).toBe(true),{timeout:8000});
 const payload=big(),{id}=await alice.client.send('','bob',undefined,[payload]);
 await waitFor(()=>expect(bob.messages.some(m=>m.id===id)).toBe(true),{timeout:6000});
 const message=bob.messages.find(m=>m.id===id)!,meta=message.attachments![0];
 expect(meta).toMatchObject({name:'build.bin',size:70_000,type:'application/octet-stream',sha256:await sha256(payload)});
 // The sender keeps the bytes locally; the recipient knows which device holds them.
 expect(alice.files.rows.get(meta.id)).toMatchObject({origin:'sent',allowedUsers:['bob']});
 expect(bob.files.rows.get(meta.id)).toMatchObject({origin:'received',device:ALICE});expect(bob.files.rows.get(meta.id)!.blob).toBeUndefined();
 const progress:number[]=[];
 const blob=await bob.client.requestAttachment(message,meta.id,received=>progress.push(received));
 expect(blob.size).toBe(70_000);expect(await sha256(blob)).toBe(meta.sha256);
 expect(progress.at(-1)).toBe(70_000);expect(progress.length).toBeGreaterThan(1);
 expect(bob.events.at(-1)).toMatchObject({attachmentId:meta.id,state:'available'});
 expect(bob.files.rows.get(meta.id)!.blob?.size).toBe(70_000);
 const channel=connections.find(pc=>pc.owner==='alice'&&pc.remote?.owner==='bob')!.channels.find(c=>c.label===FILE_CHANNEL+meta.id);
 expect(channel?.label).toBe(FILE_CHANNEL+meta.id);
 // No byte of the file ever reached the control plane: only the request and metadata did.
 const relayed=JSON.stringify(wire);expect(relayed.length).toBeLessThan(70_000);
 // A second request is served from this device's own copy.
 expect(await bob.client.requestAttachment(message,meta.id)).toBe(bob.files.rows.get(meta.id)!.blob);
},20000);

it('refuses a request from a user the file was not sent to',async()=>{
 const {endpoint}=await team();const alice=await endpoint('alice',ALICE),bob=await endpoint('bob',BOB),carol=await endpoint('carol',CAROL);
 await waitFor(()=>expect(connected('alice','carol')).toBe(true),{timeout:8000});
 const {id}=await alice.client.send('for bob only','bob',undefined,[file('secret')]);
 await waitFor(()=>expect(bob.messages.some(m=>m.id===id)).toBe(true),{timeout:6000});
 // Carol learns the metadata somehow and asks anyway.
 const message=bob.messages.find(m=>m.id===id)!;
 const error=await carol.client.requestAttachment(message,message.attachments![0].id).catch(e=>e);
 expect(error).toBeInstanceOf(AttachmentUnavailable);expect(error.reason).toBe('denied');
 expect(connections.some(pc=>pc.owner==='alice'&&pc.channels.some(c=>c.label.startsWith(FILE_CHANNEL)))).toBe(false);
},20000);

it('rejects bytes that do not match the hash in the message',async()=>{
 const {endpoint}=await team();const alice=await endpoint('alice',ALICE),bob=await endpoint('bob',BOB);
 await waitFor(()=>expect(connected('alice','bob')).toBe(true),{timeout:8000});
 const {id}=await alice.client.send('report','bob',undefined,[file('original contents')]);
 await waitFor(()=>expect(bob.messages.some(m=>m.id===id)).toBe(true),{timeout:6000});
 const message=bob.messages.find(m=>m.id===id)!,meta=message.attachments![0];
 // The sender's stored copy changes after the message was signed (same length).
 const row=alice.files.rows.get(meta.id)!;row.blob=new Blob(['tampered content!']);expect(row.blob.size).toBe(meta.size);
 await expect(bob.client.requestAttachment(message,meta.id)).rejects.toThrow('integrity check');
 expect(bob.files.rows.get(meta.id)!.blob).toBeUndefined();
 expect(bob.events.at(-1)).toMatchObject({state:'failed'});
},20000);

it('ignores a file channel this device did not request',async()=>{
 const {endpoint}=await team();const alice=await endpoint('alice',ALICE),bob=await endpoint('bob',BOB);
 await waitFor(()=>expect(connected('alice','bob')).toBe(true),{timeout:8000});
 const pc=connections.find(c=>c.owner==='alice'&&c.remote?.owner==='bob'&&c.connectionState==='connected')!;
 const pushed=pc.createDataChannel(FILE_CHANNEL+crypto.randomUUID()) as unknown as FakeChannel;
 await new Promise(r=>setTimeout(r,20));
 expect(pushed.readyState).toBe('closed');expect(bob.events).toEqual([]);expect(bob.files.rows.size).toBe(0);
 // The message channel is untouched and still carries chat directly.
 const {id}=await alice.client.send('still here','bob');
 await waitFor(()=>expect(bob.messages.some(m=>m.id===id)).toBe(true),{timeout:2000});
},20000);

it('answers file-unavailable (offline) when there is no direct connection, never relaying bytes',async()=>{
 const {endpoint,wire}=await team(new Set());const alice=await endpoint('alice',ALICE),bob=await endpoint('bob',BOB);
 const {id}=await alice.client.send('','bob',undefined,[file('only peer to peer')]);
 await waitFor(()=>expect(bob.messages.some(m=>m.id===id)).toBe(true),{timeout:6000});
 const message=bob.messages.find(m=>m.id===id)!;
 const error=await bob.client.requestAttachment(message,message.attachments![0].id).catch(e=>e);
 expect(error).toBeInstanceOf(AttachmentUnavailable);expect(error.reason).toBe('offline');
 expect(bob.events.at(-1)).toMatchObject({state:'unavailable',reason:'offline'});
 expect(JSON.stringify(wire)).not.toContain(btoa('only peer to peer'));
},20000);

it('prepares attachment metadata from picked or pasted files',async()=>{
 const pasted=await prepareFile(new Blob([new Uint8Array([1,2,3])],{type:'image/png'}));
 expect(pasted.meta).toMatchObject({name:'attachment.png',size:3,type:'image/png'});
 expect((await prepareFile(file('x','../../etc/passwd'))).meta.name).toBe('passwd');
 await expect(prepareFile(file(''))).rejects.toThrow('empty');
});
