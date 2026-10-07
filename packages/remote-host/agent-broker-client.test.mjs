import test from 'node:test';import assert from 'node:assert/strict';import {AgentBrokerClient} from './agent-broker-client.mjs';
const workspaceId='ws-11111111-1111-4111-8111-111111111111',payload=new TextEncoder().encode('{"messages":[]}');
test('CLI request resolves fresh credentials and issues a new payload-bound ticket every time',async()=>{
 let generation=0;const requests=[];const client=new AgentBrokerClient({endpoint:'https://workspace.example',workspaceId,projectId:'app',memberId:'alice',resolveCredential:async()=>({workspaceId,memberId:'alice',token:'member-'+(++generation),expiresAt:Date.now()+120000}),fetchImpl:async(url,options)=>{requests.push({url,options});return url.endsWith('/shared-ticket')?Response.json({ticket:'ticket-'+generation}):new Response('data: result\n\n',{headers:{'content-type':'text/event-stream'}});}});
 assert.equal(await (await client.execute('agents:claude',payload)).text(),'data: result\n\n');await client.execute('agents:claude',payload);
 assert.equal(generation,2);assert.equal(requests[0].options.headers.authorization,'Bearer member-1');assert.equal(requests[2].options.headers.authorization,'Bearer member-2');assert.equal(requests[1].options.redirect,'error');assert.equal(JSON.parse(requests[1].options.body).body,Buffer.from(payload).toString('base64'));
});
test('wrong actor, workspace and stale credentials cannot reach the broker',async()=>{
 let calls=0;for(const credential of [{workspaceId,memberId:'bob',token:'token',expiresAt:Date.now()+120000},{workspaceId:'other',memberId:'alice',token:'token',expiresAt:Date.now()+120000},{workspaceId,memberId:'alice',token:'token',expiresAt:Date.now()+1000}]){
  const client=new AgentBrokerClient({endpoint:'https://workspace.example',workspaceId,projectId:'app',memberId:'alice',resolveCredential:async()=>credential,fetchImpl:async()=>{calls++;throw Error('Must not send');}});await assert.rejects(client.execute('agents:codex',payload));
 }assert.equal(calls,0);
});
