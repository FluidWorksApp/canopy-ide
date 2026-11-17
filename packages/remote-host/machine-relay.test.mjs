import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MachineRelay,RelayUnavailable,relayDeadlineMs,relayDir} from './machine-relay.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const op=(extra={})=>({op:'machine',machineOp:'run',machineArgs:{command:'make'},cwd:'/workspace/app',ptyId:3,...extra});

/** What the sidecar does: one HTTP request over the socket, bearer token. */
function post(socket,token,body,pathname='/ctx/ui',method='POST'){
 return new Promise((resolve,reject)=>{
  const request=http.request({socketPath:socket,path:pathname,method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}},response=>{
   let text='';response.on('data',c=>text+=c);response.on('end',()=>resolve({status:response.statusCode,text}));
  });
  request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
 });
}

test('an op waits for the window, which takes it once and answers it',async()=>{
 const relay=new MachineRelay({});
 await relay.poll({wait:0});
 const pending=relay.submit(op());
 const {ops}=await relay.poll({wait:0});
 assert.deepEqual(ops,[{id:'1',machineOp:'run',machineArgs:{command:'make'},cwd:'/workspace/app',ptyId:3}]);
 // Handed out once: a second window (or the next poll) does not run it again.
 assert.deepEqual((await relay.poll({wait:0})).ops,[]);
 assert.deepEqual(relay.result({id:'1',ok:true,data:{code:0,stdout:'built'}}),{accepted:true});
 assert.deepEqual(await pending,{ok:true,body:'{"code":0,"stdout":"built"}'});
 // A late or repeated answer is not accepted.
 assert.deepEqual(relay.result({id:'1',ok:true,data:'again'}),{accepted:false});
});

test('a poll waits for an op to arrive',async()=>{
 const relay=new MachineRelay({});
 const polling=relay.poll({wait:5000});
 await tick();
 const pending=relay.submit(op({machineOp:'list'}));
 const {ops}=await polling;
 assert.equal(ops.length,1);
 relay.result({id:ops[0].id,ok:false,data:'not a repository'});
 assert.deepEqual(await pending,{ok:false,body:'not a repository'});
});

test('with no window connected the agent is told so at once',async()=>{
 let now=1_000_000;
 const relay=new MachineRelay({now:()=>now});
 await assert.rejects(relay.submit(op()),error=>error instanceof RelayUnavailable&&error.reason==='no-ide'&&/none is connected/.test(error.message));
 await relay.poll({wait:0});
 now+=60_000;
 await assert.rejects(relay.submit(op()),/none is connected/);
});

test('ops a window took and never answered fail once it is gone',async()=>{
 let now=1_000_000;
 const relay=new MachineRelay({now:()=>now});
 await relay.poll({wait:0});
 const taken=relay.submit(op());
 await relay.poll({wait:0});
 const waiting=relay.submit(op());
 now+=10_000;relay.sweep();
 assert.equal(relay.ops.size,2);
 now+=60_000;relay.sweep();
 await assert.rejects(taken,/disconnected before it answered, so the outcome is unknown/);
 await assert.rejects(waiting,/disconnected before it took this request/);
});

test('only machine ops with a working directory are accepted',async()=>{
 const relay=new MachineRelay({});
 await relay.poll({wait:0});
 await assert.rejects(relay.submit(op({machineOp:'reboot'})),/unknown machine op: reboot/);
 await assert.rejects(relay.submit(op({cwd:''})),/working directory/);
 await assert.rejects(relay.submit(op({cwd:'relative'})),/working directory/);
 // Arguments that are not an object are dropped, not passed on.
 const pending=relay.submit(op({machineArgs:'rm -rf'}));
 assert.deepEqual((await relay.poll({wait:0})).ops[0].machineArgs,{});
 relay.result({id:'1',ok:true,data:null});await pending;
});

test('deadlines match the sidecar\'s',()=>{
 assert.equal(relayDeadlineMs('list'),90_000);
 assert.equal(relayDeadlineMs('run',{}),21*60_000);
 assert.equal(relayDeadlineMs('run',{timeoutMinutes:20}),31*60_000);
 assert.equal(relayDeadlineMs('run',{timeoutMinutes:900}),31*60_000);
 assert.equal(relayDeadlineMs('workflow'),3*60*60_000);
});

test('the socket answers the sidecar\'s request, and only with the token',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'relay-'));
 const relay=new MachineRelay({dir:path.join(base,'r')});
 try{
  const socket=await relay.listen();
  assert.equal((await stat(path.dirname(socket))).mode&0o777,0o700);
  assert.equal((await stat(socket)).mode&0o777,0o600);
  assert.deepEqual(relay.env(),{CANOPY_RELAY_SOCKET:socket,CANOPY_RELAY_TOKEN:relay.token});
  assert.equal((await post(socket,'wrong',op())).status,401);

  // No window yet: a 503 the sidecar turns into its message.
  const cold=await post(socket,relay.token,op());
  assert.equal(cold.status,503);
  assert.match(JSON.parse(cold.text).message,/none is connected/);

  // A window polls; the op goes round and comes back as the HTTP reply.
  const serve=(async()=>{for(;;){const {ops}=await relay.poll({wait:2000});if(ops.length)return ops[0];}})();
  const reply=post(socket,relay.token,op({machineOp:'sync',machineArgs:{to:'Build Box'}}));
  const taken=await serve;
  assert.equal(taken.machineOp,'sync');
  assert.deepEqual(taken.machineArgs,{to:'Build Box'});
  relay.result({id:taken.id,ok:true,data:{summary:'Build Box now matches'}});
  assert.deepEqual(await reply,{status:200,text:'{"summary":"Build Box now matches"}'});

  // A refusal comes back as a 400 with the reason as its body.
  const refused=post(socket,relay.token,op());
  const second=(await relay.poll({wait:2000})).ops[0];
  relay.result({id:second.id,ok:false,data:'Build Box has changes of its own'});
  assert.deepEqual(await refused,{status:400,text:'Build Box has changes of its own'});

  // Nothing else is served here.
  const other=await post(socket,relay.token,{op:'ask',question:'?'});
  assert.equal(other.status,503);
  assert.equal(JSON.parse(other.text).reason,'not-implemented');
  assert.equal((await post(socket,relay.token,undefined,'/ctx/tools','GET')).status,503);
 }finally{await relay.close();await rm(base,{recursive:true,force:true});}
});

test('the relay folder is private and short',()=>{
 assert.equal(relayDir('work-0a1b2c3d',{runtime:'/run/user/1000'}),'/run/user/1000/canopy-relay-work-0a1b2c3d');
 assert.equal(relayDir('work-0a1b2c3d',{runtime:undefined,tmp:'/tmp',uid:1000}),'/tmp/canopy-relay-work-0a1b2c3d-1000');
 assert.equal(relayDir('../../etc',{runtime:undefined,tmp:'/tmp',uid:1}),'/tmp/canopy-relay-etc-1');
 // A temp folder too deep for a socket path (macOS) falls back to /tmp.
 assert.equal(relayDir('work-0a1b2c3d',{runtime:undefined,tmp:'/var/folders/zz/'+'x'.repeat(60)+'/T',uid:501}),'/tmp/canopy-relay-work-0a1b2c3d-501');
});
