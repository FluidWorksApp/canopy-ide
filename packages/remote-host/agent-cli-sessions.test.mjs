import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {AgentCliSessions} from './agent-cli-sessions.mjs';
test('session facade fixes actor/project, deduplicates startup and uses fresh renewed credentials without provider keys',async()=>{
 const workspace={id:'ws-11111111-1111-4111-8111-111111111111'},principal={memberId:'alice',accessVersion:2,scope:'drive',expiresAt:Date.now()+50000};let current={...principal,workspaceId:workspace.id,bearer:'first'},allowed=true,calls=[];
 const sessions=new AgentCliSessions({endpoint:()=> 'https://workspace.example/',resolvePrincipal:async entry=>{if(!allowed||current.memberId!==entry.memberId||current.accessVersion!==entry.accessVersion)throw Error('Expired');return current;},authorize:async(p,c)=>c.operation==='agents:claude'?{...c,accountId:'shared'}:null,execute:async(p,c)=>{calls.push([p.bearer,c.projectId,c.operation]);return Response.json({ok:true});}});
 const server=http.createServer(async(req,res)=>{if(!await sessions.handle(req,res)){res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');const local='http://127.0.0.1:'+server.address().port;
 try{
  const [one,two]=await Promise.all([sessions.prepare(workspace,principal,'app','request-123'),sessions.prepare(workspace,principal,'app','request-123')]);assert.deepEqual(one,two);assert.equal(one.codex,undefined);assert.ok(!JSON.stringify(one).includes('first'));
  const call=(path='/v1/messages')=>fetch(local+new URL(one.claude.url).pathname+path,{method:'POST',headers:{'x-api-key':one.claude.token},body:'{}'});
  assert.equal((await call()).status,200);current={...current,bearer:'renewed',expiresAt:Date.now()+100000};assert.equal((await call('/v1/messages/count_tokens')).status,200);
  assert.deepEqual(calls,[['first','app','agents:claude'],['renewed','app','agents:claude:count-tokens']]);
  allowed=false;assert.equal((await call()).status,502);assert.equal(calls.length,2);allowed=true;current={...current,memberId:'bob'};assert.equal((await call()).status,502);assert.equal(calls.length,2);
 }finally{sessions.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('stopped session facade is revoked even if the actor workspace lease continues renewing',async()=>{
 const workspace={id:'ws-11111111-1111-4111-8111-111111111111'},principal={memberId:'alice',accessVersion:1,scope:'drive',expiresAt:Date.now()+100000};
 const sessions=new AgentCliSessions({endpoint:()=> 'https://workspace.example/',resolvePrincipal:async()=>principal,authorize:async(p,c)=>({...c,accountId:'shared'}),execute:async()=>Response.json({})});
 try{await sessions.prepare(workspace,principal,'app','request-123');sessions.bind(workspace.id,'alice','request-123',5);assert.equal(sessions.entries.size,1);sessions.revoke(workspace.id,'bob',5);assert.equal(sessions.entries.size,1);sessions.revoke(workspace.id,'alice',5);assert.equal(sessions.entries.size,0);}finally{sessions.close();}
});
