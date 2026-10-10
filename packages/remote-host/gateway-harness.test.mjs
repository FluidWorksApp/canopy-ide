import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createGateway} from './gateway.mjs';
import {createRunner} from './runner.mjs';
import {digest} from './policy.mjs';
import {ServiceAdmin} from './service-admin.mjs';
import {ServiceHarness} from './service-harness.mjs';
import {fakeServiceAdmin} from './test-support/fake-service-admin.mjs';

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const secret='r'.repeat(64);

async function setup(handler){
 const launches=[],writes=[];
 const runner=createRunner({secret,spawnPty:(bin,args,options)=>{launches.push(options.env);return {pid:5000+launches.length,onData(){},onExit(){},kill(){},resize(){},write:data=>writes.push(String(data))};}});
 const runnerUrl=await listen(runner);
 const fake=await fakeServiceAdmin(handler??(call=>{
  if(call.path.endsWith('/terminals'))return {token:'credential-'+call.body.requestId};
  if(call.method==='PUT'&&/^\/admin\/workspaces\/[a-z-]+$/.test(call.path))return {agentSocketDir:'/run/canopy-service/ws/a'};
  if(call.path.endsWith('/query'))return {notes:[{id:'n1'}]};
  return {};
 }));
 const config={workspaces:[{id:'a',name:'A',accounts:[],memoryMiB:1024,cpus:1}],principals:[{id:'owner',tokenSha256:digest('owner'),workspaces:['a'],scope:'drive'},{id:'viewer',tokenSha256:digest('viewer'),workspaces:['a'],scope:'view'}]};
 const harness=new ServiceHarness({admin:new ServiceAdmin({socketPath:fake.socketPath,timeoutMs:500}),config,tokenFor:()=>secret,log:()=>{}});
 const gateway=createGateway({config,harness,workspaces:{open:async()=>({url:runnerUrl,token:secret,harness:true})}});
 const url=await listen(gateway);
 const request=(token,path,body,method=body===undefined?'GET':'POST')=>fetch(url+'/v1/workspaces/a'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {launches,writes,fake,config,url,request,async close(){await close(gateway);await close(runner);await fake.close();}};
}

test('agent spawn mints a credential first, passes it to the runner, binds after and revokes on stop',async()=>{
 const t=await setup();
 try{
  const response=await t.request('owner','/sessions',{requestId:'request-1',command:'claude',agent:'claude'});
  assert.equal(response.status,200);const session=await response.json();
  assert.deepEqual(session.harness,{available:true});
  assert.equal(t.launches[0].CANOPY_CTX_TOKEN,'credential-request-1');assert.equal(t.launches[0].CANOPY_CTX_SOCKET,'/run/canopy-ctx/ctx.sock');
  const paths=t.fake.calls.map(c=>`${c.method} ${c.path}`);
  assert.ok(paths.indexOf('POST /admin/workspaces/a/terminals')<paths.indexOf('POST /admin/workspaces/a/terminals/request-1/bind'));
  const bind=t.fake.calls.find(c=>c.path.endsWith('/bind'));assert.deepEqual(bind.body,{sessionId:session.id,pid:5001});
  const register=t.fake.calls.find(c=>c.method==='PUT');assert.equal(register.body.runnerToken,secret);assert.match(register.body.runnerUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await t.request('owner','/sessions',{requestId:'request-2',command:'x',harness:{token:'forged-credential-0000'}})).status,400,'a client cannot supply a credential');
  assert.equal((await t.request('owner',`/sessions/${session.id}/stop`,{})).status,200);
  assert.ok(t.fake.calls.some(c=>c.method==='DELETE'&&c.path==='/admin/workspaces/a/terminals/request-1'));
 }finally{await t.close();}
});

test('spawn still works without harness environment when the service is down, and says so',async()=>{
 const t=await setup(()=>[503,{error:'unavailable'}]);
 try{
  const response=await t.request('owner','/sessions',{requestId:'request-1',command:'claude'});
  assert.equal(response.status,200);const session=await response.json();
  assert.equal(session.harness.available,false);assert.equal(typeof session.harness.reason,'string');
  assert.equal(t.launches[0].CANOPY_CTX_TOKEN,undefined);
  const status=await (await t.request('viewer','/harness/status')).json();assert.equal(status.available,false);
 }finally{await t.close();}
});

test('harness query needs view, actions need drive and carry the authenticated actor',async()=>{
 const t=await setup();
 try{
  const query=await t.request('viewer','/harness/query',{store:'notes',action:'list',args:{}});
  assert.equal(query.status,200);assert.deepEqual(await query.json(),{notes:[{id:'n1'}]});
  assert.equal((await t.request('viewer','/harness/query',{store:'../x',action:'list'})).status,400);
  assert.equal((await t.request('viewer','/harness/actions',{kind:'answer',id:'q1',answer:'yes'})).status,403);
  assert.equal((await t.request('owner','/harness/actions',{kind:'answer',id:'q1',answer:'yes',actor:'someone-else'})).status,200);
  const action=t.fake.calls.find(c=>c.path==='/admin/workspaces/a/actions');assert.deepEqual(action.body,{kind:'answer',id:'q1',answer:'yes',actor:'owner'});
  assert.equal((await t.request('owner','/harness/actions',{kind:'delete_everything'})).status,400);
  assert.equal((await fetch(t.url+'/v1/workspaces/a/harness/query',{method:'POST',body:'{}'})).status,401);
 }finally{await t.close();}
});

test('the harness stream is ticketed, passes SSE through, and revocation cuts it',async()=>{
 let upstreamClosed=false;
 const t=await setup((call,request,response)=>{
  if(call.path.startsWith('/admin/workspaces/a/stream')){
   response.writeHead(200,{'content-type':'text/event-stream'});
   response.write('event: snapshot\ndata: {"cursor":"e1:0","stores":{}}\n\n');
   response.on('close',()=>{upstreamClosed=true;});
   return;
  }
  return {};
 });
 try{
  const ticket=(await (await t.request('viewer','/ticket',{stream:'/harness/stream'})).json()).ticket;
  assert.equal(typeof ticket,'string');
  const stream=await fetch(`${t.url}/v1/workspaces/a/harness/stream?ticket=${ticket}&cursor=e1:5`);
  assert.equal(stream.status,200);assert.equal(stream.headers.get('content-type'),'text/event-stream');
  const reader=stream.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);
  assert.match(first,/event: snapshot/);
  assert.ok(t.fake.calls.some(c=>c.path==='/admin/workspaces/a/stream?cursor=e1%3A5'));
  assert.equal((await fetch(`${t.url}/v1/workspaces/a/harness/stream?ticket=${ticket}`)).status,401,'a ticket is single use');
  t.config.principals[1].tokenSha256=digest('rotated');
  const ended=await Promise.race([(async()=>{for(;;){const {done}=await reader.read();if(done)return true;}})().catch(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),3000))]);
  assert.equal(ended,true,'a revoked viewer loses the live stream');
  for(let i=0;i<20&&!upstreamClosed;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(upstreamClosed,true,'the service subscription is released too');
  const bearer=await fetch(`${t.url}/v1/workspaces/a/harness/stream`,{headers:{authorization:'Bearer owner'}});assert.equal(bearer.status,200);await bearer.body.cancel();
  assert.equal((await fetch(`${t.url}/v1/workspaces/a/harness/stream`)).status,401);
 }finally{await t.close();}
});
