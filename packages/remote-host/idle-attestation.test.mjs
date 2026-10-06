import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';import {IdleAttestation} from './idle-attestation.mjs';import {DockerWorkspaces} from './docker.mjs';
function fixture(){
 const id='ws-11111111-1111-4111-8111-111111111111',workspace={id,generation:4,accounts:[],memoryMiB:2048,cpus:1};const config={workspaces:[workspace],managedSession:{workspaceId:id,key:'synthetic-private-host-key'.repeat(3)}};
 let now=1000,busy=false,allowed=true,containers=[];const calls=[],host=new DockerWorkspaces({secret:'synthetic',docker:async args=>{calls.push(args);if(args[0]==='ps')return {stdout:containers.map(c=>c.Id).join('\n')};if(args[0]==='inspect')return {stdout:JSON.stringify(containers.filter(c=>c.Id===args[1]))};throw Error('Unexpected Docker mutation');}});
 const manager=new IdleAttestation({config,host,now:()=>now,busy:()=>busy,authorizeRuntime:async()=>allowed,instanceName:'host-generation-4'});
 const stopped={Id:'a'.repeat(64),Config:{Labels:{'canopy.workspace':id}},State:{Running:false,Paused:false,Restarting:false,ExitCode:0,OOMKilled:false},HostConfig:{RestartPolicy:{Name:'no'}}};
 return {manager,host,calls,workspace,config,stopped,input:{nonce:'f'.repeat(64),generation:4,instanceName:'host-generation-4'},setBusy:value=>busy=value,setAllowed:value=>allowed=value,setContainers:value=>containers=value,setNow:value=>now=value};
}
test('management-only stopped-container proof is signed, identity-bound and reserves all runtime starts for thirty seconds',async()=>{
 const f=fixture();f.setContainers([f.stopped]);const result=await f.manager.attest(f.workspace,f.input);assert.equal(result.idle,true);const [payload,signature]=result.proof.split('.');assert.equal(signature,createHmac('sha256',f.config.managedSession.key).update(payload).digest('base64url'));assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url')),{version:1,purpose:'workspace-idle',workspaceId:f.workspace.id,generation:4,instanceName:'host-generation-4',nonce:'f'.repeat(64),idle:true,expiresAt:31000});
 assert.equal(f.manager.reserved(f.workspace.id),true);await assert.rejects(f.host.open(f.workspace,{resume:true}),/idle shutdown/);await assert.rejects(f.host.ensure({...f.workspace,id:'member-'+'b'.repeat(40),parentWorkspaceId:f.workspace.id}),/idle shutdown/);const before=f.calls.length;assert.equal(await f.host.recoverRuntime(f.workspace,'a'.repeat(64),{authorize:()=>assert.fail('Reserved recovery must not authorize'),reserve:()=>{}}),false);assert.equal(f.calls.length,before);assert.equal((await f.manager.attest(f.workspace,f.input)).idle,false);f.setNow(31000);assert.equal(f.manager.reserved(f.workspace.id),false);
});
test('running, paused, restarting, crash-restart or unknown containers and active registries fail closed',async()=>{
 for(const changed of [{State:{...fixture().stopped.State,Running:true}},{State:{...fixture().stopped.State,Paused:true}},{State:{...fixture().stopped.State,Restarting:true}},{State:{...fixture().stopped.State,ExitCode:137},HostConfig:{RestartPolicy:{Name:'on-failure'}}},{HostConfig:{RestartPolicy:{Name:'always'}}},{State:{Running:false}}]){const f=fixture();f.setContainers([{...f.stopped,...changed}]);assert.equal((await f.manager.attest(f.workspace,f.input)).idle,false);assert.equal(f.manager.reserved(f.workspace.id),false);}
 const f=fixture();f.setBusy(true);assert.equal((await f.manager.attest(f.workspace,f.input)).idle,false);assert.equal(f.calls.length,0);f.setBusy(false);f.setAllowed(false);assert.equal((await f.manager.attest(f.workspace,f.input)).idle,false);assert.equal(f.calls.length,0);
});
test('foreign identity and mismatched container inspect IDs cannot produce an idle proof',async()=>{
 const f=fixture();for(const changed of [{nonce:'short'},{generation:5},{instanceName:'foreign'}])await assert.rejects(f.manager.attest(f.workspace,{...f.input,...changed}),/identity/);assert.equal(f.calls.length,0);
 f.host.docker=async args=>({stdout:args[0]==='ps'?'a'.repeat(64):JSON.stringify([{...f.stopped,Id:'b'.repeat(64)}])});assert.equal((await f.manager.attest(f.workspace,f.input)).idle,false);
});
test('an already queued start rechecks the idle reservation inside the resource lock',async()=>{
 const f=fixture();let release;const hold=new Promise(resolve=>{release=resolve;});const held=f.host.withResourceLock(()=>hold);const proof=f.manager.attest(f.workspace,f.input);const queued=f.host.open(f.workspace,{resume:true});release();await held;assert.equal((await proof).idle,true);await assert.rejects(queued,/idle shutdown/);assert.ok(f.calls.every(args=>['ps','inspect'].includes(args[0])));
});

test('owner-close proof permits only the exact owner container and retains member jobs after management restart',async()=>{
 const f=fixture(),owner={...f.stopped,Name:`/canopy-ws-${f.workspace.id}`,State:{...f.stopped.State,Running:true}};
 f.setContainers([owner]);assert.equal((await f.manager.attest(f.workspace,f.input)).idle,false);
 const result=await f.manager.attest(f.workspace,f.input,{ownerClosing:true});assert.equal(result.idle,true);assert.equal(JSON.parse(Buffer.from(result.proof.split('.')[0],'base64url')).purpose,'workspace-owner-close');
 for(const changed of [{Name:'/canopy-ws-member-private',Config:{Labels:{'canopy.workspace':'member-private'}}},{Name:'/unknown-owner-helper'}]){
  const g=fixture();g.setContainers([{...owner,...changed}]);assert.equal((await g.manager.attest(g.workspace,g.input,{ownerClosing:true})).idle,false);assert.equal(g.manager.reserved(g.workspace.id),false);
 }
 const g=fixture();g.setContainers([owner,{...g.stopped,Id:'b'.repeat(64),Name:'/canopy-ws-member-private',Config:{Labels:{'canopy.workspace':'member-private'}},State:{...g.stopped.State,Running:true}}]);assert.equal((await g.manager.attest(g.workspace,g.input,{ownerClosing:true})).idle,false);
});
test('owner-close reservations fence queued member starts and tracked detached work',async()=>{
 const f=fixture();f.setBusy(true);assert.equal((await f.manager.attest(f.workspace,f.input,{ownerClosing:true})).idle,false);f.setBusy(false);
 const result=await f.manager.attest(f.workspace,f.input,{ownerClosing:true});assert.equal(result.idle,true);await assert.rejects(f.host.open({...f.workspace,id:'member-private',parentWorkspaceId:f.workspace.id},{resume:true}),/idle shutdown/);
});
