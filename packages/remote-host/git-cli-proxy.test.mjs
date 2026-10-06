import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {gitCliHandler} from './git-cli-proxy.mjs';
test('Git smart HTTP maps fetch/push advertisement and pack to fixed operations without arbitrary destinations',async()=>{
 const secret='s'.repeat(43),calls=[],server=http.createServer(gitCliHandler({secret,execute:async(op,body,options)=>{calls.push([op,options.advertise,Buffer.from(body).toString()]);return new Response('pack',{headers:{'content-type':'application/x-git-upload-pack-result','x-secret':'do-not-return'}});}}));server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{
  const call=(method,path,body)=>fetch(base+path,{method,headers:{authorization:'Bearer '+secret},...(body?{body}:{})});
  assert.equal((await call('GET','/info/refs?service=git-upload-pack')).status,200);assert.equal((await call('POST','/git-upload-pack','fetch-body')).status,200);assert.equal((await call('GET','/info/refs?service=git-receive-pack')).status,200);assert.equal((await call('POST','/git-receive-pack','push-body')).status,200);
  for(const path of ['/private/repo.git/info/refs?service=git-upload-pack','/info/refs?service=git-upload-pack&url=http://metadata','/git-upload-pack?url=http://metadata','/info/refs?service=unknown'])assert.equal((await call('GET',path)).status,404);
  assert.deepEqual(calls,[['git:fetch',true,''],['git:fetch',false,'fetch-body'],['git:push',true,''],['git:push',false,'push-body']]);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
