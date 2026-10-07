import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway } from './gateway.mjs';
import { createRunner } from './runner.mjs';
import { digest } from './policy.mjs';
import { WebSocket } from 'ws';
import {DockerWorkspaces} from './docker.mjs';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('migration quarantine blocks HTTP access even with a cached owner runtime',async()=>{
 const workspace={id:'recovering',accounts:[],memoryMiB:1024,cpus:1};
 const host=new DockerWorkspaces({secret:'synthetic',registry:[workspace],docker:async()=>{throw Error('Docker must not be called');}});
 host.migrationCleanupRequired.add(workspace.id);
 host.runtimes.set(workspace.id,{url:'http://127.0.0.1:1',token:'synthetic'});
 const server=createGateway({config:{workspaces:[workspace],principals:[{id:'owner',tokenSha256:digest('owner'),workspaces:[workspace.id],scope:'drive'}]},workspaces:host});
 const url=await listen(server);
 try{
  for(const operation of ['/open','/sessions','/resources','/files/read']){
   const response=await fetch(url+'/v1/workspaces/recovering'+operation,{headers:{authorization:'Bearer owner'}});
   assert.equal(response.status,400);
   assert.deepEqual(await response.json(),{error:'Workspace migration requires recovery'});
  }
  const member={...workspace,id:'member-synthetic',parentWorkspaceId:workspace.id};
  host.runtimes.set(member.id,{url:'http://127.0.0.1:1',token:'synthetic'});
  await assert.rejects(host.open(member),/migration requires recovery/);
 }finally{await close(server);}
});

test('opening a running container does not report connected when its runner is unavailable',async()=>{
 const upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({connected:true}));});const upstreamUrl=await listen(upstream);
 const config={workspaces:[{id:'a',accounts:[],memoryMiB:1024,cpus:1}],principals:[{id:'owner',tokenSha256:digest('owner'),workspaces:['a'],scope:'drive'}]};
 const server=createGateway({config,workspaces:{open:async()=>({url:upstreamUrl,token:'runtime'})}}),url=await listen(server);
 try{const response=await fetch(url+'/v1/workspaces/a/open',{method:'POST',headers:{authorization:'Bearer owner'}});assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'Workspace services are not responding yet'});}
 finally{await close(server);await close(upstream);}
});

test('background opens do not resume runtimes and viewers cannot request a resume',async()=>{
 const upstream=http.createServer((req,res)=>res.end('[]')),opened=[];const upstreamUrl=await listen(upstream);
 const config={workspaces:[{id:'a',accounts:[],memoryMiB:1024,cpus:1}],principals:[{id:'owner',tokenSha256:digest('owner'),workspaces:['a'],scope:'drive'},{id:'viewer',tokenSha256:digest('viewer'),workspaces:['a'],scope:'view'}]};
 const server=createGateway({config,workspaces:{open:async(workspace,options)=>{opened.push(options);return {url:upstreamUrl,token:'runtime'};}}}),url=await listen(server);
 const call=(token,body)=>fetch(url+'/v1/workspaces/a/open',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  assert.equal((await call('owner',{})).status,200);assert.deepEqual(opened,[{resume:false}]);
  assert.equal((await call('viewer',{resume:true})).status,403);assert.equal(opened.length,1);
  assert.equal((await call('owner',{resume:true})).status,200);assert.deepEqual(opened[1],{resume:true});
 }finally{await close(server);await close(upstream);}
});

