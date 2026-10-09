// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {waitFor} from '@testing-library/react';
import {PeerClient,type Device} from './client';
import {createIdentity,publicIdentity,seal,open,type Envelope,type Identity} from './crypto';
import type {JobStatus} from './jobSchema';
beforeAll(()=>vi.stubGlobal('crypto',webcrypto));
const clients:PeerClient[]=[];afterEach(()=>{clients.splice(0).forEach(c=>c.stop());});
const WS='ws-22222222-2222-4222-8222-222222222222',aliceId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',hostId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function setup(){
 const alice=await createIdentity(),host=await createIdentity();
 const hostDevice:Device={id:hostId,user_id:'owner',public_keys:await publicIdentity(host),kind:'host',workspaceIds:[WS],last_seen_at:new Date().toISOString()};
 const relayed:{recipientDevice:string;envelope:Envelope}[]=[],inbox:{id:string;envelope:Envelope}[]=[];
 const request=vi.fn(async<T,>(value:unknown)=>{const b=value as Record<string,any>;
  if(b.action==='directory')return {devices:[{id:aliceId,user_id:'alice',public_keys:await publicIdentity(alice),kind:'user',workspaceIds:[]}],hosts:[hostDevice]} as T;
  if(b.action==='poll')return {envelopes:inbox.splice(0)} as T;
  if(b.action==='relay'){relayed.push(b as never);return {queued:true} as T;}
  return {} as T;});
 const statuses:{status:JobStatus;workspace?:string}[]=[],chats:unknown[]=[];
 const client=new PeerClient({user:'alice',team:'team',identity:async()=>({id:aliceId,keys:alice}),outbox:{load:async()=>[],put:async()=>{},remove:async()=>{}},request,remember:async()=>true,rtc:()=>{throw Error('no direct');},message:m=>chats.push(m),receipt:()=>{},status:()=>{},jobStatus:(status,_s,workspace)=>statuses.push({status,workspace})});
 clients.push(client);await client.start();
 const from={team:'team',user:'owner',device:hostId},to={team:'team',user:'alice',device:aliceId};
 const reply=async(payload:unknown,v2:{kind:'job-status'|'mesh'|'chat'|'job';workspace?:string}|null)=>{const e=await seal(host,await publicIdentity(alice),from,to,JSON.stringify(payload),Date.now(),v2?{version:2,...v2}:undefined);inbox.push({id:crypto.randomUUID(),envelope:e});};
 return {alice,host,client,relayed,statuses,chats,reply};
}
it('sends workspace jobs as v2 to the host and accepts its job status only for that workspace',async()=>{
 const {alice,host,client,relayed,statuses,chats,reply}=await setup();
 expect(client.directoryDevices().map(d=>d.id)).toEqual([aliceId]);
 const job={id:'job-12345678',title:'t',brief:'do it',workspace:WS,created:Date.now()};
 expect((await client.sendWorkspaceJob(job,WS)).id).toBe(hostId);
 const sent=relayed[0];expect(sent.recipientDevice).toBe(hostId);
 expect(sent.envelope).toMatchObject({version:2,kind:'job',to:{workspace:WS,device:hostId}});
 expect(sent.envelope.expires-sent.envelope.created).toBe(604800000);
 const opened=await open(host as Identity,await publicIdentity(alice),{team:'team',user:'alice',device:aliceId},{team:'team',user:'owner',device:hostId},sent.envelope,async()=>true);
 expect(JSON.parse(opened)).toEqual({kind:'job',job});
 await expect(client.sendWorkspaceJob({...job,workspace:'ws-other'},'ws-other')).rejects.toThrow();
 const status={jobId:job.id,state:'refused',detail:'Teammate delivery is off',created:Date.now()};
 await reply({kind:'job-status',status},{kind:'job-status',workspace:'ws-33333333-3333-4333-8333-333333333333'});
 await reply({kind:'job-status',status},null);
 await reply({kind:'job-status',status},{kind:'mesh',workspace:WS});
 await reply({kind:'message',message:{id:'m',sender:'owner',recipient:null,text:'hi',created:Date.now()}},{kind:'chat'});
 await reply({kind:'job-status',status},{kind:'job-status',workspace:WS});
 await waitFor(()=>expect(statuses).toHaveLength(1),{timeout:5000});
 expect(statuses[0]).toEqual({status,workspace:WS});expect(chats).toHaveLength(0);
},10000);
