// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {HarnessStream,sseEvents,type HarnessTransport} from './harnessStream';
import {remoteItems,resetRemoteHarnessForTest,withRemote} from './harnessStores';
import {attentionItems,clearAttentionHistory} from '../attention';
import * as notes from '../notes';
vi.mock('../ipc',async original=>({...await original<object>(),notesList:vi.fn(async()=>[{id:'local-1',title:'Local'}])}));
const WS='ws-22222222-2222-4222-8222-222222222222';
const frame=(event:string,data:unknown)=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function body(chunks:string[],hold=false){
 const encoder=new TextEncoder();
 return new ReadableStream<Uint8Array>({start(c){for(const chunk of chunks)c.enqueue(encoder.encode(chunk));if(!hold)c.close();}});
}
function transport(responses:(()=>Response)[],query:(args:{store:string;action:string;args:unknown})=>unknown=()=>[]){
 const routes:string[]=[],queries:unknown[]=[];
 const t:HarnessTransport={open:vi.fn(async(_id:string,route:string)=>{routes.push(route);const next=responses.shift();if(!next)return new Response(body([],true));return next();}),workspace:vi.fn(async(_id:string,_route:string,args?:unknown)=>{queries.push(args);return query(args as never);}) as HarnessTransport['workspace']};
 return {t,routes,queries};
}
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));expect(check()).toBe(true);};
beforeEach(()=>{resetRemoteHarnessForTest();clearAttentionHistory();});
const streams:HarnessStream[]=[];afterEach(()=>{streams.splice(0).forEach(s=>s.stop());});

it('parses SSE frames split across chunks, comments and CRLF',async()=>{
 const out=[];for await(const e of sseEvents(body([': hi\r\nevent: change\r\nda','ta: {"a":1}\r\n\r\ndata: x\n','\n'])))out.push(e);
 expect(out).toEqual([{event:'change',data:'{"a":1}'},{event:'message',data:'x'}]);
});

it('applies a snapshot, refetches changed stores, resumes from its cursor and resnapshots on request',async()=>{
 const snapshot={cursor:'e1:5',stores:{notes:[{id:'n1',title:'Remote note'}],research:[],mesh:[{id:'m1',text:'hi'}],attention:[{id:'q1',kind:'question',title:'Deploy?'}]}};
 const {t,routes,queries}=transport([
  ()=>new Response(body([frame('snapshot',snapshot),frame('change',{cursor:'e1:6',store:'notes',scope:`ws:${WS}`,id:'n2'})])),
  ()=>new Response(body([frame('resnapshot',{})])),
  ()=>new Response(body([frame('snapshot',{...snapshot,cursor:'e2:1',stores:{...snapshot.stores,attention:[{id:'q1',kind:'question',title:'Deploy?',resolution:{answer:'yes',actor:'u',atMs:1}}]}})])),
 ],q=>q.store==='notes'?[{id:'n1',title:'Remote note'},{id:'n2',title:'Second'}]:[]);
 const stream=new HarnessStream(t,WS,{sleep:async()=>{}}).start();streams.push(stream);
 await until(()=>routes.length>=4);
 expect(routes.slice(0,4)).toEqual(['/harness/stream','/harness/stream?cursor=e1%3A6','/harness/stream','/harness/stream?cursor=e2%3A1']);
 expect(queries[0]).toEqual({store:'notes',action:'list',args:{scope:`ws:${WS}`}});
 expect(remoteItems('notes').map(r=>r.item.id)).toEqual(['n1']);
 expect(remoteItems('mesh')[0].key).toBe(JSON.stringify([WS,WS,'m1']));
 const question=attentionItems().find(a=>a.dedupeKey===`remote:${WS}:${WS}:q1`);
 expect(question).toMatchObject({kind:'question',title:'Deploy?',resolution:'answered'});
});

it('unions remote rows into the notes cache without replacing local ones',async()=>{
 const {t}=transport([()=>new Response(body([frame('snapshot',{cursor:'e1:1',stores:{notes:[{id:'local-1',title:'Shadow'},{id:'n9',title:'Remote'}]}})]))]);
 streams.push(new HarnessStream(t,WS,{service:'svc',sleep:async()=>{}}).start());
 await until(()=>remoteItems('notes').length===2);
 await notes.refresh(`ws:${WS}`);
 expect(notes.cached(`ws:${WS}`).map(n=>[n.id,n.title])).toEqual([['local-1','Local'],['n9','Remote']]);
 expect(withRemote('notes','other',[])).toEqual([]);
});

it('stops quietly against a gateway without the route and forgets state on stop',async()=>{
 const {t,routes}=transport([()=>new Response('{}',{status:404})]);
 const stream=new HarnessStream(t,WS,{sleep:async()=>{}}).start();
 await until(()=>routes.length===1);await new Promise(r=>setTimeout(r,20));
 expect(routes).toHaveLength(1);
 stream.stop();expect(remoteItems('notes')).toEqual([]);
});

it('sends user actions and queries through the gateway routes',async()=>{
 const {t}=transport([]);const stream=new HarnessStream(t,WS);
 await stream.action('answer',{id:'q1',answer:'yes'});await stream.query('research','list');
 expect(t.workspace).toHaveBeenCalledWith(WS,'/harness/actions',{kind:'answer',id:'q1',answer:'yes'});
 expect(t.workspace).toHaveBeenCalledWith(WS,'/harness/query',{store:'research',action:'list',args:{}});
});
