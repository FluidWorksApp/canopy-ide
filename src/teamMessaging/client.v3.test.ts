// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {waitFor} from '@testing-library/react';
import {PeerClient,RETRY_STEPS,nextRetryAt,type ChatMessage,type Device} from './client';
import {createIdentity,publicIdentity,seal,type Identity} from './crypto';
import {BACKFILL_MS,CHAT_VERSION,DELETE_TEXT,editText,reactionText} from './chatEvents';
import type {PendingEnvelope} from './store';
import {registrationProof,relayEnvelope} from '../../packages/control-plane/lib/peer-messaging.mjs';
beforeAll(()=>vi.stubGlobal('crypto',webcrypto));
const clients:PeerClient[]=[];afterEach(()=>{clients.splice(0).forEach(c=>c.stop());localStorage.clear();vi.useRealTimers();});

/** An in-memory control plane: the real relay validation, a queue, acks. */
function harness(){
 const devices=new Map<string,{id:string;user_id:string;public_keys:ReturnType<typeof registrationProof>}>();
 const queue:{id:string;recipient:string;envelope:unknown}[]=[],wire:unknown[]=[],acked:string[]=[];
 let failRelay=false;const relayAt:number[]=[];
 const api=(user:string)=>async<T,>(value:unknown):Promise<T>=>{
  const b=value as Record<string,any>;wire.push(value);
  if(b.action==='register'){devices.set(b.deviceId,{id:b.deviceId,user_id:user,public_keys:registrationProof(user,b)});return {} as T;}
  if(b.action==='directory')return {devices:[...devices.values()],members:[...new Set([...devices.values()].map(d=>d.user_id))].map(id=>({id,name:id}))} as T;
  if(b.action==='poll')return {envelopes:queue.filter(e=>e.recipient===b.deviceId)} as T;
  if(b.action==='ack'){acked.push(...b.ids);for(let i=queue.length-1;i>=0;i--)if(b.ids.includes(queue[i].id)&&queue[i].recipient===b.deviceId)queue.splice(i,1);return {} as T;}
  if(b.action==='relay'){if(user==='alice')relayAt.push(Date.now());if(failRelay&&user==='alice')throw Error('Relay unavailable');const sender=devices.get(b.deviceId)!,recipient=devices.get(b.recipientDevice)!;queue.push({id:crypto.randomUUID(),recipient:recipient.id,envelope:relayEnvelope(b,user,sender,recipient)});return {} as T;}
  throw Error('Unexpected peer operation');
 };
 type Got={messages:ChatMessage[];backfills:string[];receipts:string[];reads:[string,string][];statuses:string[];undelivered:[string,string][];online:string[];retrying:[string,number][]};
 const got=new Map<string,Got>();
 const keys=new Map<string,Identity>();
 async function endpoint(user:string,id:string,extra:{outbox?:PendingEnvelope[];identity?:Identity}={}){
  const identity=extra.identity??keys.get(id)??await createIdentity(),seen=new Set<string>();keys.set(id,identity);
  const g:Got={messages:[],backfills:[],receipts:[],reads:[],statuses:[],undelivered:[],online:[],retrying:[]};got.set(user,g);
  const client=new PeerClient({user,team:'team',identity:async()=>({id,keys:identity}),request:api(user),outbox:{load:async()=>extra.outbox??[],put:async()=>{},remove:async()=>{}},
   remember:async key=>{if(seen.has(key))return false;seen.add(key);return true;},rtc:()=>{throw Error('Direct transport unavailable');},random:()=>0.5,
   message:(m,meta)=>{g.messages.push(m);if(meta?.backfill)g.backfills.push(m.id);},receipt:rid=>g.receipts.push(rid),status:s=>g.statuses.push(s),
   read:(rid,reader)=>g.reads.push([rid,reader]),undelivered:(mid,d:Device)=>g.undelivered.push([mid,d.id]),online:(d:Device)=>g.online.push(d.id),retrying:(mid,at)=>g.retrying.push([mid,at])});
  clients.push(client);await client.start();return client;
 }
 async function inject(from:{user:string;id:string},to:{user:string;id:string},payload:unknown,now=Date.now()){
  const envelope=await seal(keys.get(from.id)!,await publicIdentity(keys.get(to.id)!),{team:'team',user:from.user,device:from.id},{team:'team',user:to.user,device:to.id},JSON.stringify(payload),now);
  const row={id:crypto.randomUUID(),recipient:to.id,envelope};queue.push(row);return row.id;
 }
 return {endpoint,inject,got:(user:string)=>got.get(user)!,wire,acked,queue,keys,relayAt,setFailRelay:(v:boolean)=>{failRelay=v;}};
}
const ALICE='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',BOB='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',SAM='cccccccc-cccc-cccc-cccc-cccccccccccc',CAROL='dddddddd-dddd-dddd-dddd-dddddddddddd';
const alice={user:'alice',id:ALICE},bob={user:'bob',id:BOB},carol={user:'carol',id:CAROL};
/** Makes `client` learn that `device` speaks `chat`, as a WebRTC signal would tell it. */
async function learn(h:ReturnType<typeof harness>,from:{user:string;id:string},to:{user:string;id:string},chat:number){
 const id=await h.inject(from,to,{kind:'signal',description:{type:'answer',sdp:'v=0'},caps:{chat}});
 await waitFor(()=>expect(h.acked).toContain(id),{timeout:4000});
}
const msg=(over:Partial<ChatMessage>={}):ChatMessage=>({id:crypto.randomUUID(),sender:'bob',recipient:null,text:'hello',created:Date.now(),v:CHAT_VERSION,...over});

