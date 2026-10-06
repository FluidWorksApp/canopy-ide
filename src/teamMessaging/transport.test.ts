// @vitest-environment jsdom
import {createServer} from 'node:http';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {PeerClient,type ChatMessage,type Device} from './client';
import {createIdentity,type Envelope} from './crypto';
import type {MessageOutbox,PendingEnvelope} from './store';
import {registrationProof,relayEnvelope} from '../../packages/control-plane/lib/peer-messaging.mjs';
beforeAll(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'onLine',{configurable:true,writable:true,value:true});});
const clients:PeerClient[]=[];afterEach(()=>{clients.splice(0).forEach(c=>c.stop());Object.defineProperty(navigator,'onLine',{configurable:true,writable:true,value:true});});
const eventually=async(check:()=>boolean)=>{const until=Date.now()+7000;while(!check()){if(Date.now()>until)throw Error('Delivery timed out');await new Promise(resolve=>setTimeout(resolve,30));}};
it('real HTTP relay delivers only ciphertext across restart and retries failed local history without losing receipts',async()=>{
 const devices=new Map<string,Device>(),queues=new Map<string,{id:string;envelope:Envelope}[]>(),revoked=new Set<string>(),wire:string[]=[];
 const server=createServer(async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk;wire.push(raw);
   const body=JSON.parse(raw),user=String(req.headers['x-test-user']);if(revoked.has(user))throw Error('Team access revoked');
   let result:unknown={};
   if(body.action==='register')devices.set(body.deviceId,{id:body.deviceId,user_id:user,public_keys:registrationProof(user,body)});
   else if(body.action==='directory')result={devices:[...devices.values()].filter(d=>!revoked.has(d.user_id))};
   else if(body.action==='poll')result={envelopes:queues.get(body.deviceId)??[]};
   else if(body.action==='ack')queues.set(body.deviceId,(queues.get(body.deviceId)??[]).filter(row=>!body.ids.includes(row.id)));
   else if(body.action==='relay'){
    const from=devices.get(body.deviceId)!,to=devices.get(body.recipientDevice)!;if(!to||revoked.has(to.user_id))throw Error('Recipient revoked');
    const envelope=relayEnvelope(body,user,from,to) as Envelope;const queue=queues.get(to.id)??[];
    if(!queue.some(row=>row.envelope.id===envelope.id))queue.push({id:crypto.randomUUID(),envelope});queues.set(to.id,queue);
   }else throw Error('Unsupported request');
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw Error('No loopback address');
 const url=`http://127.0.0.1:${address.port}`;
 let offline=false,failHistory=true;const received:ChatMessage[]=[],receipts:string[]=[];
 const identities={alice:{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',keys:await createIdentity()},bob:{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',keys:await createIdentity()}};
 const pending=new Map<string,PendingEnvelope>(),seen={alice:new Set<string>(),bob:new Set<string>()},history=new Map<string,ChatMessage>();
 const outbox:MessageOutbox={load:async()=>[...pending.values()],put:async row=>{pending.set(row.envelope.id,row);},remove:async ids=>{ids.forEach(id=>pending.delete(id));}};
 async function endpoint(user:'alice'|'bob'){
  const client=new PeerClient({team:'team',user,identity:async()=>identities[user],outbox:user==='alice'?outbox:{load:async()=>[],put:async()=>{},remove:async()=>{}},
   request:async<T,>(body:unknown)=>{if(offline&&user==='alice')throw Error('Network offline');const response=await fetch(url,{method:'POST',headers:{'x-test-user':user},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result as T;},
   remember:async id=>{if(seen[user].has(id))return false;seen[user].add(id);return true;},
   persist:async message=>{if(user==='bob'&&failHistory){failHistory=false;throw Error('History unavailable');}history.set(user+message.id,message);},
   rtc:()=>{throw Error('No direct RTC in this Node fixture');},message:m=>{if(user==='bob')received.push(m);},receipt:id=>{if(user==='alice')receipts.push(id);},status:()=>{}});
  clients.push(client);await client.start();return client;
 }
 try{
  await endpoint('bob');let alice=await endpoint('alice');
  offline=true;Object.defineProperty(navigator,'onLine',{configurable:true,writable:true,value:false});
  const result=await alice.send('Synthetic durable private message','bob');expect(result.queued).toBe(true);expect(pending.size).toBe(1);
  expect(JSON.stringify([...pending.values()])).not.toContain('Synthetic durable private message');alice.stop();
  offline=false;Object.defineProperty(navigator,'onLine',{configurable:true,writable:true,value:true});alice=await endpoint('alice');
  await eventually(()=>received.length===1);expect(received[0].text).toBe('Synthetic durable private message');
  await eventually(()=>receipts.includes(result.id));expect(pending.size).toBe(0);expect(history.has('bob'+result.id)).toBe(true);
  expect(wire.join('')).not.toContain('Synthetic durable private message');
  revoked.add('alice');await expect(alice.send('Revoked message','bob')).rejects.toThrow('revoked');expect(pending.size).toBe(0);
 }finally{clients.forEach(c=>c.stop());server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},15000);
