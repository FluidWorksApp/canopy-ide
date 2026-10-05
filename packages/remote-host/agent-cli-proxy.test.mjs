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
test('exact Anthropic SDK beta query reaches generation/counting while arbitrary query routing is denied',async()=>{
 const secret='s'.repeat(43),calls=[],server=createAgentCliProxy({agent:'claude',secret,execute:async(operation)=>{calls.push(operation);return Response.json({ok:true});}});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{
  const call=path=>fetch(base+path,{method:'POST',headers:{'x-api-key':secret},body:'{}'});
  assert.equal((await call('/v1/messages?beta=true')).status,200);assert.equal((await call('/v1/messages/count_tokens?beta=true')).status,200);
  for(const path of ['/v1/messages?beta=false','/v1/messages?beta=true&url=http://metadata','/v1/models?beta=false'])assert.equal((await call(path)).status,404);
  assert.equal((await fetch(base+'/v1/models?beta=true',{headers:{'x-api-key':secret}})).status,200);assert.deepEqual(calls,['agents:claude','agents:claude:count-tokens','agents:claude:models']);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('Codex model client_version accepts only strict semver on fixed GET routes',async()=>{
 const secret='s'.repeat(43),calls=[],server=createAgentCliProxy({agent:'codex',secret,execute:async(op,payload,options)=>{calls.push([op,options.clientVersion]);return Response.json({models:[]});}});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{for(const path of ['/models?client_version=0.160.0','/v1/models?client_version=0.160.0'])assert.equal((await fetch(base+path,{headers:{authorization:'Bearer '+secret}})).status,200);
 for(const path of ['/v1/models?client_version=http://metadata','/v1/models?client_version=0.160.0&url=http://metadata','/v1/models?client_version=01.160.0','/v1/models?client_version=%30.160.0','/v1/responses?client_version=0.160.0'])assert.equal((await fetch(base+path,{headers:{authorization:'Bearer '+secret}})).status,404);
 assert.deepEqual(calls,[['agents:codex:models','0.160.0'],['agents:codex:models','0.160.0']]);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