describe('retry backoff',()=>{
 it('follows 5/10/20/40/60s with ±20% jitter, bounded by the envelope expiry',()=>{
  expect(RETRY_STEPS).toEqual([5,10,20,40,60]);
  const at=(attempt:number,r:number)=>nextRetryAt(attempt,0,10_000_000,()=>r)/1000;
  expect([0,1,2,3,4,5,9].map(n=>at(n,0.5))).toEqual([5,10,20,40,60,60,60]);
  expect([0,1,2,3,4].map(n=>at(n,0))).toEqual([4,8,16,32,48]);
  expect([0,1,2,3,4].map(n=>at(n,1))).toEqual([6,12,24,48,72]);
  expect(nextRetryAt(4,1000,30_000,()=>1)).toBe(30_000);
 });
 it('retries a queued envelope on that schedule, announces the next retry, and retries at once on request',async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true,toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']});
  const h=harness();const a=await h.endpoint('alice',ALICE);await h.endpoint('bob',BOB);
  h.setFailRelay(true);
  const t0=Date.now();
  const sent=await a.send('Are you there?','bob');expect(sent.queued).toBe(true);
  const first=h.got('alice').retrying.at(-1)!;expect(first[0]).toBe(sent.id);expect(first[1]-t0).toBeGreaterThanOrEqual(5000);expect(first[1]-t0).toBeLessThan(5200);
  h.relayAt.length=0;
  await vi.advanceTimersByTimeAsync(80_000);
  // Polls run every 2s, so each retry lands on the first poll after it is due.
  const gaps=h.relayAt.map((t,i)=>t-(i?h.relayAt[i-1]:t0));
  expect(gaps.length).toBeGreaterThanOrEqual(4);
  for(const [i,g] of gaps.slice(0,4).entries())expect(g).toBeGreaterThanOrEqual([5,10,20,40][i]*1000-10);
  for(const [i,g] of gaps.slice(0,4).entries())expect(g).toBeLessThanOrEqual([5,10,20,40][i]*1000+2100);
  const before=h.relayAt.length;
  expect(await a.retryNow(sent.id)).toBe(true);
  expect(h.relayAt.length).toBe(before+1);
  expect(await a.retryNow(crypto.randomUUID())).toBe(false);
 },20000);
});

