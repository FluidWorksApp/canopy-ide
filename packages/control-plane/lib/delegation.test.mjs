import test from 'node:test';
import assert from 'node:assert/strict';
import {canDelegateWorkspacePolicy as allows} from './delegation.mjs';
const grant=(role,permissions)=>({role,permissions});
test('admin delegates only administratively accessible projects',()=>{
 const grants=[grant('admin',{projectIds:['app']}),grant('member',{projects:'all'}),grant('viewer',{projects:'all',git:'shared'})];
 assert.equal(allows(grants,{projectIds:['app']}),true);
 assert.equal(allows(grants,{projectIds:['other']}),false);
 assert.equal(allows(grants,{projects:'all'}),false);
 assert.equal(allows(grants,{projectIds:['app'],git:'shared'}),false);
});
test('selected project delegation can combine independent administrative scopes',()=>{
 const grants=[grant('admin',{projectIds:['app'],git:'shared'}),grant('admin',{projectIds:['api'],git:'shared'})];
 assert.equal(allows(grants,{projectIds:['app','api'],git:'shared'}),true);
 assert.equal(allows(grants,{projects:'all',git:'shared'}),false);
});
test('credentials and session authority remain bound to the delegated projects',()=>{
 const grants=[grant('admin',{projectIds:['app'],agents:'shared',sessions:'view'}),grant('admin',{projectIds:['api'],git:'shared',sessions:'interact'})];
 assert.equal(allows(grants,{projectIds:['app'],agents:'shared',sessions:'view'}),true);
 assert.equal(allows(grants,{projectIds:['app'],git:'shared'}),false);
 assert.equal(allows(grants,{projectIds:['app'],sessions:'interact'}),false);
 assert.equal(allows(grants,{projectIds:['api'],sessions:'view'}),true);
});
test('owner retains full delegation and non-admins cannot delegate empty grants',()=>{
 assert.equal(allows([grant('owner',{})],{projects:'all',git:'shared',agents:'shared',sessions:'interact'}),true);
 assert.equal(allows([grant('member',{projects:'all'})],{}),false);
});

test('team and person grants by an admin are refused before saving; only the owner shares',async()=>{
 const {changeWorkspaceTeamGrant}=await import('./workspace-team-grants.mjs');
 const {changeWorkspacePersonGrant}=await import('./workspace-person-grants.mjs');
 for(const change of [changeWorkspaceTeamGrant,changeWorkspacePersonGrant]){
  const mutations=[];
  const db={query:async(sql,args)=>{
   if(sql.startsWith('INSERT')){mutations.push([sql,args]);return {rows:[]};}
   if(sql.includes('FROM workspace WHERE'))return {rows:[{id:'workspace',owner_id:'owner',organization_id:'org'}]};
   if(sql.includes('SELECT joined_at'))return {rows:[{joined_at:'epoch'}]};
   if(sql.includes('SELECT role,permissions,access_version'))return {rows:[grant('admin',{projectIds:['app']})]};
   if(sql.includes('FROM workspace_team_access a'))return {rows:[]};
   if(sql.includes('SELECT id FROM team')||sql.includes('SELECT 1 FROM organization_member'))return {rows:[{id:'team'}]};
   return {rows:[]};
  }};
  const input={workspaceId:'workspace',teamId:'team',userId:'person',action:'grant',role:'member',permissions:{projectIds:['app']}};
  // Shares are owner-set (team-policy invitationRole); admins no longer grant.
  await assert.rejects(change(db,'admin',input),e=>e.status===400||e.status===403);
  assert.equal(mutations.length,0,'a refused grant must never be saved');
  await assert.rejects(change(db,'admin',{...input,permissions:{projects:'all'}}),e=>e.status===400||e.status===403);
  assert.equal(mutations.length,0,'out-of-scope delegation must never be saved');
 }
});
