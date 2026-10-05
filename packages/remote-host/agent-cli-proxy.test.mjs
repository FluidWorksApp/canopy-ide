import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {createAgentCliProxy} from './agent-cli-proxy.mjs';
test('CLI-compatible generation forwards only its fixed operation and preserves streaming',async()=>{
 const secret='synthetic-local-secret'.repeat(2);let calls=0;const server=createAgentCliProxy({agent:'claude',secret,execute:async(operation,payload)=>{calls++;assert.equal(operation,'agents:claude');assert.equal(Buffer.from(payload).toString(),'{"messages":[]}');return new Response('data: hello\n\n',{headers:{'content-type':'text/event-stream','x-api-key':'must-not-return'}});}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(base+'/v1/messages',{method:'POST',body:'{}'})).status,401);assert.equal((await fetch(base+'/admin',{method:'POST',headers:{'x-api-key':secret},body:'{}'})).status,404);const response=await fetch(base+'/v1/messages',{method:'POST',headers:{'x-api-key':secret},body:'{"messages":[]}'});assert.equal(await response.text(),'data: hello\n\n');assert.equal(response.headers.get('x-api-key'),null);assert.equal(calls,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('model discovery and token counting accept only fixed paths without caller query/header routing',async()=>{
 for(const [agent,paths]of [['claude',[['GET','/v1/models','agents:claude:models'],['POST','/v1/messages/count_tokens','agents:claude:count-tokens']]],['codex',[['GET','/v1/models','agents:codex:models']]]]){
  const calls=[],secret='s'.repeat(40),server=createAgentCliProxy({agent,secret,execute:async(op,payload)=>{calls.push(op);return Response.json({data:[]});}});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  try{for(const [method,path,operation]of paths){assert.equal((await fetch(base+path,{method,headers:{authorization:'Bearer '+secret},...(method==='POST'?{body:'{}'}:{})})).status,200);assert.equal(calls.at(-1),operation);}assert.equal((await fetch(base+'/v1/models?url=http://metadata',{headers:{authorization:'Bearer '+secret}})).status,404);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 }
});
