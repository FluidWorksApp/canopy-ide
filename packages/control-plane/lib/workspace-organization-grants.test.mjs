import test from 'node:test';
import assert from 'node:assert/strict';
import {changeWorkspaceOrganizationGrant,listWorkspaceOrganizationGrants} from './workspace-organization-grants.mjs';
import {workspaceAccess} from './workspace-access.mjs';
import {accessVersion} from './member-access.mjs';
import {discoverWorkspaces} from './workspace-discovery.mjs';
const policy={projects:'all',git:'personal',agents:'personal',sessions:'private'};
function fixture({actor='owner',member=true,epoch='first',org='org',previous=null,direct=[],organizationGrant={role:'member',permissions:policy,access_version:1}}={}){
 const queries=[];const workspace={id:'workspace',owner_id:'owner',organization_id:org,state:'ready',desired_state:'running',generation:1,sharing_generation:1,provider:'lightsail'};
 return {queries,query:async(sql,values)=>{queries.push({sql,values});
  if(sql.startsWith('SELECT w.id'))return {rows:[workspace]};
  if(sql.startsWith('SELECT w.organization_id'))return {rows:[{organization_id:org,organization_name:org?'Engineering':null}]};
  if(sql.includes('FROM workspace WHERE'))return {rows:[workspace]};
  if(sql.includes('FROM organization_member'))return {rows:member?[{joined_at:epoch}]:[]};
  if(sql.includes('FROM workspace_member'))return {rows:direct};
  if(sql.includes('FROM workspace_team_access'))return {rows:[]};
  if(sql.startsWith('SELECT id FROM organization'))return {rows:[{id:org}]};
  if(sql.startsWith('SELECT role,permissions FROM workspace_organization_access'))return {rows:previous?[previous]:[]};
  if(sql.includes('FROM workspace_organization_access'))return {rows:organizationGrant?[{...organizationGrant,organization_id:org,name:'Engineering',organization_name:'Engineering'}]:[]};
  if(sql.startsWith('SELECT action'))return {rows:[]};
  if(sql.startsWith('INSERT')||sql.startsWith('UPDATE'))return {rows:[]};
  throw Error('Unexpected query '+sql);
 }};
}
const input={workspaceId:'workspace',organizationId:'org',action:'grant',role:'member',permissions:policy};
test('organization-wide assignment inserts one live grant and audit, never fans out member grants',async()=>{
 const db=fixture();assert.deepEqual(await changeWorkspaceOrganizationGrant(db,'owner',input),{ok:true});
 const write=db.queries.find(q=>q.sql.startsWith('INSERT INTO workspace_organization_access'));
 assert.deepEqual(write.values.slice(0,3),['workspace','org','member']);
 assert.match(write.sql,/access_version=workspace_organization_access.access_version\+1/);
 assert.equal(db.queries.some(q=>q.sql.startsWith('INSERT INTO workspace_member')),false);
 assert.equal(db.queries.at(-1).values[2],'organization-grant');
});
test('Everyone listing exposes current organization name and grant',async()=>{
 const result=await listWorkspaceOrganizationGrants(fixture(),'owner','workspace');
 assert.equal(result.organizationId,'org');assert.equal(result.organizationName,'Engineering');assert.equal(result.grant.role,'member');
 const empty=await listWorkspaceOrganizationGrants(fixture({org:null}),'owner','workspace');assert.equal(empty.grant,null);
});
test('only this workspace organization can be granted; personal workspace requires organization first',async()=>{
 await assert.rejects(()=>changeWorkspaceOrganizationGrant(fixture(),'owner',{...input,organizationId:'foreign'}),e=>e.status===404);
 await assert.rejects(()=>changeWorkspaceOrganizationGrant(fixture({org:null}),'owner',input),e=>e.status===409);
});
test('non-administrators cannot create Everyone access or list assignments',async()=>{
 const db=fixture();await assert.rejects(()=>changeWorkspaceOrganizationGrant(db,'member',input),e=>e.status===403);
 await assert.rejects(()=>listWorkspaceOrganizationGrants(db,'member','workspace'),e=>e.status===403);
 assert.equal(db.queries.some(q=>q.sql.startsWith('INSERT')),false);
});
test('selected project admin cannot widen new grant, remove a broad existing grant or assign admin',async()=>{
 const admin={role:'admin',permissions:{projects:'selected',projectIds:['app']},access_version:1};
 for(const patch of [{}, {action:'revoke'}, {role:'admin',permissions:admin.permissions}]){
  const db=fixture({direct:[admin],organizationGrant:null,previous:patch.action==='revoke'?{role:'viewer',permissions:policy}:null});
  await assert.rejects(()=>changeWorkspaceOrganizationGrant(db,'admin',{...input,...patch}),e=>[400,403].includes(e.status));
  assert.equal(db.queries.some(q=>q.sql.startsWith('UPDATE')||q.sql.startsWith('INSERT')),false);
 }
});
test('owner revocation increments access epoch and preserves independent grants',async()=>{
 const db=fixture({previous:{role:'member',permissions:policy}});
 await changeWorkspaceOrganizationGrant(db,'owner',{...input,action:'revoke'});
 assert.match(db.queries.find(q=>q.sql.startsWith('UPDATE')).sql,/access_version=access_version\+1/);
 const remaining=await workspaceAccess(fixture({organizationGrant:null,direct:[{role:'viewer',permissions:policy}]}),'workspace','member');
 assert.deepEqual(remaining.map(g=>g.source),['direct']);
});
test('future organization members inherit dynamically; removal denies and rejoin changes credential epoch',async()=>{
 const first=await workspaceAccess(fixture(),'workspace','future-member');assert.deepEqual(first.map(g=>g.source),['organization']);
 assert.deepEqual(await workspaceAccess(fixture({member:false}),'workspace','future-member'),[]);
 const rejoined=await workspaceAccess(fixture({epoch:'second'}),'workspace','future-member');
 assert.notEqual(accessVersion(first,1),accessVersion(rejoined,1));
 assert.notEqual(accessVersion(first,1),accessVersion([{...first[0],access_version:2}],1));
});
test('discovery includes organization-granted workspace and reports organization source',async()=>{
 const db=fixture();const [result]=await discoverWorkspaces(db,'member');
 assert.match(db.queries[0].sql,/workspace_organization_access a JOIN organization_member/);
 assert.equal(result.access.sources[0].source,'organization');assert.equal(result.access.sources[0].organizationId,'org');assert.equal(result.access.canWrite,true);
 assert.deepEqual(await discoverWorkspaces(fixture({member:false}),'member'),[]);
});
test('team and person revocation also preserve grants outside a selected admin policy',async()=>{
 const {changeWorkspaceTeamGrant}=await import('./workspace-team-grants.mjs');const {changeWorkspacePersonGrant}=await import('./workspace-person-grants.mjs');
 for(const [change,target] of [[changeWorkspaceTeamGrant,{teamId:'team'}],[changeWorkspacePersonGrant,{userId:'person'}]]){
  const writes=[];const db={query:async(sql,values)=>{
   if(sql.includes('FROM workspace WHERE'))return {rows:[{id:'workspace',owner_id:'owner',organization_id:'org'}]};
   if(sql.includes('FROM organization_member'))return {rows:[{joined_at:'first'}]};
   if(sql.startsWith('SELECT role,permissions FROM'))return {rows:[{role:'viewer',permissions:policy}]};
   if(sql.includes('FROM workspace_member'))return {rows:[{role:'admin',permissions:{projects:'selected',projectIds:['app']}}]};
   if(sql.includes('FROM workspace_team_access')||sql.includes('FROM workspace_organization_access'))return {rows:[]};
   if(sql.startsWith('SELECT id FROM team'))return {rows:[{id:'team'}]};
   writes.push({sql,values});return {rows:[]};
  }};
  await assert.rejects(()=>change(db,'admin',{workspaceId:'workspace',action:'revoke',...target}),e=>e.status===403);assert.deepEqual(writes,[]);
 }
});
