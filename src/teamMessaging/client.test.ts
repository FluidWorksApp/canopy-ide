// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {waitFor} from '@testing-library/react';
import {PeerClient,type ChatMessage,type PeerRequest} from './client';
import {createIdentity} from './crypto';
import {registrationProof,relayEnvelope} from '../../packages/control-plane/lib/peer-messaging.mjs';
beforeAll(()=>vi.stubGlobal('crypto',webcrypto));
const clients:PeerClient[]=[];afterEach(()=>{clients.splice(0).forEach(c=>c.stop());});
it('two authenticated endpoints deliver encrypted relay messages, receipts and reject revoked access',async()=>{
 const devices=new Map<string,{id:string;user_id:string;public_keys:ReturnType<typeof registrationProof>}>();
 const queue:{id:string;recipient:string;envelope:unknown}[]=[];const removed=new Set<string>();const wire:unknown[]=[];
 const api=(user:string)=>async<T,>(value:unknown):Promise<T>=>{
  const b=value as Record<string,any>;wire.push(value);
  if(b.action==='register'){devices.set(b.deviceId,{id:b.deviceId,user_id:user,public_keys:registrationProof(user,b)});return {} as T;}
  if(removed.has(user))throw Error('Team not found');
  if(b.action==='directory')return {devices:[...devices.values()].filter(d=>!removed.has(d.user_id))} as T;
  if(b.action==='poll')return {envelopes:queue.filter(e=>e.recipient===b.deviceId)} as T;
  if(b.action==='ack'){for(let i=queue.length-1;i>=0;i--)if(b.ids.includes(queue[i].id)&&queue[i].recipient===b.deviceId)queue.splice(i,1);return {} as T;}
  if(b.action==='relay'){const sender=devices.get(b.deviceId)!,recipient=devices.get(b.recipientDevice)!;const envelope=relayEnvelope(b,user,sender,recipient);queue.push({id:crypto.randomUUID(),recipient:recipient.id,envelope});return {} as T;}
  throw Error('Unexpected peer operation');
 };
 const received:ChatMessage[]=[],receipts:string[]=[];
 async function endpoint(user:string,id:string){const keys=await createIdentity(),seen=new Set<string>();const outbox={load:async()=>[],put:async()=>{},remove:async()=>{}};const client=new PeerClient({user,team:'team',identity:async()=>({id,keys}),request:api(user),outbox,remember:async key=>{if(seen.has(key))return false;seen.add(key);return true;},rtc:()=>{throw Error('Direct transport unavailable');},message:m=>{if(user==='bob')received.push(m);},receipt:id=>receipts.push(id),status:()=>{}});clients.push(client);await client.start();return client;}
 const alice=await endpoint('alice','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');await endpoint('bob','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
 await expect(alice.send('\u0000'.repeat(6000),'bob')).rejects.toThrow('too large after encoding');
 expect(received).toHaveLength(0);
 const result=await alice.send('Only the endpoints can read this','bob');
 expect(JSON.stringify(wire)).not.toContain('Only the endpoints can read this');
 await waitFor(()=>expect(received).toHaveLength(1),{timeout:4000});
 expect(received[0].text).toBe('Only the endpoints can read this');
 await waitFor(()=>expect(receipts).toContain(result.id),{timeout:4000});
 removed.add('alice');await expect(alice.send('Should fail','bob')).rejects.toThrow('Team not found');
},10000);

it('retries registration after starting offline without requiring another conversation tab',async()=>{
 const keys=await createIdentity(),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';let attempts=0,listed=false;
 const client=new PeerClient({user:'alice',team:'team',identity:async()=>({id,keys}),outbox:{load:async()=>[],put:async()=>{},remove:async()=>{}},request:async<T,>(value:unknown)=>{const body=value as any;if(body.action==='register'){if(++attempts===1)throw Error('Offline');return {} as T;}if(body.action==='directory'){listed=true;return {devices:[{id,user_id:'alice',public_keys:{}}]} as T;}return {envelopes:[]} as T;},message:()=>{},receipt:()=>{},status:()=>{}});
 clients.push(client);await client.start();expect(attempts).toBe(1);await waitFor(()=>expect(listed).toBe(true),{timeout:4000});expect(attempts).toBe(2);
});

it('restored ciphertext for a revoked recipient is discarded before any relay or direct send',async()=>{
 const {seal,publicIdentity}=await import('./crypto');const alice=await createIdentity(),bob=await createIdentity(),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const envelope=await seal(alice,await publicIdentity(bob),{team:'team',user:'alice',device:id},{team:'team',user:'bob',device:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'},JSON.stringify({kind:'message',message:{id:'pending',sender:'alice',recipient:'bob',text:'Synthetic pending',created:Date.now()}}));
 const remove=vi.fn(async()=>{}),request=vi.fn(async<T,>(value:unknown)=>{const body=value as any;if(body.action==='directory')return {devices:[{id,user_id:'alice',public_keys:await publicIdentity(alice)}]} as T;if(body.action==='poll')return {envelopes:[]} as T;return {} as T;});
 const client=new PeerClient({user:'alice',team:'team',identity:async()=>({id,keys:alice}),outbox:{load:async()=>[{envelope,messageId:'pending'}],put:async()=>{},remove},request:request as PeerRequest,message:()=>{},receipt:()=>{},status:()=>{}});
 clients.push(client);await client.start();expect(remove).toHaveBeenCalledWith([envelope.id]);expect(request.mock.calls.some(([body])=>(body as any).action==='relay')).toBe(false);
});

it('keeps the client-generated id through the encrypted history and the pending-delivery queue',async()=>{
 const {publicIdentity}=await import('./crypto');const alice=await createIdentity(),bob=await createIdentity();
 const aliceId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',bobId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const devices=[{id:aliceId,user_id:'alice',public_keys:await publicIdentity(alice)},{id:bobId,user_id:'bob',public_keys:await publicIdentity(bob)}];
 const rows:{envelope:any;messageId:string}[]=[];const persisted:ChatMessage[]=[];const echoed:ChatMessage[]=[];
 const request=(async<T,>(value:unknown)=>{const body=value as any;if(body.action==='directory')return {devices} as T;if(body.action==='poll')return {envelopes:[]} as T;if(body.action==='relay')throw Error('Offline');return {} as T;}) as PeerRequest;
 const outbox={load:async()=>[...rows],put:async(row:{envelope:any;messageId:string})=>{rows.push(row);},remove:async(ids:string[])=>{for(const id of ids){const i=rows.findIndex(r=>r.envelope.id===id);if(i>=0)rows.splice(i,1);}}};
 const client=new PeerClient({user:'alice',team:'team',identity:async()=>({id:aliceId,keys:alice}),outbox,request,persist:async m=>{persisted.push(m);},message:m=>echoed.push(m),receipt:()=>{},status:()=>{}});
 clients.push(client);await client.start();
 const draft={id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',created:Date.now()};
 const result=await client.send('Queued while the relay is down','bob',draft);
 expect(result).toEqual({id:draft.id,queued:true,partial:true});
 expect(persisted.map(m=>[m.id,m.created])).toEqual([[draft.id,draft.created]]);
 expect(rows.map(r=>r.messageId)).toEqual([draft.id]);expect(echoed.map(m=>m.id)).toEqual([draft.id]);
 await expect(client.send('bad','bob',{id:'not-a-uuid',created:Date.now()})).rejects.toThrow('Invalid message');
 client.stop();
 // After a restart the queued ciphertext reports the same message id.
 const pending=vi.fn();
 const restarted=new PeerClient({user:'alice',team:'team',identity:async()=>({id:aliceId,keys:alice}),outbox,request,pending,message:()=>{},receipt:()=>{},status:()=>{}});
 clients.push(restarted);await restarted.start();
 expect(pending).toHaveBeenCalledWith([draft.id]);
 await restarted.discard(draft.id);expect(rows).toEqual([]);
},10000);

it('reports a message whose last pending delivery can no longer be sent',async()=>{
 const {seal,publicIdentity}=await import('./crypto');const alice=await createIdentity(),bob=await createIdentity(),id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const envelope=await seal(alice,await publicIdentity(bob),{team:'team',user:'alice',device:id},{team:'team',user:'bob',device:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'},JSON.stringify({kind:'message',message:{id:'pending',sender:'alice',recipient:'bob',text:'Synthetic pending',created:Date.now()}}));
 const expired=vi.fn(),request=(async<T,>(value:unknown)=>{const body=value as any;if(body.action==='directory')return {devices:[{id,user_id:'alice',public_keys:await publicIdentity(alice)}]} as T;if(body.action==='poll')return {envelopes:[]} as T;return {} as T;}) as PeerRequest;
 const client=new PeerClient({user:'alice',team:'team',identity:async()=>({id,keys:alice}),outbox:{load:async()=>[{envelope,messageId:'pending'}],put:async()=>{},remove:async()=>{}},request,expired,message:()=>{},receipt:()=>{},status:()=>{}});
 clients.push(client);await client.start();expect(expired).toHaveBeenCalledWith('pending');
});

it('carries mesh jobs to a teammate or this account\'s other device, and their status back, end to end encrypted',async()=>{
 const devices=new Map<string,{id:string;user_id:string;public_keys:ReturnType<typeof registrationProof>;last_seen_at:string}>();
 const queue:{id:string;recipient:string;envelope:unknown}[]=[];const wire:unknown[]=[];const stale=new Set<string>();
 const api=(user:string)=>async<T,>(value:unknown):Promise<T>=>{
  const b=value as Record<string,any>;wire.push(value);
  if(b.action==='register'){devices.set(b.deviceId,{id:b.deviceId,user_id:user,public_keys:registrationProof(user,b),last_seen_at:new Date().toISOString()});return {} as T;}
  const self=devices.get(b.deviceId);if(self)self.last_seen_at=new Date(stale.has(self.id)?Date.now()-120_000:Date.now()).toISOString();
  if(b.action==='directory')return {devices:[...devices.values()]} as T;
  if(b.action==='poll')return {envelopes:queue.filter(e=>e.recipient===b.deviceId)} as T;
  if(b.action==='ack'){for(let i=queue.length-1;i>=0;i--)if(b.ids.includes(queue[i].id)&&queue[i].recipient===b.deviceId)queue.splice(i,1);return {} as T;}
  if(b.action==='relay'){const sender=devices.get(b.deviceId)!,recipient=devices.get(b.recipientDevice)!;queue.push({id:crypto.randomUUID(),recipient:recipient.id,envelope:relayEnvelope(b,user,sender,recipient)});return {} as T;}
  throw Error('Unexpected peer operation');
 };
 const jobs:{at:string;job:any;from:string}[]=[],statuses:{at:string;status:any;from:string}[]=[];
 async function endpoint(user:string,id:string){const keys=await createIdentity(),seen=new Set<string>();const client=new PeerClient({user,team:'team',identity:async()=>({id,keys}),request:api(user),outbox:{load:async()=>[],put:async()=>{},remove:async()=>{}},remember:async key=>{if(seen.has(key))return false;seen.add(key);return true;},rtc:()=>{throw Error('Direct transport unavailable');},message:()=>{},receipt:()=>{},status:()=>{},job:(job,sender)=>jobs.push({at:id,job,from:sender.user_id}),jobStatus:(status,sender)=>statuses.push({at:id,status,from:sender.user_id})});clients.push(client);await client.start();return client;}
 const laptop='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',desktop='aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbbbbbb',bobId='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const alice=await endpoint('alice',laptop);await endpoint('alice',desktop);const bob=await endpoint('bob',bobId);
 const job={id:'job-0001-teammate',title:'Fix the flaky test',brief:'Secret brief only the endpoints read',workspace:'api',created:Date.now()};
 expect((await alice.sendJob(job,'bob')).id).toBe(bobId);
 await waitFor(()=>expect(jobs).toHaveLength(1),{timeout:4000});
 expect(jobs[0]).toMatchObject({at:bobId,from:'alice',job:{id:job.id,brief:job.brief}});
 expect(JSON.stringify(wire)).not.toContain('Secret brief');
 // "Same account" reaches the other machine, never the sending one.
 expect((await alice.sendJob({...job,id:'job-0002-own-device'},'alice')).id).toBe(desktop);
 await waitFor(()=>expect(jobs).toHaveLength(2),{timeout:4000});
 expect(jobs[1]).toMatchObject({at:desktop,from:'alice'});
 await bob.sendJobStatus({jobId:job.id,state:'accepted',detail:'Approved',created:Date.now()},laptop);
 await waitFor(()=>expect(statuses).toHaveLength(1),{timeout:4000});
 expect(statuses[0]).toMatchObject({at:laptop,from:'bob',status:{state:'accepted'}});
 // A member whose devices have stopped polling is not connected.
 stale.add(bobId);await waitFor(()=>expect(Date.now()-Date.parse(devices.get(bobId)!.last_seen_at)).toBeGreaterThan(60_000),{timeout:4000});
 await expect(alice.sendJob({...job,id:'job-0003-offline'},'bob')).rejects.toThrow('Not connected');
 await expect(alice.sendJob({...job,id:'bad id!'},'bob')).rejects.toThrow('Invalid job');
},15000);
