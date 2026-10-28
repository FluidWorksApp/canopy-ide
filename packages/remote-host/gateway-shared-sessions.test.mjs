import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {createHmac} from 'node:crypto';import {WebSocket,WebSocketServer} from 'ws';import {createGateway} from './gateway.mjs';
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
test('real gateway isolates collaborative input, prevents private terminal control and closes revoked streams',async()=>{
 const id='ws-11111111-1111-4111-8111-111111111111',key='k'.repeat(48);
 const workspace={id,cgroupParent:'canopy-test.slice',accounts:['owner'],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',writable:true},{id:'secret',writable:true}]};
 const token=claims=>{const payload=Buffer.from(JSON.stringify({workspaceId:id,expires:Math.floor(Date.now()/1000)+120,...claims})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const owner=token({}),member=token({version:2,memberId:'alice',accessVersion:1,scope:'drive'}),opened=[],stopped=[],inputs=[];
 const runner=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;res.setHeader('content-type','application/json');
  if(req.url==='/sessions'&&req.method==='GET')return res.end(JSON.stringify([{id:9,title:'Private owner',exitCode:null}]));
  if(req.url==='/sessions'&&req.method==='POST'){assert.equal(JSON.parse(text).command,'cd /workspace/projects/app && exec /bin/bash');return res.end('{"id":1}');}
  inputs.push(req.url);res.end('{"ok":true}');});const runnerUrl=await listen(runner);
 const wss=new WebSocketServer({server:runner});wss.on('connection',socket=>socket.send('{"t":"data","b64":"b2s="}'));
 let allowed=true,interact=true;const selected={allRead:false,allWrite:false,selected:[{id:'app',writable:true}]},none={allRead:false,allWrite:false,selected:[]};
 const gateway=createGateway({config:{workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}},workspaces:{open:async w=>{opened.push(w);return {url:runnerUrl,token:'synthetic'};},suspendMember:async w=>stopped.push(w.id)},authorizeMember:async()=>allowed?{projectAccess:selected,sessionAccess:{view:selected,interact:interact?selected:none}}:false});const base=await listen(gateway);
 const call=(auth,route,input)=>fetch(base+'/v1/workspaces/'+id+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});let socket;
 try{
  assert.equal((await call(member,'/shared-sessions',{action:'create',projectId:'app',title:'Pair'})).status,403);
  assert.equal((await call(owner,'/shared-sessions',{action:'publish',sessionId:9,projectId:'app',title:'Private',mode:'interact',acknowledged:true})).status,400);
  const created=await call(owner,'/shared-sessions',{action:'create',projectId:'app',title:'Pair'});assert.equal(created.status,200);const p=(await created.json()).sessions[0];
  assert.notEqual(opened[0].id,id);assert.deepEqual(opened[0].accounts,[]);assert.deepEqual(opened[0].projectMounts.map(p=>p.id),['app']);
  const memberRows=(await (await call(member,'/shared-sessions')).json()).sessions;assert.equal(memberRows[0].mode,'interact');assert.equal(memberRows[0].sessionId,undefined);
  assert.equal((await call(member,`/shared-sessions/${p.id}/input`,{data:'echo pair\n'})).status,200);assert.deepEqual(inputs,['/sessions/1/input']);
  interact=false;assert.equal((await call(member,`/shared-sessions/${p.id}/input`,{data:'forbidden'})).status,403);assert.equal(inputs.length,1);
  const ticket=(await (await call(member,'/ticket',{stream:`/shared-sessions/${p.id}/stream`})).json()).ticket;assert.ok(ticket);
  socket=new WebSocket(base.replace('http:','ws:')+'/v1/stream?ticket='+ticket);await once(socket,'open');const closed=once(socket,'close');
  await call(owner,'/shared-sessions',{action:'revoke',id:p.id});await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Revoked stream stayed open')),2500))]);assert.deepEqual(stopped,[opened[0].id]);
  assert.equal((await call(member,'/ticket',{stream:`/shared-sessions/${p.id}/stream`})).status,403);
  allowed=false;assert.equal((await call(member,'/shared-sessions')).status,401);
 }finally{socket?.terminate();for(const socket of wss.clients)socket.terminate();wss.close();await close(gateway);await close(runner);}
});
test('sharing attestation is control-plane only and reports a fixed reason when the host is not ready',async()=>{
 const id='ws-11111111-1111-4111-8111-111111111111',key='x'.repeat(48),called=[];let reason=null;
 const token=claims=>{const payload=Buffer.from(JSON.stringify({workspaceId:id,expires:Math.floor(Date.now()/1000)+120,...claims})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const attest={attest:async(_w,input)=>{called.push(input.nonce);if(reason)throw Object.assign(Error(reason),{reason});return {proof:'synthetic'};}};
 const server=createGateway({config:{workspaces:[{id,accounts:[],memoryMiB:1024,cpus:1}],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}},workspaces:{open:()=>assert.fail('Attestation routing never opens a runtime itself')},authorizeMember:async()=>true,sharingAttest:attest});const base=await listen(server);
 const call=(claims,route,input)=>fetch(base+'/v1/workspaces/'+id+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+token(claims),'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 try{
  const member={version:2,memberId:'alice',accessVersion:1,scope:'drive'};
  assert.equal((await call(member,'/sharing-attest',{nonce:'a'})).status,403);assert.equal(called.length,0);
  const ok=await call({},'/sharing-attest',{nonce:'a'});assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{proof:'synthetic'});
  reason='Member capacity is not configured on this machine yet. Restart the workspace to finish setup';
  const refused=await call({},'/sharing-attest',{nonce:'b'});assert.equal(refused.status,409);assert.equal((await refused.json()).reason,reason);
  assert.equal((await call({},'/sharing-setup',{action:'start'})).status,400,'the project-copy setup route is gone');
 }finally{await close(server);}
});
test('real gateway lets the owner share a terminal in their own project for watching, never Pair, and only granted members see it',async()=>{
 const id='ws-22222222-2222-4222-8222-222222222222',key='o'.repeat(48);
 const workspace={id,cgroupParent:'canopy-test.slice',accounts:['owner'],memoryMiB:1024,cpus:1,projectMounts:[{id:'app',writable:true},{id:'docs',writable:false}]};
 const token=claims=>{const payload=Buffer.from(JSON.stringify({workspaceId:id,expires:Math.floor(Date.now()/1000)+120,...claims})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const owner=token({}),alice=token({version:2,memberId:'alice',accessVersion:1,scope:'drive'}),bob=token({version:2,memberId:'bob',accessVersion:1,scope:'drive'}),opened=[];
 const runner=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/sessions'&&req.method==='GET')return res.end(JSON.stringify([{id:9,title:'SuprFlow dev',exitCode:null}]));res.statusCode=500;res.end('{}');});const runnerUrl=await listen(runner);
 const grant=ids=>({allRead:false,allWrite:false,selected:ids.map(id=>({id,writable:true}))});
 const access={alice:{projectAccess:grant(['suprflow']),sessionAccess:{view:grant(['suprflow']),interact:grant(['suprflow'])}},bob:{projectAccess:grant(['app']),sessionAccess:{view:grant(['app']),interact:grant([])}}};
 const sharedCatalog={get:async()=>[{id:'suprflow',name:'SuprFlow',components:[{id:'web',label:'Web',path:'/workspace/SuprFlow'}]}]};
 const gateway=createGateway({config:{workspaces:[workspace],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}},sharedCatalog,workspaces:{open:async w=>{opened.push(w);return {url:runnerUrl,token:'synthetic'};},suspendMember:async()=>{}},authorizeMember:async principal=>access[principal.memberId]});const base=await listen(gateway);
 const call=(auth,route,input)=>fetch(base+'/v1/workspaces/'+id+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 try{
  assert.deepEqual((await (await call(owner,'/projects')).json()).projects.map(p=>[p.id,p.canPair]),[['app',true],['docs',false],['suprflow',false]]);
  const pair=await call(owner,'/shared-sessions',{action:'create',projectId:'suprflow',title:'Pair'});assert.equal(pair.status,400);assert.match((await pair.json()).error,/^Pair needs a shared project/);assert.equal(opened.length,0,'no collaboration runtime starts');
  const watched=await call(owner,'/shared-sessions',{action:'publish',sessionId:9,projectId:'suprflow',title:'SuprFlow dev',mode:'view',acknowledged:true});assert.equal(watched.status,200);
  const p=(await watched.json()).sessions[0];assert.equal(p.projectId,'suprflow');assert.equal(p.collaborative,false);assert.equal(p.catalog,undefined);
  assert.deepEqual((await (await call(alice,'/shared-sessions')).json()).sessions.map(s=>[s.id,s.mode]),[[p.id,'view']]);
  assert.ok((await (await call(alice,'/ticket',{stream:`/shared-sessions/${p.id}/stream`})).json()).ticket);
  assert.equal((await call(alice,`/shared-sessions/${p.id}/input`,{data:'nope'})).status,403);
  assert.deepEqual((await (await call(bob,'/shared-sessions')).json()).sessions,[]);
  assert.equal((await call(bob,'/ticket',{stream:`/shared-sessions/${p.id}/stream`})).status,403);
  assert.equal((await call(owner,'/shared-sessions',{action:'publish',sessionId:9,projectId:'elsewhere',title:'X',mode:'view',acknowledged:true})).status,400);
 }finally{await close(gateway);await close(runner);}
});