describe('chat v3 traffic',()=>{
 it('never sends a v3-only payload to a v2 or unknown device',async()=>{
  const h=harness();const a=await h.endpoint('alice',ALICE);await h.endpoint('bob',BOB);await h.endpoint('carol',CAROL);await h.endpoint('sam',SAM);
  await learn(h,bob,alice,3);await learn(h,carol,alice,2);
  expect([BOB,CAROL,SAM].map(d=>a.chatCapability(d))).toEqual([3,2,1]);
  expect(a.usersBelow(3,null).sort()).toEqual(['carol','sam']);
  const target:ChatMessage={id:crypto.randomUUID(),sender:'alice',recipient:null,text:'Ship it?',created:Date.now()};
  const edit:ChatMessage={id:crypto.randomUUID(),sender:'alice',recipient:null,text:editText('Ship it!'),created:Date.now(),v:CHAT_VERSION,event:{type:'edit',target:target.id,text:'Ship it!'}};
  const del:ChatMessage={id:crypto.randomUUID(),sender:'alice',recipient:null,text:DELETE_TEXT,created:Date.now(),v:CHAT_VERSION,event:{type:'delete',target:target.id}};
  const react:ChatMessage={id:crypto.randomUUID(),sender:'alice',recipient:null,text:reactionText('👍','add',target),created:Date.now(),v:CHAT_VERSION,event:{type:'reaction',target:target.id,emoji:'👍',op:'add'}};
  expect(await a.sendEvent(edit)).toMatchObject({devices:1});
  expect(await a.sendEvent(del)).toMatchObject({devices:1});
  expect(await a.sendEvent(react)).toMatchObject({devices:2});
  expect(await a.sendReadReceipt(crypto.randomUUID(),'carol')).toBe(0);
  expect(await a.sendReadReceipt(crypto.randomUUID(),'sam')).toBe(0);
  expect(await a.backfill(CAROL,target)).toBe(false);
  expect(await a.backfill(SAM,target)).toBe(false);
  await waitFor(()=>expect(h.got('bob').messages.map(m=>m.id)).toEqual(expect.arrayContaining([edit.id,del.id,react.id])),{timeout:4000});
  await waitFor(()=>expect(h.got('carol').messages.map(m=>m.id)).toContain(react.id),{timeout:4000});
  expect(h.got('carol').messages.map(m=>m.id)).toEqual([react.id]);
  expect(h.got('sam').messages).toEqual([]);
 },20000);
 it('delivers a read receipt to the author, outside the delivery-receipt bookkeeping',async()=>{
  const h=harness();const a=await h.endpoint('alice',ALICE);const b=await h.endpoint('bob',BOB);
  const sent=await a.send('Read me','bob');
  await waitFor(()=>expect(h.got('bob').messages.map(m=>m.id)).toContain(sent.id),{timeout:4000});
  // Bob learned Alice speaks v3 from her message; the receipt is not queued.
  expect(b.chatCapability(ALICE)).toBe(CHAT_VERSION);
  expect(await b.sendReadReceipt(sent.id,'alice')).toBe(1);
  await waitFor(()=>expect(h.got('alice').reads).toEqual([[sent.id,'bob']]),{timeout:4000});
  // A read receipt for an id this run never sent still reaches the session (which checks it), without a verification error.
  const other=crypto.randomUUID();await b.sendReadReceipt(other,'alice');
  await waitFor(()=>expect(h.got('alice').reads.map(r=>r[0])).toContain(other),{timeout:4000});
  expect(h.got('alice').statuses.filter(s=>s.includes('could not be verified'))).toEqual([]);
 },15000);
 it('accepts a backfilled message from its author up to seven days old, and nothing else',async()=>{
  const h=harness();await h.endpoint('alice',ALICE);await h.endpoint('bob',BOB);
  const now=Date.now();
  const ok=msg({created:now-BACKFILL_MS+60_000}),old=msg({created:now-BACKFILL_MS-60_000}),future=msg({created:now+120_000}),forged=msg({sender:'sam',created:now-86_400_000}),plainOld=msg({created:now-3_600_000});
  await h.inject(bob,alice,{kind:'message',message:ok,backfill:true},now);
  for(const [message,backfill] of [[old,true],[future,true],[forged,true],[plainOld,false]] as const)await h.inject(bob,alice,{kind:'message',message,backfill},now);
  await waitFor(()=>expect(h.got('alice').statuses.filter(s=>s.includes('could not be verified')).length).toBeGreaterThanOrEqual(4),{timeout:6000});
  expect(h.got('alice').messages.map(m=>m.id)).toEqual([ok.id]);
  expect(h.got('alice').backfills).toEqual([ok.id]);
 },15000);
 it('reports deliveries that expired while closed, for v3 devices only, and announces devices that come online',async()=>{
  const h=harness();const a=await h.endpoint('alice',ALICE);await h.endpoint('bob',BOB);await h.endpoint('carol',CAROL);
  await learn(h,bob,alice,3);await learn(h,carol,alice,2);
  expect(h.got('alice').online.sort()).toEqual([BOB,CAROL]);
  a.stop();
  const old=Date.now()-600_000,message=msg({sender:'alice',recipient:null,created:old});
  const expired=async(to:{user:string;id:string}):Promise<PendingEnvelope>=>({messageId:message.id,envelope:await seal(h.keys.get(ALICE)!,await publicIdentity(h.keys.get(to.id)!),{team:'team',user:'alice',device:ALICE},{team:'team',user:to.user,device:to.id},'{}',old)});
  await h.endpoint('alice',ALICE,{outbox:[await expired(bob),await expired(carol)]});
  await waitFor(()=>expect(h.got('alice').undelivered).toEqual([[message.id,BOB]]),{timeout:4000});
 },15000);
});
