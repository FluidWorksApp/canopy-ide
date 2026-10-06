import test from 'node:test';import assert from 'node:assert/strict';import {CredentialBroker} from './credential-broker.mjs';
const principal={workspaceId:'workspace',memberId:'alice'},request={projectId:'app',operation:'agents:claude',body:Buffer.from('{}')};
function make(options={}){let controller,signal;const broker=new CredentialBroker({authorize:async(p,c)=>({...c,accountId:'shared'}),loadCredential:async()=>({workspaceId:'workspace',accountId:'shared',provider:'anthropic',token:'synthetic'}),fetchImpl:async(_url,config)=>{signal=config.signal;return new Response(new ReadableStream({start(c){controller=c;},pull(){return new Promise(()=>{});}}));},...options});return {broker,get controller(){return controller;},get signal(){return signal;}};}
test('progressing provider stream survives former two-minute total cutoff without relaxing idle/revocation limits',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});const runtime=make(),response=await runtime.broker.execute(principal,request),reader=response.body.getReader();
 for(let n=0;n<5;n++){t.mock.timers.tick(60000);runtime.controller.enqueue(Buffer.from('thinking-progress-'+n));assert.equal(Buffer.from((await reader.read()).value).toString(),'thinking-progress-'+n);assert.equal(runtime.signal.aborted,false);}
 assert.ok(Date.now()>1000000+120000);runtime.controller.close();assert.equal((await reader.read()).done,true);assert.equal(runtime.signal.aborted,false);
});
test('provider silence hits idle bound even if body ignores cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000});const runtime=make({idleTimeoutMs:30,maxDurationMs:200}),response=await runtime.broker.execute(principal,request),reader=response.body.getReader();const ended=assert.rejects(reader.read(),/Shared provider stream failed/);t.mock.timers.tick(31);await ended;assert.equal(runtime.signal.aborted,true);
});
test('continuous progress cannot evade bounded total lifetime and cancellation still aborts immediately',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000});const runtime=make({idleTimeoutMs:100,maxDurationMs:200}),response=await runtime.broker.execute(principal,request),reader=response.body.getReader();
 for(let n=0;n<3;n++){t.mock.timers.tick(50);runtime.controller.enqueue(Buffer.from('progress'));await reader.read();assert.equal(runtime.signal.aborted,false);}
 const ended=assert.rejects(reader.read(),/Shared provider stream failed/);t.mock.timers.tick(51);await ended;assert.equal(runtime.signal.aborted,true);
 const next=make({idleTimeoutMs:100,maxDurationMs:200}),stream=await next.broker.execute(principal,request);await stream.body.cancel();assert.equal(next.signal.aborted,true);
});
test('idle bound also terminates provider-header wait that ignores AbortSignal',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000});const runtime=make({idleTimeoutMs:30,maxDurationMs:200,fetchImpl:async()=>new Promise(()=>{})});const pending=assert.rejects(runtime.broker.execute(principal,request),/Shared provider request failed/);await Promise.resolve();await Promise.resolve();await Promise.resolve();t.mock.timers.tick(31);await pending;
});
test('an abandoned consumer cannot retain queued provider output beyond idle expiry',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000});const runtime=make({idleTimeoutMs:30,maxDurationMs:200}),response=await runtime.broker.execute(principal,request);
 runtime.controller.enqueue(Buffer.from('queued'));await Promise.resolve();await Promise.resolve();t.mock.timers.tick(31);assert.equal(runtime.signal.aborted,true);await assert.rejects(response.body.getReader().read(),/Shared provider stream failed/);
});
