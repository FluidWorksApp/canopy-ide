import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';
import {SharingAttest,ATTEST_REASONS} from './sharing-attest.mjs';
const key='k'.repeat(48),nonce='a'.repeat(64);
const workspace=(extra={})=>({id:'ws-a',generation:4,cgroupParent:'canopy-0123456789abcdef01234567.slice',accounts:[],...extra});
function fixture({slice='canopy-0123456789abcdef01234567.slice',capacity=true,network=true,ready=true,authorized=true,recovery=false}={}){
 const host={migrationCleanupRequired:new Set(recovery?['ws-a']:[]),verifyCapacity:async()=>{if(!capacity)throw Error('slice missing');},open:async()=>({url:'http://runtime'}),inspectRuntime:async()=>({HostConfig:{CgroupParent:slice}})};
 return new SharingAttest({config:{managedSession:{key}},host,authorizeRuntime:async()=>authorized,instanceName:'host-1',networkReady:async()=>{if(!network)throw Error('down');},ready:async()=>ready,now:()=>1000});
}
test('a ready host signs a proof bound to workspace, generation, instance and nonce',async()=>{
 const {proof}=await fixture().attest(workspace(),{nonce,generation:4,instanceName:'host-1'});
 const [payload,signature]=proof.split('.');
 assert.equal(signature,createHmac('sha256',key).update(payload).digest('base64url'));
 const claims=JSON.parse(Buffer.from(payload,'base64url'));
 assert.deepEqual({...claims,catalogHash:undefined},{version:1,purpose:'sharing-ready',workspaceId:'ws-a',generation:4,instanceName:'host-1',nonce,catalogHash:undefined,expiresAt:31000});
});
test('each unready condition refuses with its own fixed reason',async()=>{
 const cases=[[{},workspace({cgroupParent:undefined}),ATTEST_REASONS.capacity],[{slice:'other.slice'},workspace(),ATTEST_REASONS.capacity],[{capacity:false},workspace(),ATTEST_REASONS.capacity],[{network:false},workspace(),ATTEST_REASONS.network],[{ready:false},workspace(),ATTEST_REASONS.services],[{authorized:false},workspace(),ATTEST_REASONS.authorization],[{recovery:true},workspace(),ATTEST_REASONS.recovery]];
 for(const [options,w,reason] of cases)await assert.rejects(fixture(options).attest(w,{nonce,generation:4,instanceName:'host-1'}),error=>error.reason===reason);
 await assert.rejects(fixture().attest(workspace(),{nonce,generation:3,instanceName:'host-1'}),error=>error.reason===ATTEST_REASONS.request);
 await assert.rejects(fixture().attest(workspace(),{nonce,generation:4,instanceName:'host-2'}),error=>error.reason===ATTEST_REASONS.request);
 await assert.rejects(fixture().attest(workspace({memberId:'m',parentWorkspaceId:'ws-a'}),{nonce,generation:4,instanceName:'host-1'}),error=>error.reason===ATTEST_REASONS.request);
});
