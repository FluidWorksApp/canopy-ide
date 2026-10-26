// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {waitFor} from '@testing-library/react';
import {PeerClient,type ChatMessage} from './client';
import {createIdentity,publicIdentity,seal,type Identity} from './crypto';
import {CHAT_VERSION,reactionText} from './chatEvents';
import {registrationProof,relayEnvelope} from '../../packages/control-plane/lib/peer-messaging.mjs';
beforeAll(()=>vi.stubGlobal('crypto',webcrypto));
const clients:PeerClient[]=[];afterEach(()=>{clients.splice(0).forEach(c=>c.stop());localStorage.clear();});

/** An in-memory control plane: the real relay validation, a queue, acks. */
function harness(){
 const devices=new Map<string,{id:string;user_id:string;public_keys:ReturnType<typeof registrationProof>}>();
 const queue:{id:string;recipient:string;envelope:unknown}[]=[],wire:unknown[]=[],acked:string[]=[];
 const api=(user:string)=>async<T,>(value:unknown):Promise<T>=>{
  const b=value as Record<string,any>;wire.push(value);
  if(b.action==='register'){devices.set(b.deviceId,{id:b.deviceId,user_id:user,public_keys:registrationProof(user,b)});return {} as T;}
  if(b.action==='directory')return {devices:[...devices.values()]} as T;
  if(b.action==='poll')return {envelopes:queue.filter(e=>e.recipient===b.deviceId)} as T;
  if(b.action==='ack'){acked.push(...b.ids);for(let i=queue.length-1;i>=0;i--)if(b.ids.includes(queue[i].id)&&queue[i].recipient===b.deviceId)queue.splice(i,1);return {} as T;}
  if(b.action==='relay'){const sender=devices.get(b.deviceId)!,recipient=devices.get(b.recipientDevice)!;queue.push({id:crypto.randomUUID(),recipient:recipient.id,envelope:relayEnvelope(b,user,sender,recipient)});return {} as T;}
  throw Error('Unexpected peer operation');
 };
 const got={messages:new Map<string,ChatMessage[]>(),receipts:new Map<string,string[]>(),statuses:new Map<string,string[]>(),persisted:new Map<string,ChatMessage[]>()};
 const keys=new Map<string,Identity>();
 async function endpoint(user:string,id:string){
  const identity=await createIdentity(),seen=new Set<string>();keys.set(id,identity);
  for(const map of Object.values(got))map.set(user,[]);
  const client=new PeerClient({user,team:'team',identity:async()=>({id,keys:identity}),request:api(user),outbox:{load:async()=>[],put:async()=>{},remove:async()=>{}},
   remember:async key=>{if(seen.has(key))return false;seen.add(key);return true;},rtc:()=>{throw Error('Direct transport unavailable');},
   persist:async m=>{got.persisted.get(user)!.push(m);},message:m=>got.messages.get(user)!.push(m),receipt:rid=>got.receipts.get(user)!.push(rid),status:s=>got.statuses.get(user)!.push(s)});
  clients.push(client);await client.start();return client;
 }
 /** Seals any payload from one device to another and queues it on the relay, as a modified or newer client could. */
 async function inject(from:{user:string;id:string},to:{user:string;id:string},payload:unknown){
  const envelope=await seal(keys.get(from.id)!,await publicIdentity(keys.get(to.id)!),{team:'team',user:from.user,device:from.id},{team:'team',user:to.user,device:to.id},JSON.stringify(payload));
  const row={id:crypto.randomUUID(),recipient:to.id,envelope};queue.push(row);return row.id;
 }
 return {endpoint,inject,got,wire,acked,queue};
}
const ALICE='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',BOB='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',SAM='cccccccc-cccc-cccc-cccc-cccccccccccc';
const reactionTo=(target:ChatMessage,emoji='🎉',sender='alice'):ChatMessage=>({id:crypto.randomUUID(),sender,recipient:target.recipient===null?null:target.sender===sender?target.recipient:target.sender,text:reactionText(emoji,'add',target),created:Date.now(),v:CHAT_VERSION,event:{type:'reaction',target:target.id,emoji,op:'add'}});

