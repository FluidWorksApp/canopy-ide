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
test('sharing setup is owner-only and blocks execution while storage migration is active',async()=>{
 const id='ws-11111111-1111-4111-8111-111111111111',key='x'.repeat(48),called=[];let active=false;
 const token=claims=>{const payload=Buffer.from(JSON.stringify({workspaceId:id,expires:Math.floor(Date.now()/1000)+120,...claims})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};
 const setup={active:()=>active,status:async()=>({status:'not-enabled'}),start:async(_w,input)=>{called.push(input);active=true;return {status:'running'};},attest:async()=>{called.push('attest');return {proof:'synthetic'};}};
 const server=createGateway({config:{workspaces:[{id,accounts:[],memoryMiB:1024,cpus:1}],principals:[{id:'managed-account',scope:'drive',workspaces:[id],tokenSha256:'0'.repeat(64)}],managedSession:{workspaceId:id,key}},workspaces:{open:()=>assert.fail('No runtime may open during migration')},authorizeMember:async()=>true,sharingSetup:setup});const base=await listen(server);
 const call=(claims,route,input)=>fetch(base+'/v1/workspaces/'+id+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+token(claims),'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 try{const member={version:2,memberId:'alice',accessVersion:1,scope:'drive'};assert.equal((await call(member,'/sharing-setup',{action:'start',confirmInterrupt:true})).status,403);assert.equal(called.length,0);assert.equal((await call({},'/sharing-setup',{action:'attest'})).status,200);assert.deepEqual(called,['attest']);assert.equal((await call({},'/sharing-setup',{action:'start',confirmInterrupt:true})).status,202);assert.equal((await call({},'/sharing-setup')).status,200);assert.equal((await call({},'/native',{command:'fs_read_file'})).status,400);assert.equal((await call({},'/sessions')).status,400);}
 finally{await close(server);}
});
