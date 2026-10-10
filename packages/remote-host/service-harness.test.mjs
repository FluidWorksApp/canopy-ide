import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceHarness} from './service-harness.mjs';
import {ServiceAdminError} from './service-admin.mjs';

function fakeAdmin({fail=new Set()}={}){
 const calls=[];const record=(name,...args)=>{calls.push([name,...args]);if(fail.has(name))throw new ServiceAdminError('unavailable','Canopy service is unavailable');};
 return {calls,
  async registerWorkspace(id,body){record('register',id,body);return {agentSocketDir:`/run/canopy-service/ws/${id}`};},
  async deregisterWorkspace(id){record('deregister',id);return {};},
  async mintTerminal(id,body){record('mint',id,body);return {token:'credential-'+body.requestId};},
  async bindTerminal(id,requestId,body){record('bind',id,requestId,body);return {};},
  async revokeTerminal(id,requestId){record('revoke',id,requestId);return {};},
  async putAccess(id,snapshot){record('access',id,snapshot);return {revision:1};},
  async device(){record('device');return {deviceId:'host-device',keys:{agreement:{},signing:{}}};},
 };
}
const config={workspaces:[{id:'alice',name:'Alice',generation:3}],managedSession:{workspaceId:'alice',ownerUserId:'user-1'}};
const runtime={url:'http://127.0.0.1:45000',token:'runner-token',harness:true};
const make=(admin,extra={})=>new ServiceHarness({admin,config,tokenFor:id=>'runner-token',log:()=>{},...extra});

test('the socket directory is prepared before the container exists, then the runner URL is registered',async()=>{
 const admin=fakeAdmin(),harness=make(admin);
 assert.equal(await harness.prepareMount(config.workspaces[0]),true);
 assert.deepEqual(admin.calls[0],['register','alice',{name:'Alice',ownerUserId:'user-1',runnerUrl:null,runnerToken:'runner-token'}]);
 assert.equal(await harness.prepareMount({id:'member-x',parentWorkspaceId:'alice',memberId:'m'}),false,'members never get the socket');
 assert.deepEqual((await harness.attach(config.workspaces[0],runtime)),{available:true});
 assert.equal(admin.calls[1][2].runnerUrl,runtime.url);
 await harness.attach(config.workspaces[0],runtime);
 assert.equal(admin.calls.filter(c=>c[0]==='register').length,2,'a fresh registration is reused');
 const odd=fakeAdmin();odd.registerWorkspace=async()=>({agentSocketDir:'/tmp/elsewhere'});
 assert.equal(await make(odd).prepareMount(config.workspaces[0]),false,'an unexpected socket directory is never mounted');
});

test('spawn credentials: minted before spawn, reused on retry, bound after, revoked on exit and stop',async()=>{
 const admin=fakeAdmin(),harness=make(admin),workspace=config.workspaces[0];
 const first=await harness.mint(workspace,runtime,{requestId:'request-1',command:'claude',agent:'claude'});
 assert.deepEqual(first.harness,{token:'credential-request-1'});
 assert.deepEqual((await harness.mint(workspace,runtime,{requestId:'request-1',command:'claude'})).harness,first.harness);
 assert.equal(admin.calls.filter(c=>c[0]==='mint').length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(admin.calls.find(c=>c[0]==='mint')[2])),{requestId:'request-1',agent:'claude'});
 await harness.bind('alice','request-1',{id:4,pid:900});
 assert.deepEqual(admin.calls.find(c=>c[0]==='bind'),['bind','alice','request-1',{sessionId:4,pid:900}]);
 await harness.observeSessions('alice',[{id:4,exitCode:null}]);
 assert.equal(admin.calls.some(c=>c[0]==='revoke'),false);
 await harness.observeSessions('alice',[{id:4,exitCode:0}]);
 assert.deepEqual(admin.calls.find(c=>c[0]==='revoke'),['revoke','alice','request-1']);
 await harness.mint(workspace,runtime,{requestId:'request-2',command:'codex'});await harness.bind('alice','request-2',{id:5,pid:901});
 await harness.revokeSession('alice',5);
 assert.deepEqual(admin.calls.filter(c=>c[0]==='revoke').map(c=>c[2]),['request-1','request-2']);
 await harness.revokeSession('alice',5);assert.equal(admin.calls.filter(c=>c[0]==='revoke').length,2,'revocation is once');
});

test('an unavailable service or a pre-service container degrades the spawn and reports why',async()=>{
 const workspace=config.workspaces[0];
 const down=make(fakeAdmin({fail:new Set(['register'])}));
 const result=await down.mint(workspace,runtime,{requestId:'request-1'});
 assert.equal(result.harness,null);assert.equal(result.state.available,false);assert.equal(result.state.reason,'unavailable');
 assert.equal(down.status('alice').reason,'unavailable');
 const legacy=make(fakeAdmin());
 const old=await legacy.mint(workspace,{...runtime,harness:undefined},{requestId:'request-1'});
 assert.equal(old.harness,null);assert.equal(old.state.reason,'no-mount');
 const mintFails=make(fakeAdmin({fail:new Set(['mint'])}));
 assert.equal((await mintFails.mint(workspace,runtime,{requestId:'request-1'})).harness,null);
});

test('reconcile deregisters a stopped runtime, heals a restarted service, refreshes authority and sweeps exits',async()=>{
 const admin=fakeAdmin(),written=[],registered=[];let running=true,sessions=[{id:4,exitCode:null}];
 const controlPlane={writeRelayCredential:async ws=>written.push(ws.id),accessSnapshot:async()=>({payload:'p',signature:'s'}),registerHost:async(ws,device)=>registered.push([ws.id,device.deviceId])};
 const harness=make(admin,{controlPlane,inspect:async()=>({State:{Running:running}}),listSessions:async()=>sessions,accessIntervalMs:0,relayIntervalMs:0});
 const workspace=config.workspaces[0];
 await harness.attach(workspace,runtime);await new Promise(resolve=>setImmediate(resolve));
 await harness.mint(workspace,runtime,{requestId:'request-1'});await harness.bind('alice','request-1',{id:4,pid:1});
 await harness.reconcile();
 assert.ok(admin.calls.filter(c=>c[0]==='register').length>=2,'registration is re-asserted');
 assert.ok(admin.calls.some(c=>c[0]==='access'&&c[2].payload==='p'),'the signed snapshot is forwarded verbatim');
 assert.ok(written.length>=1);assert.deepEqual(registered,[['alice','host-device']],'the host device registers once');
 sessions=[];await harness.reconcile();
 assert.ok(admin.calls.some(c=>c[0]==='revoke'),'a vanished terminal loses its credential');
 running=false;await harness.reconcile();
 assert.deepEqual(admin.calls.at(-1),['deregister','alice']);
 assert.equal(harness.workspaces.size,0);
});
