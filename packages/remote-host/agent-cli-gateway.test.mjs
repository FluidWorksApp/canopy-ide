import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHmac} from 'node:crypto';import {createGateway} from './gateway.mjs';import {CredentialVault} from './credential-vault.mjs';import {SharedAccounts} from './shared-accounts.mjs';import {CredentialTickets} from './credential-tickets.mjs';
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
test('gateway session startup supplies scoped CLI access and follows IDE renewal, owner policy and revoked grants',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'shared-cli-gateway-')),id='ws-11111111-1111-4111-8111-111111111111',key='k'.repeat(48),providerSecret='synthetic-provider-key',access={allRead:true,allWrite:true,selected:[]};
 const workspace={id,accounts:[],memoryMiB:1024,cpus:1,generation:1,cgroupParent:'canopy-a.slice',projectMounts:[{id:'app',writable:true}]};
 const config={workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}};
 const token=(member,expires=120)=>{const payload=Buffer.from(JSON.stringify({workspaceId:id,expires:Math.floor(Date.now()/1000)+expires,...(member?{version:2,memberId:member,accessVersion:1,scope:'drive'}:{})})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const vault=await CredentialVault.initialize(path.join(root,'vault')),accounts=new SharedAccounts(vault),tickets=await CredentialTickets.initialize(path.join(root,'tickets'),'ticket-signing-key'.repeat(3));await vault.store(id,'team-api',{provider:'anthropic',token:providerSecret});await accounts.bind(id,'app','claude','team-api');
 let allowed=true,ownerAllowed=true,running=true,clock=Date.now(),failStart=false,invalidStart=false,forwarded,providerCalls=0,bearers=[];
 const runner=http.createServer(async(req,res)=>{let data='';for await(const c of req)data+=c;forwarded=JSON.parse(data||'{}');res.writeHead(failStart?400:200,{'content-type':'application/json'});if(failStart)return res.end('{}');if(invalidStart)return res.end('{bad-json');res.end(JSON.stringify({id:1,title:'cli',cols:120,rows:40,exitCode:null}));});const runtime=await listen(runner);
 const gateway=createGateway({config,now:()=>clock,workspaces:{inspectRuntime:async()=>({State:{Running:running,Paused:false}}),open:async()=>({url:runtime,token:'runner-secret'}),suspendMember:async()=>{}},credentialVault:vault,sharedAccounts:accounts,credentialTickets:tickets,authorizeRuntime:async()=>ownerAllowed,authorizeMember:async(principal,bearer)=>{bearers.push(bearer);return allowed?{projectAccess:access,sharedAccess:{git:access,agents:access},gitIdentity:{name:'Alice',email:'alice@example.test'}}:false;},brokerOptions:{fetchImpl:async(url,options)=>{providerCalls++;assert.equal(options.headers['x-api-key'],providerSecret);assert.equal(url,'https://api.anthropic.com/v1/messages');return Response.json({ok:true});}}});const base=await listen(gateway);
 const call=(actor,route,args,expires,credential=token(actor,expires))=>fetch(base+'/v1/workspaces/'+id+route,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(args)});
 try{
  const malformed=await new Promise((resolve,reject)=>{const request=http.request(base,{path:'http://[',signal:AbortSignal.timeout(2000)},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end();});
  assert.equal(malformed,400); // Invalid request targets must stay inside the HTTP error boundary.
  assert.equal((await call('alice','/sessions',{command:'claude',projectId:'app',requestId:'request-123'})).status,200);
  const facade=forwarded.sharedAgents.claude;assert.ok(facade.url.startsWith('https://'+id+'.workspaces.canopyide.dev/'));assert.ok(!JSON.stringify(forwarded).includes(providerSecret));assert.ok(!JSON.stringify(forwarded).includes(key));
  const generation=()=>fetch(base+new URL(facade.url).pathname+'/v1/messages',{method:'POST',headers:{authorization:'Bearer '+facade.token},body:'{"messages":[]}'});
  assert.equal((await generation()).status,200);
  const renewedToken=token('alice',240);
  assert.equal((await call('alice','/open',{},240,renewedToken)).status,400); // Fake runner lacks real readiness, but renewal is admitted before readiness.
  assert.equal((await generation()).status,200);assert.ok(bearers.includes('Bearer '+renewedToken));
  assert.equal((await call('alice','/sessions',{command:'claude',projectId:'app',requestId:'forged-123',sharedAgents:{claude:facade}})).status,400);
  allowed=false;assert.equal((await generation()).status,502);assert.equal(providerCalls,2);
  assert.equal((await call(null,'/sessions',{command:'claude',projectId:'app',requestId:'owner-123'})).status,200);const owner=forwarded.sharedAgents.claude;
  const ownerCall=()=>fetch(base+new URL(owner.url).pathname+'/v1/messages',{method:'POST',headers:{'x-api-key':owner.token},body:'{}'});
  assert.equal((await ownerCall()).status,200);ownerAllowed=false;assert.equal((await ownerCall()).status,502);assert.equal(providerCalls,3);
  ownerAllowed=true;clock+=300000;assert.equal((await ownerCall()).status,200);assert.equal(providerCalls,4); // Original owner connection token expired; scoped internal delegation survives.
  running=false;assert.equal((await ownerCall()).status,502);assert.equal(providerCalls,4);running=true;workspace.generation=2;assert.equal((await ownerCall()).status,502);workspace.generation=1;clock+=86400000;assert.equal((await ownerCall()).status,502);assert.equal(providerCalls,4);
 }finally{await close(gateway);await close(runner);await rm(root,{recursive:true,force:true});}
});
