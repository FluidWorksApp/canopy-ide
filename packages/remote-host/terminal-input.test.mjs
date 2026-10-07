import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {createGateway} from './gateway.mjs';
import {createRunner} from './runner.mjs';
import {digest} from './policy.mjs';
import {InputLedger,RateLimit,SocketInput,sequencedInput} from './terminal-input.mjs';
import {startLatencyFixture} from './test-support/latency-fixture.mjs';

const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
const within=(promise,ms,message)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error(message)),ms);timer.unref();})]);
const ID='input-queue-0001';

test('sequenced input accepts only bounded, typed batches',()=>{
 assert.deepEqual(sequencedInput({id:ID,seq:1,data:'ls\r'}),{id:ID,seq:1,data:'ls\r'});
 assert.deepEqual(sequencedInput({t:'input',id:ID,seq:2,data:''},{allowType:true}),{id:ID,seq:2,data:''});
 for(const bad of [{id:ID,seq:0,data:'x'},{id:ID,seq:1.5,data:'x'},{id:'short',seq:1,data:'x'},{id:ID,seq:1,data:1},{id:ID,seq:1,data:'x',extra:true},{id:ID,seq:1,data:'é'.repeat(8193)},null,[]])
  assert.throws(()=>sequencedInput(bad),/Invalid session input/);
 assert.throws(()=>sequencedInput({t:'other',id:ID,seq:1,data:'x'},{allowType:true}),/Invalid session input/);
});

test('input ledger applies each batch once, in order, serialised across transports',async()=>{
 const ledger=new InputLedger(),applied=[];let release;const gate=new Promise(resolve=>{release=resolve;});
 const write=(text,wait)=>async()=>{if(wait)await gate;applied.push(text);};
 const first=ledger.apply('k',1,write('a',true));
 const resent=ledger.apply('k',1,write('a-again'));      // the HTTP fallback racing the socket
 const second=ledger.apply('k',2,write('b'));
 release();
 assert.deepEqual(await Promise.all([first,resent,second]),[{duplicate:false},{duplicate:true},{duplicate:false}]);
 assert.deepEqual(applied,['a','b']);
 await assert.rejects(ledger.apply('k',4,write('d')),/out of order/);
 await assert.rejects(ledger.apply('k',3,async()=>{throw Error('runner down');}),/runner down/);
 assert.deepEqual(await ledger.apply('k',3,write('c')),{duplicate:false});assert.deepEqual(applied,['a','b','c']);
 // A queue the gateway has not seen (restart or idle expiry) starts where it is.
 assert.deepEqual(await ledger.apply('other',41,write('z')),{duplicate:false});
 // Bounded: least recently used idle queues are forgotten first, expired ones always.
 let time=0;const bounded=new InputLedger({max:2,idleMs:10,now:()=>time});
 await bounded.apply('a',1,async()=>{});time=1;await bounded.apply('b',1,async()=>{});
 time=2;await bounded.apply('c',1,async()=>{});assert.deepEqual([...bounded.entries.keys()],['b','c']);
 time=20;await bounded.apply('d',1,async()=>{});assert.deepEqual([...bounded.entries.keys()],['d']);
 let hold;const busy=new InputLedger({max:1});const held=busy.apply('x',1,()=>new Promise(resolve=>{hold=resolve;}));
 await assert.rejects(busy.apply('y',1,async()=>{}),/capacity/);hold();await held;
});

test('rate limit paces instead of dropping input',()=>{
 let time=0;const limit=new RateLimit({rate:100,burst:200,now:()=>time});
 assert.equal(limit.delay(200),0);assert.equal(limit.delay(50),500);
 time=2000;assert.equal(limit.delay(150),0);
});