test('HTTP gateway enforces tenant, write and desktop grants before touching runtime', async () => {
  const invoked = [];
  const runtime = http.createServer((request, response) => { invoked.push(request.url); response.setHeader('content-type', 'application/json'); response.end('[]'); });
  const runtimeUrl = await listen(runtime);
  const opened = [];
  const server = createGateway({ config: { workspaces: [
    { id: 'a', accounts: ['team'], memoryMiB: 1024, memoryMaxMiB:4096, cpus: 1, cpusMax:4 }, { id: 'b', accounts: [], memoryMiB: 1024, cpus: 1 },
  ], principals: [{ id: 'reader', tokenSha256: digest('read-token'), workspaces: ['a'], scope: 'view' }] },
    elasticCpu:{status:id=>({minCpus:1,maxCpus:4,currentCpus:2,availableMaxCpus:2,status:'steady'})},
    elasticMemory:{status:id=>({minMiB:1024,maxMiB:4096,currentMiB:2048,status:'steady'})},
    workspaces: { open: async w => { opened.push(w.id); return { url: runtimeUrl, token: 'runtime-secret' }; } } });
  const url = await listen(server);
  const call = (route, args) => fetch(`${url}${route}`, { method: args === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer read-token', 'content-type': 'application/json' }, body: args === undefined ? undefined : JSON.stringify(args) });
  try {
    const list = await (await call('/v1/workspaces')).json();
    assert.deepEqual(list.workspaces.map(w => w.id), ['a']);
    assert.equal(list.workspaces[0].memoryMaxMiB,4096);
    assert.equal(list.workspaces[0].cpusMax,4);
    assert.equal((await call('/v1/workspaces/b/resources')).status,403);
    assert.equal((await call('/v1/workspaces/b/sessions')).status, 403);
    assert.equal((await call('/v1/workspaces/a/sessions', { command: 'whoami' })).status, 403);
    assert.equal((await call('/v1/workspaces/a/files/write', { path: 'x', text: 'x' })).status, 403);
    assert.equal((await call('/v1/workspaces/a/desktop', {})).status, 403);
    assert.equal((await call('/v1/workspaces/a/ticket', { stream: '/desktop/ws' })).status, 403);
    assert.deepEqual(opened, []);
    assert.equal((await call('/v1/workspaces/a/sessions')).status, 200);
    assert.deepEqual(invoked, ['/sessions']);
    assert.equal((await (await call('/v1/workspaces/a/resources')).json()).currentMiB,2048);
    assert.equal((await (await call('/v1/workspaces/a/resources')).json()).cpu.currentCpus,2);
    assert.equal((await call('/v1/workspaces/a/resources',{maxMiB:65536,cpusMax:32})).status,400);
    assert.equal((await fetch(`${url}/v1/workspaces`, { headers: { authorization: 'Bearer read-token', origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${url}/v1/workspaces`)).status, 401);
  } finally { await close(server); await close(runtime); }
});

test('runner retries create one process; disconnect and reconnect keep that process and bounded replay', async () => {
  let spawns = 0; let onData; let onExit;
  const pty = { onData: handler => { onData = handler; }, onExit: handler => { onExit = handler; }, write() {}, resize() {}, kill() {} };
  const secret = 'x'.repeat(64);
  const server = createRunner({ secret, spawnPty: () => { spawns++; return pty; }, accounts: [] });
  const url = await listen(server);
  const call = async (route, args) => {
    const result = await fetch(`${url}${route}`, { method: args === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: args === undefined ? undefined : JSON.stringify(args) });
    return { status: result.status, data: await result.json() };
  };
  try {
    const args = { command: 'echo harmless', requestId: 'test-request-1' };
    const [first, retry] = await Promise.all([call('/sessions', args), call('/sessions', args)]);
    assert.equal(first.data.id, retry.data.id); assert.equal(spawns, 1);
    assert.equal((await call('/sessions', { ...args, command: 'different' })).status, 400);
    assert.equal((await call('/sessions', { ...args, requestId: 'private-account', accountId: 'other' })).status, 400);
    const connect = async () => {
      const ws = new WebSocket(`${url.replace('http', 'ws')}/sessions/1/stream`, { headers: { authorization: `Bearer ${secret}` } });
      const snapshot = once(ws, 'message'); await once(ws, 'open');
      return { ws, snapshot: JSON.parse((await snapshot)[0]) };
    };
    const initial = await connect(); assert.equal(initial.snapshot.id, 1);
    const disconnected = once(initial.ws, 'close'); initial.ws.close(); await disconnected;
    onData('x'.repeat(1024 * 1024)); onData('MARKER');
    const reconnected = await connect();
    const replay = Buffer.from(reconnected.snapshot.b64, 'base64');
    assert.equal(replay.length, 512 * 1024); assert.ok(replay.toString().endsWith('MARKER')); assert.equal(spawns, 1);
    onExit({ exitCode: 0 });
    const closed = once(reconnected.ws, 'close'); reconnected.ws.close(); await closed;
    assert.equal((await call('/sessions')).data[0].exitCode, 0);
  } finally { await close(server); }
});

test('global admission refuses the 33rd pending operation across different identities', async () => {
  const runtime = http.createServer((_, response) => { response.setHeader('content-type', 'application/json'); response.end('[]'); });
  const runtimeUrl = await listen(runtime);
  let release, ready; let opened = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const saturated = new Promise(resolve => { ready = resolve; });
  const server = createGateway({ config: {
    workspaces: [{ id: 'shared', accounts: [], memoryMiB: 1024, cpus: 1 }],
    principals: Array.from({ length: 33 }, (_, i) => ({ id: `user-${i}`, tokenSha256: digest(`test-${i}`), workspaces: ['shared'], scope: 'view' })),
  }, workspaces: { open: async () => { if (++opened === 32) ready(); await gate; return { url: runtimeUrl, token: 'synthetic' }; } } });
  const url = await listen(server);
  const request = i => fetch(`${url}/v1/workspaces/shared/sessions`, { headers: { authorization: `Bearer test-${i}` } });
  const pending = Array.from({ length: 32 }, (_, i) => request(i));
  try {
    await saturated;
    assert.equal((await request(32)).status, 429);
    assert.equal(opened, 32);
    release();
    assert.ok((await Promise.all(pending)).every(response => response.status === 200));
  } finally { release(); await Promise.allSettled(pending); await close(server); await close(runtime); }
});

test('removing a principal disconnects an established stream',async()=>{
 const {WebSocketServer}=await import('ws');
 const runtime=http.createServer();const upstream=new WebSocketServer({server:runtime});
 const runtimeUrl=await listen(runtime);
 const config={workspaces:[{id:'a',accounts:[],memoryMiB:1024,cpus:1}],principals:[{id:'alice',tokenSha256:digest('alice'),workspaces:['a'],scope:'drive'}]};
 const server=createGateway({config,workspaces:{open:async()=>({url:runtimeUrl,token:'user-runtime-only'})}});const url=await listen(server);let socket;
 try{
  const result=await fetch(url+'/v1/workspaces/a/ticket',{method:'POST',headers:{authorization:'Bearer alice','content-type':'application/json'},body:JSON.stringify({stream:'/desktop/ws'})});
  const {ticket}=await result.json();socket=new WebSocket(url.replace('http:','ws:')+'/v1/stream?ticket='+ticket);await once(socket,'open');
  const closed=once(socket,'close');config.principals=[];
  await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Revoked stream stayed open')),2500);timer.unref();})]);
  assert.equal(socket.readyState,WebSocket.CLOSED);
 }finally{socket?.terminate();for(const client of upstream.clients)client.terminate();upstream.close();await close(server);await close(runtime);}
});

test('member tokens require live authorization and select only their authenticated runtime',async()=>{
 const {createHmac}=await import('node:crypto');const key='k'.repeat(48),opened=[];
 const config={workspaces:[{id:'shared',cgroupParent:'canopy-shared.slice',accounts:['owner'],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',writable:true},{id:'private',writable:true}]}],principals:[{id:'managed-account',tokenSha256:'0'.repeat(64),scope:'drive',workspaces:['shared']}],managedSession:{key,workspaceId:'shared'}};
 const token=memberId=>{const payload=Buffer.from(JSON.stringify({version:2,workspaceId:'shared',memberId,accessVersion:1,scope:'drive',expires:Math.floor(Date.now()/1000)+120})).toString('base64url');return 'Bearer '+payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end('[]');});const upstreamUrl=await listen(upstream);
 let allowed=true;const runtime={open:async w=>{opened.push(w);return {url:upstreamUrl,token:'runtime'};}};
 const server=createGateway({config,workspaces:runtime,authorizeMember:async p=>allowed&&p.memberId==='alice'&&{projectAccess:{allRead:false,allWrite:false,selected:[{id:'app',writable:false}]}}}),url=await listen(server);
 const denied=createGateway({config,workspaces:runtime}),deniedUrl=await listen(denied);
 const call=(base,who)=>fetch(base+'/v1/workspaces/shared/open',{method:'POST',headers:{authorization:token(who),'content-type':'application/json'},body:JSON.stringify({memberId:'owner',accounts:['owner'],projectAccess:{allRead:true,allWrite:true,selected:[]}})});
 try{
  assert.equal((await call(deniedUrl,'alice')).status,401);assert.equal(opened.length,0);
  assert.equal((await call(url,'bob')).status,401);assert.equal(opened.length,0);
  assert.equal((await call(url,'alice')).status,200);assert.equal(opened[0].memberId,'alice');assert.deepEqual(opened[0].accounts,[]);assert.notEqual(opened[0].id,'shared');assert.deepEqual(opened[0].projectMounts,[{id:'app',writable:false}]);
  allowed=false;assert.equal((await call(url,'alice')).status,401);assert.equal(opened.length,1);
 }finally{await close(server);await close(denied);await close(upstream);}
});

test('terminal sessions receive validated member Git defaults without arbitrary environment injection',async()=>{
 const launches=[],secret='x'.repeat(64);
 const server=createRunner({secret,spawnPty:(bin,args,options)=>{launches.push(options);return {onData(){},onExit(){},kill(){},resize(){},write(){}};}}),url=await listen(server);
 const spawn=identity=>fetch(url+'/sessions',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({requestId:'identity-session-'+launches.length,command:'git status',gitIdentity:identity})});
 try{
  const identity={name:'Alice Member',email:'alice@example.invalid',LD_PRELOAD:'/tmp/evil.so'};
  assert.equal((await spawn(identity)).status,200);
  assert.equal(launches[0].env.GIT_AUTHOR_EMAIL,identity.email);assert.equal(launches[0].env.GIT_COMMITTER_NAME,identity.name);
  assert.equal(launches[0].env.LD_PRELOAD,undefined);assert.equal(launches[0].env.HOME,'/home/agent');
  assert.equal((await spawn({name:'Forged\nOwner',email:'owner@example.invalid'})).status,400);assert.equal(launches.length,1);
 }finally{await close(server);}
});

test('member commits override forged attribution and fail closed without trusted identity',async()=>{
 const {createHmac}=await import('node:crypto'),key='k'.repeat(48),received=[];
 const upstream=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  received.push(JSON.parse(body));res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/sessions'?{id:1}:{result:'committed'}));
 });const upstreamUrl=await listen(upstream);
 const config={workspaces:[{id:'shared',cgroupParent:'canopy-shared.slice',accounts:[],memoryMiB:1024,cpus:1}],principals:[{id:'managed-account',tokenSha256:'0'.repeat(64),scope:'drive',workspaces:['shared']}],managedSession:{key,workspaceId:'shared'}};
 const payload=Buffer.from(JSON.stringify({version:2,workspaceId:'shared',memberId:'alice',accessVersion:1,scope:'drive',expires:Math.floor(Date.now()/1000)+120})).toString('base64url');
 const bearer='Bearer '+payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');
 let identity={name:'Alice Member',email:'alice@example.invalid'};
 const server=createGateway({config,workspaces:{open:async()=>({url:upstreamUrl,nativeUrl:upstreamUrl,token:'runtime'})},authorizeMember:async()=>({projectAccess:{allRead:true,allWrite:true,selected:[]},gitIdentity:identity})});const url=await listen(server);
 const commit=()=>fetch(url+'/v1/workspaces/shared/native',{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:JSON.stringify({command:'git_commit',args:{repo:'/workspace/projects/app',message:'Change',gitIdentity:{name:'Owner',email:'owner@example.invalid'}}})});
 try{
  assert.equal((await commit()).status,200);assert.equal(received.length,1);
  assert.deepEqual(received[0].args.gitIdentity,identity);assert.equal(received[0].args.message,'Change');
  const session=await fetch(url+'/v1/workspaces/shared/sessions',{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:JSON.stringify({requestId:'member-terminal',command:'bash',gitIdentity:{name:'Owner',email:'owner@example.invalid'}})});
  assert.equal(session.status,200);assert.deepEqual(received[1].gitIdentity,identity);
  identity=undefined;const denied=await commit();assert.equal(denied.status,400);
  assert.match((await denied.json()).error,/Member Git identity is unavailable/);assert.equal(received.length,2);
 }finally{await close(server);await close(upstream);}
});

test('a compromised runtime cannot redirect gateway requests to another host endpoint',async()=>{
 let leakedRequests=0;
 const target=http.createServer((req,res)=>{leakedRequests++;res.end('{}');});const targetUrl=await listen(target);
 const runtime=http.createServer((req,res)=>{res.writeHead(307,{location:targetUrl+'/management'});res.end();});const runtimeUrl=await listen(runtime);
 const config={workspaces:[{id:'a',accounts:[],memoryMiB:1024,cpus:1}],principals:[{id:'alice',tokenSha256:digest('alice'),workspaces:['a'],scope:'drive'}]};
 const gateway=createGateway({config,workspaces:{open:async()=>({url:runtimeUrl,nativeUrl:runtimeUrl,token:'runtime-secret'})}});const url=await listen(gateway);
 try{
  for(const route of ['/sessions','/native']){
   const response=await fetch(url+'/v1/workspaces/a'+route,{method:'POST',headers:{authorization:'Bearer alice','content-type':'application/json'},body:JSON.stringify({command:'project_list'})});
   assert.ok(response.status>=400);assert.equal(leakedRequests,0,'runtime redirect reached a host endpoint');
  }
 }finally{await close(gateway);await close(runtime);await close(target);}
});

test('member store loads discover only granted shared projects and their components',async()=>{
 const {createHmac}=await import('node:crypto'),key='k'.repeat(48);
 const upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({result:JSON.stringify({projects:[{id:'mine',name:'Private'}],openIds:['mine'],activeId:'mine'})}));});
 const upstreamUrl=await listen(upstream);
 const config={workspaces:[{id:'shared',cgroupParent:'canopy-shared.slice',accounts:[],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',name:'Product',writable:true,components:[{id:'web',label:'Web',relativePath:'web'}]},{id:'secret',writable:true}]}],principals:[{id:'managed-account',tokenSha256:'0'.repeat(64),scope:'drive',workspaces:['shared']}],managedSession:{key,workspaceId:'shared'}};
 const payload=Buffer.from(JSON.stringify({version:2,workspaceId:'shared',memberId:'alice',accessVersion:1,scope:'drive',expires:Math.floor(Date.now()/1000)+120})).toString('base64url');
 const bearer='Bearer '+payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');
 const server=createGateway({config,workspaces:{open:async()=>({url:upstreamUrl,token:'runtime'})},authorizeMember:async()=>({projectAccess:{allRead:false,allWrite:false,selected:[{id:'app',writable:true}]}})});
 const url=await listen(server);
 try{
  const catalogResponse=await fetch(url+'/v1/workspaces/shared/projects',{headers:{authorization:bearer}});
  assert.equal(catalogResponse.status,200);assert.deepEqual(await catalogResponse.json(),{projects:[{id:'app',name:'Product',components:[{id:'web',name:'Web'}]}]});
  const response=await fetch(url+'/v1/workspaces/shared/native',{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:JSON.stringify({command:'store_load'})});
  assert.equal(response.status,200);
  const store=JSON.parse((await response.json()).result);
  assert.deepEqual(store.projects.map(p=>p.id),['mine','app']);
  assert.equal(store.projects[1].components[0].path,'/workspace/projects/app/web');
  assert.equal(store.activeId,'mine');
 }finally{await close(server);await close(upstream);}
});

test('trusted project catalog can be read without opening a stopped runtime and rejects writes',async()=>{
 let opens=0;const config={workspaces:[{id:'catalog',accounts:[],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',name:'Product',writable:true,components:[{id:'web',label:'Frontend',relativePath:'web'}]}]}],principals:[{id:'owner',tokenSha256:digest('owner'),workspaces:['catalog'],scope:'drive'}]};
 const server=createGateway({config,workspaces:{open:async()=>{opens++;throw Error('Stopped runtime must not be opened');}}});const url=await listen(server);
 try{
  const result=await fetch(url+'/v1/workspaces/catalog/projects',{headers:{authorization:'Bearer owner'}});
  assert.equal(result.status,200);assert.deepEqual(await result.json(),{projects:[{id:'app',name:'Product',components:[{id:'web',name:'Frontend'}]}]});
  const write=await fetch(url+'/v1/workspaces/catalog/projects',{method:'POST',headers:{authorization:'Bearer owner'},body:'{}'});assert.ok(write.status>=400);assert.equal(opens,0);
 }finally{await close(server);}
});
test('shared account import and selection are owner-only and never return secrets',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');const {CredentialVault}=await import('./credential-vault.mjs');const {SharedAccounts}=await import('./shared-accounts.mjs');const {createHmac}=await import('node:crypto');
 const id='ws-11111111-1111-4111-8111-111111111111',key='k'.repeat(48),secret='synthetic-shared-provider-secret';
 const workspace={id,accounts:[],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',writable:true}]};
 const config={workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}};
 const token=claims=>{const payload=Buffer.from(JSON.stringify({workspaceId:id,expires:Math.floor(Date.now()/1000)+120,...claims})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const root=await mkdtemp(path.join(tmpdir(),'canopy-gateway-vault-'));const vault=await CredentialVault.initialize(root);
 const gateway=createGateway({config,workspaces:{},credentialVault:vault,sharedAccounts:new SharedAccounts(vault),authorizeMember:async()=>true});const base=await listen(gateway);
 const call=(claims,input)=>fetch(base+'/v1/workspaces/'+id+'/shared-accounts',{method:input?'POST':'GET',headers:{authorization:'Bearer '+token(claims),'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 try{
  const member={version:2,memberId:'alice',accessVersion:1,scope:'drive'};
  assert.equal((await call(member,{action:'import',accountId:'shared',credential:{provider:'anthropic',token:secret}})).status,403);
  assert.equal((await call({},{action:'import',accountId:'shared',credential:{provider:'anthropic',token:secret}})).status,200);
  assert.equal((await call({},{action:'bind',projectId:'app',slot:'claude',accountId:'shared'})).status,200);
  const listed=await (await call({})).text();assert.ok(!listed.includes(secret));assert.equal(JSON.parse(listed).bindings[0].accountId,'shared');
  assert.equal((await call(member,{action:'remove',accountId:'shared'})).status,403);
  assert.equal((await call({},{action:'bind',projectId:'other',slot:'claude',accountId:'shared'})).status,400);
  assert.equal((await call({},{action:'remove',accountId:'shared'})).status,200);await assert.rejects(vault.load('shared',{workspaceId:id}));
 }finally{await close(gateway);await rm(root,{recursive:true,force:true});}
});
test('broker transport binds payloads and prevents replay before provider execution',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');const {CredentialVault}=await import('./credential-vault.mjs');const {SharedAccounts}=await import('./shared-accounts.mjs');const {CredentialTickets}=await import('./credential-tickets.mjs');const {createHmac,createHash}=await import('node:crypto');
 const id='ws-11111111-1111-4111-8111-111111111111',key='k'.repeat(48),secret='synthetic-provider-secret';
 const workspace={id,accounts:[],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',writable:true}]};
 const config={workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}};
 const claims={version:2,workspaceId:id,memberId:'alice',accessVersion:1,scope:'drive',expires:Math.floor(Date.now()/1000)+120},encoded=Buffer.from(JSON.stringify(claims)).toString('base64url'),bearer='Bearer '+encoded+'.'+createHmac('sha256',key).update(encoded).digest('base64url');
 const root=await mkdtemp(path.join(tmpdir(),'broker-gateway-')),vault=await CredentialVault.initialize(path.join(root,'vault')),accounts=new SharedAccounts(vault),tickets=await CredentialTickets.initialize(path.join(root,'tickets'),'host-ticket-key'.repeat(3));
 await vault.store(id,'claude',{provider:'anthropic',token:secret});await accounts.bind(id,'app','claude','claude');
 let allowed=true,provider=0;const access={allRead:true,allWrite:true,selected:[]};
 const options={config,workspaces:{},credentialVault:vault,sharedAccounts:accounts,credentialTickets:tickets,authorizeMember:async()=>allowed?{projectAccess:access,sharedAccess:{git:access,agents:access}}:false,brokerOptions:{fetchImpl:async(url,opts)=>{provider++;assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(opts.headers['x-api-key'],secret);return Response.json({result:'synthetic'});}}};
 let gateway=createGateway(options),base=await listen(gateway);
 const call=(operation,input)=>fetch(base+'/v1/workspaces/'+id+operation,{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:JSON.stringify(input)});
 const payload=Buffer.from('{"messages":[]}'),request={projectId:'app',operation:'agents:claude',bodySha256:createHash('sha256').update(payload).digest('hex')};
 try{
  const ticket=(await (await call('/shared-ticket',request)).json()).ticket;assert.ok(ticket);
  assert.equal((await call('/shared-execute',{ticket,body:Buffer.from('forged').toString('base64')})).status,400);assert.equal(provider,0);
  const executed=await call('/shared-execute',{ticket,body:payload.toString('base64')});assert.equal(executed.status,200);const text=await executed.text();assert.ok(!text.includes(secret));assert.equal(provider,1);
  assert.equal((await call('/shared-execute',{ticket,body:payload.toString('base64')})).status,400);assert.equal(provider,1);
  await close(gateway);options.credentialTickets=await CredentialTickets.initialize(path.join(root,'tickets'),'host-ticket-key'.repeat(3));gateway=createGateway(options);base=await listen(gateway);
  assert.equal((await call('/shared-execute',{ticket,body:payload.toString('base64')})).status,400);assert.equal(provider,1);
  const next=(await (await call('/shared-ticket',request)).json()).ticket;allowed=false;assert.equal((await call('/shared-execute',{ticket:next,body:payload.toString('base64')})).status,401);assert.equal(provider,1);
 }finally{await close(gateway);await rm(root,{recursive:true,force:true});}
});

test('member viewer can browse its read-only project runtime and cannot invoke mutations, shell or arbitrary native commands',async()=>{
 const {createHmac}=await import('node:crypto');const key='synthetic-management-key-123456789012345',workspaceId='ws-11111111-1111-4111-8111-111111111111';
 const claims={version:2,workspaceId,memberId:'viewer',scope:'view',accessVersion:1,expires:Math.floor(Date.now()/1000)+120},payload=Buffer.from(JSON.stringify(claims)).toString('base64url'),bearer='Bearer '+payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');
 const calls=[],opened=[];const upstream=http.createServer(async(req,res)=>{let data='';for await(const part of req)data+=part;calls.push({path:req.url,body:data?JSON.parse(data):null});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/native'?{result:'synthetic-file'}:[]));});const upstreamUrl=await listen(upstream);
 const config={managedSession:{workspaceId,key},principals:[{id:'managed-account',tokenSha256:'0'.repeat(64),scope:'drive',workspaces:[workspaceId]}],workspaces:[{id:workspaceId,accounts:[],memoryMiB:1024,cpus:1,cgroupParent:'canopy-shared.slice',projectMounts:[{id:'app',writable:true}]}]};
 const server=createGateway({config,authorizeMember:async()=>({projectAccess:{allRead:true,allWrite:false,selected:[]}}),workspaces:{open:async runtime=>{opened.push(runtime);return {url:upstreamUrl,token:'synthetic'};},suspendMember:async()=>{}}}),url=await listen(server);
 const native=command=>fetch(url+'/v1/workspaces/'+workspaceId+'/native',{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:JSON.stringify({command,args:{path:'/workspace/projects/app/readme.md'}})});
 try{
  assert.equal((await native('fs_read_file')).status,200);assert.equal(opened[0].readOnly,true);assert.equal(opened[0].projectMounts[0].writable,false);assert.deepEqual(opened[0].accounts,[]);
  const count=opened.length;for(const command of ['fs_write_file','profile_import_credentials','git_commit','workspace_browser_open','unknown','which_check'])assert.equal((await native(command)).status,403);assert.equal(opened.length,count);
  assert.equal((await fetch(url+'/v1/workspaces/'+workspaceId+'/sessions',{method:'POST',headers:{authorization:bearer,'content-type':'application/json'},body:JSON.stringify({command:'bash'})})).status,403);
 }finally{await close(server);await close(upstream);}
});

test('owner-close proof is owner-only and never opens a developer runtime',async()=>{
 const {createHmac}=await import('node:crypto');const {DockerWorkspaces}=await import('./docker.mjs');
 const id='ws-11111111-1111-4111-8111-111111111111',key='synthetic-private-host-key'.repeat(3),workspace={id,generation:4,accounts:[],memoryMiB:1024,cpus:1};
 const config={workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}},calls=[];
 const host=new DockerWorkspaces({secret:'synthetic',docker:async args=>{calls.push(args);if(args[0]==='ps')return {stdout:'a'.repeat(64)};if(args[0]==='inspect')return {stdout:JSON.stringify([{Id:'a'.repeat(64),Name:`/canopy-ws-${id}`,Config:{Labels:{'canopy.workspace':id}},State:{Running:true}}])};throw Error('Unexpected runtime mutation');}});
 const oldInstance=process.env.CANOPY_INSTANCE_NAME;process.env.CANOPY_INSTANCE_NAME='synthetic-machine';
 const gateway=createGateway({config,workspaces:host,authorizeMember:async()=>true,authorizeRuntime:async()=>true}),base=await listen(gateway);
 const token=claims=>{const payload=Buffer.from(JSON.stringify({workspaceId:id,expires:Math.floor(Date.now()/1000)+120,...claims})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const call=claims=>fetch(base+'/v1/workspaces/'+id+'/close-attestation',{method:'POST',headers:{authorization:'Bearer '+token(claims),'content-type':'application/json'},body:JSON.stringify({nonce:'f'.repeat(64),generation:4,instanceName:'synthetic-machine'})});
 try{
  const response=await call({});assert.equal(response.status,200);const result=await response.json();assert.equal(result.idle,true);assert.equal(JSON.parse(Buffer.from(result.proof.split('.')[0],'base64url')).purpose,'workspace-owner-close');
  const count=calls.length;assert.equal((await call({version:2,memberId:'alice',accessVersion:1,scope:'drive'})).status,403);assert.equal(calls.length,count);assert.ok(calls.every(args=>['ps','inspect'].includes(args[0])));
 }finally{await close(gateway);if(oldInstance===undefined)delete process.env.CANOPY_INSTANCE_NAME;else process.env.CANOPY_INSTANCE_NAME=oldInstance;}
});

test('managed owner and member queued opens recheck live authority after resource admission',async()=>{
 const {createHmac}=await import('node:crypto');
 for(const member of [false,true]){
  const key='synthetic'.repeat(8),workspace={id:'shared',generation:9,cgroupParent:'canopy-shared.slice',accounts:[],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',writable:true}]};
  const config={workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:['shared'],tokenSha256:digest('owner')}],managedSession:{workspaceId:'shared',key}};
  let resume,admitted;const waiting=new Promise(r=>admitted=r),gate=new Promise(r=>resume=r);let allowed=true,starts=0;
  const host=new DockerWorkspaces({secret:'synthetic',resourceAdmission:async action=>{admitted();await gate;return action();}});host.ensure=async()=>{starts++;return{};};
  const server=createGateway({config,workspaces:host,authorizeRuntime:async()=>allowed,authorizeMember:async()=>allowed&&{projectAccess:{allRead:true,allWrite:true,selected:[]}}}),url=await listen(server);
  let bearer='owner';if(member){const payload=Buffer.from(JSON.stringify({version:2,workspaceId:'shared',memberId:'alice',accessVersion:1,scope:'drive',expires:Math.floor(Date.now()/1000)+120})).toString('base64url');bearer=payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');}
  try{const request=fetch(url+'/v1/workspaces/shared/open',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:'{"resume":true}'});await waiting;allowed=false;resume();const result=await request;assert.equal(result.status,400);assert.equal(starts,0);}
  finally{resume();await close(server);}
 }
});
