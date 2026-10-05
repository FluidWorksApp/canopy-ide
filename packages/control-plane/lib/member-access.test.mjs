import {test} from 'node:test';import assert from 'node:assert/strict';
import {accessVersion,memberToken,verifyMemberToken,liveMemberAccess} from './member-access.mjs';
const grant={source:'team',team_id:'team',role:'member',access_version:1,team_joined_at:'first',organizationJoinedAt:'first',permissions:{projects:'all'}};
test('credentials change after grant, membership epoch, permission or machine generation changes',()=>{const v=accessVersion([grant],1);for(const change of [{access_version:2},{team_joined_at:'second'},{organizationJoinedAt:'second'},{role:'viewer'},{permissions:{projects:'selected',projectIds:['one']}}])assert.notEqual(accessVersion([{...grant,...change}],1),v);assert.notEqual(accessVersion([grant],2),v);assert.ok(Number.isSafeInteger(v));});
test('version is stable across grant query ordering',()=>{const b={...grant,team_id:'another'};assert.equal(accessVersion([grant,b],1),accessVersion([b,grant],1));});
test('signed member credential expires and rejects changed payload',()=>{const claims={workspaceId:'ws-11111111-1111-4111-8111-111111111111',memberId:'member',scope:'drive',accessVersion:accessVersion([grant],1)};const token=memberToken(claims,'key',100000);assert.equal(verifyMemberToken(token,()=> 'key',100000).accessVersion,claims.accessVersion);assert.throws(()=>verifyMemberToken(token,()=> 'key',221000));assert.throws(()=>verifyMemberToken(token,()=> 'different',100000));});
test('intentional shutdown denies a still-valid member token',async()=>{const db={query:async()=>({rows:[{state:'ready',desired_state:'stopped',generation:1}]})};assert.equal(await liveMemberAccess(db,{workspaceId:'workspace',memberId:'member'}),false);});

test('selected developers get execution without broadening read-only project grants',async()=>{
 const {memberAccessSnapshot}=await import('./member-access.mjs');
 let grants=[{role:'viewer',permissions:{projects:'all'}},{role:'member',permissions:{projects:'selected',projectIds:['app']}}];
 const db={query:async sql=>({rows:sql.includes('SELECT state')?[{state:'ready',desired_state:'running',generation:1}]:sql.includes('SELECT owner_id')?[{owner_id:'owner',organization_id:null}]:sql.includes('FROM workspace_member')?grants:[]})};
 const access=await memberAccessSnapshot(db,'workspace','alice');
 assert.equal(access.scope,'drive');assert.deepEqual(access.projectAccess,{allRead:true,allWrite:false,selected:[{id:'app',writable:true}]});
 const {grantedProjects}=await import('../../remote-host/project-mounts.mjs');
 assert.deepEqual(grantedProjects({id:'workspace',projectMounts:[{id:'app',writable:true},{id:'other',writable:true}]},access.projectAccess),[{id:'app',writable:true},{id:'other',writable:false}]);
 grants=[{role:'member',permissions:{projects:'selected',projectIds:[]}}];
 assert.equal(await memberAccessSnapshot(db,'workspace','alice'),null);
 grants=[{role:'viewer',permissions:{projects:'selected',projectIds:['app']}}];
 assert.equal((await memberAccessSnapshot(db,'workspace','alice')).scope,'view');
});
