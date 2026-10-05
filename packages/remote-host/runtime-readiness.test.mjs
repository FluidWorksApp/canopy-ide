import test from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import {once} from 'node:events';
import {runtimeReady} from './runtime-readiness.mjs';
test('readiness requires bounded valid terminal-service output and forbids redirects',async()=>{
 const runtime={url:'http://runtime.invalid',token:'runtime-only'};
 const fetchImpl=async(url,options)=>{assert.equal(url,'http://runtime.invalid/sessions');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer runtime-only');return Response.json([{id:1,exitCode:null}]);};
 assert.equal(await runtimeReady(runtime,{fetchImpl}),true);
 for(const output of [{connected:true},[{id:'1',exitCode:null}],[{id:1,exitCode:'running'}],Array(257).fill({id:1,exitCode:null})])assert.equal(await runtimeReady(runtime,{fetchImpl:async()=>Response.json(output)}),false);
 assert.equal(await runtimeReady(runtime,{fetchImpl:async()=>new Response('x'.repeat(65537))}),false);
 assert.equal(await runtimeReady(runtime,{fetchImpl:async()=>new Response('[]',{status:401})}),false);
 assert.equal(await runtimeReady(runtime,{fetchImpl:async()=>{throw Error('Connection refused');}}),false);
});
test('a running HTTP service that hangs is not ready and observation is bounded',async()=>{
 const server=http.createServer(()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const before=Date.now();assert.equal(await runtimeReady({url:`http://127.0.0.1:${server.address().port}`,token:'runtime-only'},{timeoutMs:50}),false);assert.ok(Date.now()-before<1000);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('image readiness waits for a cold service using the production helper',async()=>{
 const {waitForRuntimeReady}=await import('./runtime-readiness.mjs');let attempts=0;
 const server=http.createServer((req,res)=>{attempts++;res.writeHead(attempts<3?503:200,{'content-type':'application/json'});res.end(attempts<3?'{}':'[]');});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{assert.equal(await waitForRuntimeReady({url:`http://127.0.0.1:${server.address().port}`,token:'runtime-only'},{timeoutMs:1000,intervalMs:25}),true);assert.equal(attempts,3);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('image readiness cannot wait indefinitely for a hung or invalid runtime',async()=>{
 const {waitForRuntimeReady}=await import('./runtime-readiness.mjs');
 const server=http.createServer(()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const start=performance.now();assert.equal(await waitForRuntimeReady({url:`http://127.0.0.1:${server.address().port}`,token:'runtime-only'},{timeoutMs:80,intervalMs:10}),false);assert.ok(performance.now()-start<1000);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await assert.rejects(waitForRuntimeReady({}, {timeoutMs:Infinity}),/Invalid readiness deadline/);
});