test('socket input bounds frames, backlog and queue identities',async()=>{
 const sent=[],closes=[];let release;const gate=new Promise(resolve=>{release=resolve;});
 const make=(apply=async()=>{await gate;})=>new SocketInput({key:id=>id,apply,allowed:async()=>null,send:m=>sent.push(m),close:(code,reason)=>closes.push([code,reason]),maxPendingBytes:10});
 let input=make();
 input.receive(Buffer.from('not json'),false);assert.deepEqual(closes.at(-1),[1008,'Invalid terminal input']);
 input=make();input.receive(Buffer.from('{}'),true);assert.equal(closes.at(-1)[0],1008);
 input=make();input.receive(Buffer.from(JSON.stringify({t:'input',id:ID,seq:1,data:'x'.repeat(16385)})),false);assert.equal(closes.at(-1)[0],1008);
 input=make();
 input.receive(Buffer.from(JSON.stringify({t:'input',id:ID,seq:1,data:'123456'})),false);
 input.receive(Buffer.from(JSON.stringify({t:'input',id:ID,seq:2,data:'7890a'})),false);
 assert.deepEqual(closes.at(-1),[1013,'Terminal input backlog']);release();await input.tail;
 assert.deepEqual(sent,[{t:'input-ack',id:ID,seq:1}]);
 input=make(async()=>{});
 for(let i=0;i<64;i++)input.receive(Buffer.from(JSON.stringify({t:'input',id:`queue-${String(i).padStart(4,'0')}`,seq:1,data:''})),false);
 const before=closes.length;input.receive(Buffer.from(JSON.stringify({t:'input',id:'queue-overflow',seq:1,data:''})),false);
 assert.deepEqual(closes.slice(before),[[1008,'Too many terminal input queues']]);
});

async function ownerGateway({principals}={}){
 const writes=[];let echo;const secret='s'.repeat(64);
 const runner=createRunner({secret,spawnPty:()=>({onData:handler=>{echo=handler;},onExit(){},resize(){},kill(){},write:data=>{writes.push(data);echo?.(data);}})});
 const runnerUrl=await listen(runner);
 const config={workspaces:[{id:'a',accounts:[],memoryMiB:1024,cpus:1}],principals:principals??[{id:'owner',tokenSha256:digest('owner'),workspaces:['a'],scope:'drive'},{id:'viewer',tokenSha256:digest('viewer'),workspaces:['a'],scope:'view'}]};
 const gateway=createGateway({config,workspaces:{open:async()=>({url:runnerUrl,token:secret})}});const url=await listen(gateway);
 const call=(token,route,input)=>fetch(`${url}/v1/workspaces/a${route}`,{method:input?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:input?JSON.stringify(input):undefined});
 const session=(await (await call('owner','/sessions',{command:'bash',requestId:'input-test-1'})).json()).id;
 const stream=async token=>{
  const {ticket}=await (await call(token,'/ticket',{stream:`/sessions/${session}/stream`})).json();
  const socket=new WebSocket(`${url.replace('http','ws')}/v1/stream?ticket=${ticket}`);const messages=[];
  socket.on('message',raw=>messages.push(JSON.parse(raw)));await once(socket,'open');
  const next=async predicate=>{for(let i=0;i<200;i++){const found=messages.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,10));}throw Error('message not received');};
  return {socket,messages,next,send:value=>socket.send(JSON.stringify(value))};
 };
 return {config,writes,call,session,stream,async close(){await close(gateway);await close(runner);}};
}

