import test from 'node:test';import assert from 'node:assert/strict';
import {runtimeAuthority} from './runtime-authority.mjs';
import {authenticate} from './policy.mjs';
import {createGateway} from './gateway.mjs';
import {verifyRuntimePolicyToken,runtimeRecoveryAllowed} from '../control-plane/lib/runtime-policy.mjs';
const key='k'.repeat(48),workspace={id:'ws-11111111-1111-4111-8111-111111111111',generation:4},now=1000000;
test('trusted policy is workspace-bound, generation-bound and short lived',async()=>{
 const authority=runtimeAuthority('https://control.invalid/api/runtime-policy',{key,workspaceId:workspace.id},{now:()=>now,fetchImpl:async(url,options)=>{
  assert.equal(options.redirect,'error');const token=options.headers.authorization.slice(7);
  const claims=verifyRuntimePolicyToken(token,()=>key,now);assert.equal(claims.generation,4);
  assert.throws(()=>verifyRuntimePolicyToken(token,()=>key,now+61000));
  assert.throws(()=>verifyRuntimePolicyToken(token,()=>key+'wrong',now));
  assert.throws(()=>authenticate({managedSession:{key,workspaceId:workspace.id},principals:[{id:'managed-account',workspaces:[workspace.id]}]},'Bearer '+token));
  return Response.json({allowed:true,workspaceId:workspace.id,generation:4});
 }});
 assert.equal(await authority(workspace),true);assert.equal(await authority({...workspace,id:'another-workspace'}),false);
});
test('managed supervisor recovery requires current external authority and rejects stop intent',async()=>{
 const w={...workspace,accounts:[],memoryMiB:1024,cpus:1},supervisor={close(){}};let allowed=false;
 const config={workspaces:[w],principals:[],managedSession:{key,workspaceId:w.id}};
 const gateway=createGateway({config,workspaces:{},supervisor,authorizeRuntime:async()=>allowed});
 try{assert.equal(await supervisor.authorize(w),false);allowed=true;assert.equal(await supervisor.authorize(w),true);w.desiredState='stopped';assert.equal(await supervisor.authorize(w),false);}
 finally{gateway.emit('close');}
 const noAuthority={close(){}},other={...w,desiredState:'running'};const closed=createGateway({config:{...config,workspaces:[other]},workspaces:{},supervisor:noAuthority});
 try{assert.equal(await noAuthority.authorize(other),false);}finally{closed.emit('close');}
});
test('intentional stop, stale generation and missing authority fail closed',async()=>{
 for(const current of [null,{generation:3,state:'ready',desired_state:'running'},{generation:4,state:'ready',desired_state:'stopped'},{generation:4,state:'stopping',desired_state:'running'}])assert.equal(await runtimeRecoveryAllowed({query:async(sql,args)=>{assert.deepEqual(args,[workspace.id]);return {rows:current?[current]:[]};}},{workspaceId:workspace.id,generation:workspace.generation}),false);
 assert.equal(await runtimeRecoveryAllowed({query:async()=>({rows:[{generation:4,state:'ready',desired_state:'running'}]})},{workspaceId:workspace.id,generation:workspace.generation}),true);
 for(const output of [{allowed:true,workspaceId:workspace.id,generation:3},{allowed:true,workspaceId:'other',generation:4},{allowed:false}]){
  const authority=runtimeAuthority('https://control.invalid/api/runtime-policy',{key,workspaceId:workspace.id},{fetchImpl:async()=>Response.json(output)});assert.equal(await authority(workspace),false);
 }
 assert.throws(()=>runtimeAuthority('http://control.invalid/api/runtime-policy',{key}));
});
