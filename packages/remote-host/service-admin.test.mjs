import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceAdmin,ServiceAdminError} from './service-admin.mjs';
import {fakeServiceAdmin} from './test-support/fake-service-admin.mjs';

test('admin client speaks the protocol paths and bodies over the Unix socket',async()=>{
 const fake=await fakeServiceAdmin(call=>{
  if(call.path==='/admin/health')return {ready:true,version:'1'};
  if(call.method==='PUT'&&call.path==='/admin/workspaces/alice')return {agentSocketDir:'/run/canopy-service/ws/alice'};
  if(call.path==='/admin/workspaces/alice/terminals')return {token:'t'.repeat(32)};
  if(call.path==='/admin/device')return {deviceId:'d',keys:{agreement:{},signing:{}}};
  return {};
 });
 try{
  const admin=new ServiceAdmin({socketPath:fake.socketPath});
  assert.deepEqual(await admin.health(),{ready:true,version:'1'});
  assert.deepEqual(await admin.registerWorkspace('alice',{name:'Alice',runnerUrl:'http://127.0.0.1:1',runnerToken:'x'}),{agentSocketDir:'/run/canopy-service/ws/alice'});
  assert.equal((await admin.mintTerminal('alice',{requestId:'request-1',agent:'claude'})).token.length,32);
  await admin.bindTerminal('alice','request-1',{sessionId:3,pid:42});
  await admin.revokeTerminal('alice','request-1');
  await admin.putAccess('alice',{payload:'p',signature:'s'});
  await admin.query('alice',{store:'notes',action:'list',args:{}});
  await admin.action('alice',{kind:'answer',actor:'u'});
  await admin.deregisterWorkspace('alice');
  await admin.device();
  assert.deepEqual(fake.calls.map(c=>`${c.method} ${c.path}`),['GET /admin/health','PUT /admin/workspaces/alice','POST /admin/workspaces/alice/terminals','POST /admin/workspaces/alice/terminals/request-1/bind','DELETE /admin/workspaces/alice/terminals/request-1','PUT /admin/workspaces/alice/access','POST /admin/workspaces/alice/query','POST /admin/workspaces/alice/actions','DELETE /admin/workspaces/alice','GET /admin/device']);
  assert.deepEqual(fake.calls[1].body,{name:'Alice',ownerUserId:null,runnerUrl:'http://127.0.0.1:1',runnerToken:'x'});
  assert.deepEqual(fake.calls[2].body,{requestId:'request-1',agent:'claude'});
  assert.deepEqual(fake.calls[3].body,{sessionId:3,pid:42});
 }finally{await fake.close();}
});

test('admin failures are typed: unavailable, timeout, rejected, invalid response; ids are validated before any I/O',async()=>{
 const missing=new ServiceAdmin({socketPath:'/nonexistent/canopy/admin.sock'});
 await assert.rejects(missing.health(),error=>error instanceof ServiceAdminError&&error.code==='unavailable');
 const fake=await fakeServiceAdmin((call,request,response)=>{
  if(call.path==='/admin/health'){return new Promise(()=>{});}
  if(call.path==='/admin/device'){response.writeHead(200);response.end('not json');return;}
  if(call.path==='/admin/workspaces/alice/query'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({blob:'x'.repeat(4096)}));return;}
  return [409,{error:'rollback',message:'Snapshot revision is older'}];
 });
 try{
  const admin=new ServiceAdmin({socketPath:fake.socketPath,timeoutMs:200,maxBytes:1024});
  await assert.rejects(admin.health(),error=>error.code==='timeout');
  await assert.rejects(admin.device(),error=>error.code==='invalid-response');
  await assert.rejects(admin.call('POST','/admin/workspaces/alice/query',{}),error=>error.code==='invalid-response'&&/too large/.test(error.message));
  await assert.rejects(admin.putAccess('alice',{}),error=>error.code==='rejected'&&error.status===409&&error.message==='Snapshot revision is older');
  const before=fake.calls.length;
  await assert.rejects(admin.registerWorkspace('../etc',{}),error=>error.code==='rejected');
  await assert.rejects(admin.bindTerminal('alice','../x',{}),error=>error.code==='rejected');
  await assert.rejects(admin.openStream('alice','bad cursor'),/cursor/);
  assert.equal(fake.calls.length,before);
 }finally{await fake.close();}
});