it('sends a reaction as an encrypted chat message, only to devices known to speak v2',async()=>{
 const h=harness();const alice=await h.endpoint('alice',ALICE);const bob=await h.endpoint('bob',BOB);await h.endpoint('sam',SAM);
 // Every message this client sends says which protocol it speaks.
 const first=await bob.send('Ship it?',null);
 await waitFor(()=>expect(h.got.messages.get('alice')!.map(m=>m.id)).toContain(first.id),{timeout:4000});
 const target=h.got.messages.get('alice')![0];
 expect(target.v).toBe(CHAT_VERSION);
 expect(alice.speaksEvents(BOB)).toBe(true);expect(alice.speaksEvents(SAM)).toBe(false);
 const event=reactionTo(target);
 expect(await alice.sendEvent(event)).toMatchObject({id:event.id,devices:1});
 await waitFor(()=>expect(h.got.messages.get('bob')!.map(m=>m.id)).toContain(event.id),{timeout:4000});
 // Sam has not shown it speaks v2, so a possibly 0.4.10 client never gets fallback text.
 expect(h.got.messages.get('sam')!.map(m=>m.id)).not.toContain(event.id);
 // The relay saw ciphertext only; the event got the message path's receipt and was saved on both ends.
 expect(JSON.stringify(h.wire)).not.toContain('🎉');
 await waitFor(()=>expect(h.got.receipts.get('alice')).toContain(event.id),{timeout:4000});
 expect(h.got.persisted.get('alice')!.map(m=>m.id)).toContain(event.id);
 expect(h.got.persisted.get('bob')!.find(m=>m.id===event.id)?.event).toEqual(event.event);
 await expect(alice.sendEvent({...reactionTo(target),event:undefined})).rejects.toThrow('Invalid chat event');
 await expect(alice.sendEvent({...reactionTo(target),sender:'bob'})).rejects.toThrow('Invalid chat event');
},15000);

it('keeps a reaction local when no device of the conversation is known to speak v2',async()=>{
 const h=harness();const alice=await h.endpoint('alice',ALICE);await h.endpoint('bob',BOB);
 const event=reactionTo({id:crypto.randomUUID(),sender:'bob',recipient:'alice',text:'hi',created:Date.now()});
 expect(await alice.sendEvent(event)).toMatchObject({devices:0,queued:false});
 expect(h.got.messages.get('alice')!.map(m=>m.id)).toEqual([event.id]);
 expect(h.wire.some(w=>(w as {action?:string}).action==='relay')).toBe(false);
});

it('learns a device\'s chat version from the capabilities in its WebRTC signal',async()=>{
 const h=harness();const alice=await h.endpoint('alice',ALICE);await h.endpoint('bob',BOB);
 const id=await h.inject({user:'bob',id:BOB},{user:'alice',id:ALICE},{kind:'signal',description:{type:'answer',sdp:'v=0'},caps:{chat:2}});
 await waitFor(()=>expect(h.acked).toContain(id),{timeout:4000});
 expect(alice.speaksEvents(BOB)).toBe(true);
},10000);

it('refuses an event sent in another person\'s name',async()=>{
 const h=harness();await h.endpoint('alice',ALICE);await h.endpoint('bob',BOB);
 const target:ChatMessage={id:crypto.randomUUID(),sender:'alice',recipient:null,text:'hi',created:Date.now()};
 await h.inject({user:'bob',id:BOB},{user:'alice',id:ALICE},{kind:'message',message:reactionTo(target,'👍','sam')});
 await waitFor(()=>expect(h.got.statuses.get('alice')).toContain('A message could not be verified.'),{timeout:4000});
 expect(h.got.messages.get('alice')).toEqual([]);
},10000);

it('acknowledges and ignores a payload kind from a newer client, without a message or a verification error',async()=>{
 const h=harness();await h.endpoint('alice',ALICE);await h.endpoint('bob',BOB);
 const id=await h.inject({user:'bob',id:BOB},{user:'alice',id:ALICE},{kind:'sticker',sticker:{id:'x'}});
 await waitFor(()=>expect(h.acked).toContain(id),{timeout:4000});
 expect(h.got.messages.get('alice')).toEqual([]);
 expect(h.got.statuses.get('alice')!.filter(s=>s.includes('could not be verified'))).toEqual([]);
},10000);

it('remembers which devices speak v2 across a restart, until a device is re-keyed',async()=>{
 const h=harness();const alice=await h.endpoint('alice',ALICE);const bob=await h.endpoint('bob',BOB);
 const sent=await bob.send('Ship it?',null);
 await waitFor(()=>expect(h.got.messages.get('alice')!.map(m=>m.id)).toContain(sent.id),{timeout:4000});
 expect(alice.speaksEvents(BOB)).toBe(true);
 const target=h.got.messages.get('alice')![0];
 // Restart: a fresh client for the same account and team knows before any traffic.
 alice.stop();
 const restarted=await h.endpoint('alice',ALICE);
 expect(restarted.speaksEvents(BOB)).toBe(true);
 expect(await restarted.sendEvent(reactionTo(target))).toMatchObject({devices:1});
 // Bob's device re-registers with new keys (a reinstall, maybe an older build): unknown again.
 bob.stop();await h.endpoint('bob',BOB);
 await waitFor(()=>expect(restarted.speaksEvents(BOB)).toBe(false),{timeout:6000});
 expect(await restarted.sendEvent(reactionTo(target,'👀'))).toMatchObject({devices:0});
},20000);