test('owner stream announces socket input and writes ordered batches to the PTY with acks',async()=>{
 const host=await ownerGateway();let client;
 try{
  client=await host.stream('owner');
  assert.deepEqual(client.messages[0],{t:'hello',input:1});
  for(let seq=1;seq<=50;seq++)client.send({t:'input',id:ID,seq,data:String(seq%10)});
  await client.next(m=>m.t==='input-ack'&&m.seq===50);
  assert.deepEqual(client.messages.filter(m=>m.t==='input-ack').map(m=>m.seq),Array.from({length:50},(_,i)=>i+1));
  assert.equal(host.writes.join(''),Array.from({length:50},(_,i)=>String((i+1)%10)).join(''));
  // The HTTP fallback shares the ledger: resent batches are acknowledged, not rewritten.
  const resent=await host.call('owner',`/sessions/${host.session}/input`,{id:ID,seq:50,data:'0'});
  assert.deepEqual(await resent.json(),{ok:true,seq:50,duplicate:true});
  const fresh=await host.call('owner',`/sessions/${host.session}/input`,{id:ID,seq:51,data:'!'});
  assert.deepEqual(await fresh.json(),{ok:true,seq:51,duplicate:false});
  assert.equal(host.writes.at(-1),'!');assert.equal(host.writes.length,51);
  // A reconnecting client resends unacknowledged batches on its new socket.
  client.socket.close();client=await host.stream('owner');
  client.send({t:'input',id:ID,seq:51,data:'!'});client.send({t:'input',id:ID,seq:52,data:'?'});
  await client.next(m=>m.t==='input-ack'&&m.seq===52);assert.equal(host.writes.slice(-2).join(''),'!?');
  client.send({t:'input',id:ID,seq:60,data:'gap'});
  assert.deepEqual(await client.next(m=>m.t==='input-error'),{t:'input-error',id:ID,seq:60,error:'Terminal input out of order'});
  // Legacy HTTP input (no id/seq) still works for current clients.
  assert.equal((await host.call('owner',`/sessions/${host.session}/input`,{data:'legacy'})).status,200);assert.equal(host.writes.at(-1),'legacy');
 }finally{client?.socket.terminate();await host.close();}
});

test('view-only principals get no socket input and are disconnected if they try',async()=>{
 const host=await ownerGateway();let client;
 try{
  client=await host.stream('viewer');
  assert.deepEqual(client.messages[0],{t:'hello',input:0});
  const closed=once(client.socket,'close');client.send({t:'input',id:ID,seq:1,data:'rm -rf /\r'});
  const [code]=await within(closed,2000,'viewer socket stayed open');assert.equal(code,1008);
  assert.deepEqual(host.writes,[]);
  assert.equal((await host.call('viewer',`/sessions/${host.session}/input`,{id:ID,seq:1,data:'x'})).status,403);
  assert.deepEqual(host.writes,[]);
 }finally{client?.socket.terminate();await host.close();}
});

test('socket input stops when the drive grant is withdrawn mid-stream',async()=>{
 const host=await ownerGateway();let client;
 try{
  client=await host.stream('owner');
  client.send({t:'input',id:ID,seq:1,data:'a'});await client.next(m=>m.t==='input-ack');
  host.config.principals[0].scope='view';await new Promise(r=>setTimeout(r,1300));
  client.send({t:'input',id:ID,seq:2,data:'b'});
  assert.equal((await client.next(m=>m.t==='input-error')).error,'Forbidden');
  assert.deepEqual(host.writes,['a']);
 }finally{client?.socket.terminate();await host.close();}
});

