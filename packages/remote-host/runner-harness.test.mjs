import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRunner} from './runner.mjs';
import {harnessEnvironment} from './runner-harness.mjs';
const secret='s'.repeat(64);
async function start(options){const server=createRunner({secret,...options});server.listen(0,'127.0.0.1');await once(server,'listening');return {server,url:`http://127.0.0.1:${server.address().port}`};}
const call=(url,path,body)=>fetch(url+path,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(body)});
const stop=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};

test('harness credential becomes the context socket environment; anything else is refused',()=>{
 assert.deepEqual(harnessEnvironment(undefined),{});
 assert.deepEqual(harnessEnvironment({token:'t'.repeat(32)}),{CANOPY_CTX_SOCKET:'/run/canopy-ctx/ctx.sock',CANOPY_CTX_TOKEN:'t'.repeat(32)});
 for(const bad of [{token:'short'},{token:'t'.repeat(32),socket:'/tmp/x'},{token:'a b'.repeat(10)},'token',[]])assert.throws(()=>harnessEnvironment(bad),/Invalid harness/);
});

test('spawn exports CANOPY_CTX_* only with a credential, and a retry with a fresh credential keeps its receipt',async()=>{
 const launches=[];
 const {server,url}=await start({spawnPty:(bin,args,options)=>{launches.push(options.env);return {pid:700+launches.length,onData(){},onExit(){},kill(){},resize(){},write(){}};}});
 try{
  const first=await call(url,'/sessions',{requestId:'request-1',command:'claude',harness:{token:'a'.repeat(32)}});assert.equal(first.status,200);
  assert.equal(launches[0].CANOPY_CTX_SOCKET,'/run/canopy-ctx/ctx.sock');assert.equal(launches[0].CANOPY_CTX_TOKEN,'a'.repeat(32));
  const retry=await call(url,'/sessions',{requestId:'request-1',command:'claude',harness:{token:'b'.repeat(32)}});
  assert.equal(retry.status,200);assert.equal((await retry.json()).id,(await first.json()).id);assert.equal(launches.length,1);
  await call(url,'/sessions',{requestId:'request-2',command:'bash'});
  assert.equal(launches[1].CANOPY_CTX_SOCKET,undefined);assert.equal(launches[1].CANOPY_CTX_TOKEN,undefined);
  assert.equal((await call(url,'/sessions',{requestId:'request-3',command:'bash',harness:{token:'x'}})).status,400);
 }finally{await stop(server);}
});

test('service delivery is refused with 409 when the terminal child changed',async()=>{
 const writes=[];
 const {server,url}=await start({spawnPty:()=>({pid:4242,onData(){},onExit(){},kill(){},resize(){},write:data=>writes.push(data)})});
 try{
  const {id}=await (await call(url,'/sessions',{requestId:'request-1',command:'bash'})).json();
  assert.equal((await call(url,`/sessions/${id}/input`,{data:'hello',expectPid:4242})).status,200);
  const stale=await call(url,`/sessions/${id}/input`,{data:'stale',expectPid:4243});
  assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'Terminal generation changed',pid:4242});
  assert.equal((await call(url,`/sessions/${id}/input`,{data:'x',expectPid:'4242'})).status,409);
  assert.equal((await call(url,`/sessions/${id}/input`,{data:'plain'})).status,200,'clients without expectPid are unchanged');
  assert.deepEqual(writes.map(String),['hello','plain']);
 }finally{await stop(server);}
});

test('POST /browser runs the op on the workspace browser and maps its failures',async()=>{
 const ran=[];
 const browser={run:async(op,args)=>{ran.push([op,args]);if(op==='eval')throw Object.assign(Error('boom'),{status:400});if(op==='screenshot')throw Object.assign(Error('slow'),{status:504});return {url:'http://localhost:3000/',title:'App'};},close:async()=>{}};
 const {server,url}=await start({spawnPty:()=>{throw Error('unused');},browser});
 try{
  const ok=await call(url,'/browser',{op:'navigate',args:{url:'http://localhost:3000'}});
  assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{url:'http://localhost:3000/',title:'App'});
  assert.equal((await call(url,'/browser',{op:'eval',args:{code:'1'}})).status,400);
  assert.equal((await call(url,'/browser',{op:'screenshot'})).status,504);
  assert.deepEqual(ran.map(r=>r[0]),['navigate','eval','screenshot']);
  const unauthorized=await fetch(url+'/browser',{method:'POST',body:'{}'});assert.equal(unauthorized.status,401);
 }finally{await stop(server);}
 const none=await start({spawnPty:()=>{throw Error('unused');}});
 try{const response=await call(none.url,'/browser',{op:'snapshot'});assert.equal(response.status,503);assert.equal((await response.json()).reason,'not-implemented');}
 finally{await stop(none.server);}
});
