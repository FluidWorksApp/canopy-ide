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

const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('a relay refresh failure is logged when it starts or changes, not on every retry',async()=>{
 const logs=[];let relayError='ENOENT: no such file or directory, mkdir \'/run/canopy-relay/alice\'',writes=0;
 const controlPlane={writeRelayCredential:async()=>{writes++;if(relayError)throw Error(relayError);},accessSnapshot:async()=>({payload:'p',signature:'s'}),registerHost:async()=>{}};
 const harness=make(fakeAdmin(),{controlPlane,log:m=>logs.push(m),accessIntervalMs:0,relayIntervalMs:0}),workspace=config.workspaces[0];
 await harness.attach(workspace,runtime);await settle();
 for(let i=0;i<3;i++)await harness.refreshAuthority(workspace);
 assert.equal(writes,4,'a failing refresh keeps retrying');
 assert.deepEqual(logs,['Relay credential refresh failed: ENOENT: no such file or directory, mkdir \'/run/canopy-relay/alice\'']);
 relayError='EACCES: permission denied';await harness.refreshAuthority(workspace);await harness.refreshAuthority(workspace);
 assert.equal(logs.length,2,'a changed message logs again');
 relayError=null;await harness.refreshAuthority(workspace);
 relayError='EACCES: permission denied';await harness.refreshAuthority(workspace);
 assert.equal(logs.length,3,'failing again after a success logs again');
});

test('access snapshots switched off on the control plane (503) log once and back off',async()=>{
 const logs=[];let clock=0,status=503,asked=0;
 const controlPlane={writeRelayCredential:async()=>{},registerHost:async()=>{},accessSnapshot:async()=>{asked++;if(status)throw Object.assign(Error(`Access snapshot refused (${status})`),{status});return {payload:'p',signature:'s'};}};
 const harness=make(fakeAdmin(),{controlPlane,now:()=>clock,log:m=>logs.push(m),accessIntervalMs:60_000,accessBackoffMs:900_000}),workspace=config.workspaces[0];
 await harness.attach(workspace,runtime);await settle();
 assert.equal(asked,1);
 for(clock=60_000;clock<900_000;clock+=60_000)await harness.refreshAuthority(workspace);
 assert.equal(asked,1,'not retried before the backoff elapses');
 clock=900_000;await harness.refreshAuthority(workspace);
 assert.equal(asked,2,'retried after it');
 assert.deepEqual(logs,['Access snapshot refresh failed for alice: Access snapshot refused (503)']);
 status=0;clock=1_800_000;await harness.refreshAuthority(workspace);assert.equal(asked,3);
 clock=1_860_000;await harness.refreshAuthority(workspace);assert.equal(asked,4,'a success resumes the normal cadence');
 status=500;
 for(let i=0;i<3;i++){clock+=60_000;await harness.refreshAuthority(workspace);}
 assert.equal(asked,7,'any other failure keeps the normal cadence');
 assert.deepEqual(logs.slice(1),['Access snapshot refresh failed for alice: Access snapshot refused (500)']);
});

test('a host config without an owner id never calls the service and says so once',async()=>{
 const admin=fakeAdmin(),logs=[],workspace={id:'bob',name:'Bob'};
 const harness=new ServiceHarness({admin,config:{workspaces:[workspace],managedSession:{workspaceId:'bob',ownerUserId:null}},tokenFor:()=>'runner-token',log:m=>logs.push(m)});
 assert.equal(await harness.prepareMount(workspace),false);
 for(let i=0;i<5;i++)assert.equal((await harness.attach(workspace,runtime)).reason,'no-owner');
 assert.equal(await harness.prepareMount(workspace),false);
 const minted=await harness.mint(workspace,runtime,{requestId:'request-1'});
 assert.equal(minted.harness,null);assert.equal(minted.state.reason,'no-owner');
 assert.equal(admin.calls.length,0,'the service is never asked to register a null owner');
 assert.equal(logs.length,1);assert.match(logs[0],/no-owner for bob: The host configuration has no workspace owner id/);
 assert.equal(harness.status('bob').reason,'no-owner');
 assert.equal(await new ServiceHarness({admin,config:{workspaces:[workspace]},tokenFor:()=>'t',log:()=>{}}).prepareMount({...workspace,ownerUserId:' '}),false,'a blank owner is no owner');
 assert.equal(admin.calls.length,0);
});

test('an unavailable state is logged when it changes, not on every report',async()=>{
 const logs=[],fail=new Set(),admin=fakeAdmin({fail}),harness=make(admin,{log:m=>logs.push(m),intervalMs:0}),workspace=config.workspaces[0];
 for(let i=0;i<5;i++)assert.equal((await harness.attach(workspace,{...runtime,harness:undefined})).reason,'no-mount');
 assert.equal(logs.length,1);assert.doesNotMatch(logs[0],/predates/);
 fail.add('register');
 for(let i=0;i<3;i++)assert.equal((await harness.attach(workspace,runtime)).reason,'unavailable');
 assert.equal(logs.length,2,'a changed reason logs again');
 fail.delete('register');
 assert.deepEqual(await harness.attach(workspace,runtime),{available:true});
 assert.equal(logs.length,2);
 fail.add('register');
 await harness.attach(workspace,runtime);await harness.attach(workspace,runtime);
 assert.equal(logs.length,3,'failing again after recovery logs again');
 assert.equal(harness.status('alice').reason,'unavailable');
});