test('shared sessions accept socket input only from live interact grants',async()=>{
 const id='ws-11111111-1111-4111-8111-111111111111',key='k'.repeat(48);
 const workspace={id,cgroupParent:'canopy-test.slice',accounts:['owner'],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',writable:true}]};
 const token=claims=>{const payload=Buffer.from(JSON.stringify({workspaceId:id,expires:Math.floor(Date.now()/1000)+120,...claims})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const owner=token({}),member=token({version:2,memberId:'alice',accessVersion:1,scope:'drive'}),inputs=[];
 const runner=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;res.setHeader('content-type','application/json');
  if(req.url==='/sessions'&&req.method==='POST')return res.end('{"id":1}');
  if(req.url==='/sessions/1/input')inputs.push(JSON.parse(text).data);res.end('{"ok":true}');});const runnerUrl=await listen(runner);
 const wss=new WebSocketServer({server:runner});
 let interact=true;const selected={allRead:false,allWrite:false,selected:[{id:'app',writable:true}]},none={allRead:false,allWrite:false,selected:[]};
 const gateway=createGateway({config:{workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}},workspaces:{open:async()=>({url:runnerUrl,token:'synthetic'}),suspendMember:async()=>{}},authorizeMember:async()=>({projectAccess:selected,sessionAccess:{view:selected,interact:interact?selected:none}})});const base=await listen(gateway);
 const call=(auth,route,input)=>fetch(base+'/v1/workspaces/'+id+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 const open=async()=>{const ticket=(await (await call(member,'/ticket',{stream:`/shared-sessions/${p.id}/stream`})).json()).ticket;const socket=new WebSocket(base.replace('http:','ws:')+'/v1/stream?ticket='+ticket);const messages=[];socket.on('message',raw=>messages.push(JSON.parse(raw)));await once(socket,'open');return {socket,messages};};
 const wait=async(messages,predicate)=>{for(let i=0;i<300;i++){const found=messages.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,10));}throw Error('message not received');};
 let p,a,b;
 try{
  p=(await (await call(owner,'/shared-sessions',{action:'create',projectId:'app',title:'Pair'})).json()).sessions[0];
  a=await open();assert.deepEqual(await wait(a.messages,m=>m.t==='hello'),{t:'hello',input:1});
  a.socket.send(JSON.stringify({t:'input',id:ID,seq:1,data:'echo pair\n'}));await wait(a.messages,m=>m.t==='input-ack');
  assert.deepEqual(await (await call(member,`/shared-sessions/${p.id}/input`,{id:ID,seq:1,data:'echo pair\n'})).json(),{ok:true,seq:1,duplicate:true});
  assert.deepEqual(inputs,['echo pair\n']);
  interact=false;await new Promise(r=>setTimeout(r,1300));
  a.socket.send(JSON.stringify({t:'input',id:ID,seq:2,data:'forbidden'}));assert.equal((await wait(a.messages,m=>m.t==='input-error')).error,'Forbidden');
  b=await open();assert.deepEqual(await wait(b.messages,m=>m.t==='hello'),{t:'hello',input:0});
  assert.equal((await call(member,`/shared-sessions/${p.id}/input`,{id:ID,seq:2,data:'forbidden'})).status,403);
  assert.deepEqual(inputs,['echo pair\n']);
 }finally{a?.socket.terminate();b?.socket.terminate();for(const socket of wss.clients)socket.terminate();wss.close();await close(gateway);await close(runner);}
});

test('per-keystroke echo over the stream socket costs about one round trip',async()=>{
 // A large simulated RTT and admission cost keep this deterministic on busy CI
 // runners: scheduler noise is small next to 200 ms, while the regressions it
 // guards against (an HTTP round trip per key, or paying the 1.5 s admission
 // refresh on a keystroke) would still blow the bounds by a wide margin.
 const rtt=200,fixture=await startLatencyFixture({rttMs:rtt,openCostMs:1500});
 const call=(route,input)=>fetch(`${fixture.endpoint}/v1/workspaces/${fixture.workspaceId}${route}`,{method:'POST',headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json'},body:JSON.stringify(input)});
 let socket;
 try{
  const session=(await (await call('/sessions',{command:'bash',requestId:'latency-test-1'})).json()).id;
  const {ticket}=await (await call('/ticket',{stream:`/sessions/${session}/stream`})).json();
  socket=new WebSocket(`${fixture.endpoint.replace('http','ws')}/v1/stream?ticket=${ticket}`);
  let text='',wake;socket.on('message',raw=>{const m=JSON.parse(raw);if(m.t==='data')text+=Buffer.from(m.b64,'base64').toString();wake?.();});
  await once(socket,'open');
  const samples=[];
  for(let i=0;i<15;i++){
   const key=`k${i};`;text='';const start=performance.now();
   const echoed=new Promise(resolve=>{wake=()=>{if(text.includes(key))resolve();};});
   socket.send(JSON.stringify({t:'input',id:ID,seq:i+1,data:key}));await echoed;samples.push(performance.now()-start);
   await new Promise(r=>setTimeout(r,i===7?2100:20)); // one gap crosses the runtime-admission cache expiry
  }
  samples.sort((x,y)=>x-y);
  console.info(`[latency] socket keystroke echo at ${rtt} ms RTT: median ${samples[7].toFixed(1)} ms, max ${samples[14].toFixed(1)} ms`);
  assert.ok(samples[7]<rtt*1.5,`median ${samples[7]} ms`);assert.ok(samples[14]<rtt*2,`max ${samples[14]} ms`);
 }finally{socket?.terminate();await fixture.close();}
});
