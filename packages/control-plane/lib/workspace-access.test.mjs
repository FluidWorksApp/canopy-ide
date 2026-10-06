import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allowsWorkspaceAccess,workspaceAccess} from './workspace-access.mjs';
const grant=(role,projects,projectIds=[])=>({role,permissions:{projects,projectIds,git:'personal',agents:'personal',sessions:'private'}});
test('broad read never widens a narrow develop grant',()=>{
 const grants=[grant('viewer','all'),grant('member','selected',['one'])];
 assert.equal(allowsWorkspaceAccess(grants,{action:'view',projectId:'two'}),true);
 assert.equal(allowsWorkspaceAccess(grants,{action:'connect',projectId:'one'}),true);
 assert.equal(allowsWorkspaceAccess(grants,{action:'connect',projectId:'two'}),false);
 assert.equal(allowsWorkspaceAccess(grants,{action:'connect',projectId:'one',resource:'git'}),false);
});
test('credential and session permissions must belong to the grant allowing the action',()=>{
 const grants=[{...grant('viewer','all'),permissions:{projects:'all',git:'shared',sessions:'interact'}},grant('member','selected',['one'])];
 assert.equal(allowsWorkspaceAccess(grants,{action:'connect',projectId:'one',resource:'git'}),false);
 assert.equal(allowsWorkspaceAccess(grants,{action:'connect',projectId:'one',resource:'sessions:interact'}),false);
 assert.equal(allowsWorkspaceAccess(grants,{action:'connect',resource:'unknown'}),false);
});
test('direct and team access retain their sources; revocation preserves only remaining scope',async()=>{
 const db={query:async sql=>({rows:sql.includes('SELECT owner_id')?[{owner_id:'owner',organization_id:'org'}]:sql.includes('organization_member')?[{exists:1}]:sql.includes('FROM workspace_member')?[grant('viewer','all')]:sql.includes('FROM workspace_organization_access')?[]:[{...grant('member','selected',['one']),team_id:'team',team_name:'Engineering'}]})};
 const grants=await workspaceAccess(db,'workspace','member');
 assert.deepEqual(grants.map(g=>g.source),['direct','team']);
 assert.equal(allowsWorkspaceAccess(grants,{action:'connect',projectId:'one'}),true);
 assert.equal(allowsWorkspaceAccess(grants.filter(g=>g.source!=='team'),{action:'connect',projectId:'one'}),false);
});
test('organization removal denies direct and team grants without loading either',async()=>{
 const queries=[];const db={query:async sql=>{queries.push(sql);return {rows:sql.includes('SELECT owner_id')?[{owner_id:'owner',organization_id:'org'}]:[]};}};
 assert.deepEqual(await workspaceAccess(db,'workspace','removed'),[]);
 assert.equal(queries.length,2);
});
test('personal workspace ownership stays authoritative and does not acquire a team',async()=>{
 const db={query:async()=>({rows:[{owner_id:'owner',organization_id:null}]})};
 assert.equal(allowsWorkspaceAccess(await workspaceAccess(db,'workspace','owner'),{action:'billing'}),true);
});
test('grant mutation rejects outsiders before looking up teams',async()=>{
 const {changeWorkspaceTeamGrant}=await import('./workspace-team-grants.mjs');
 const queries=[];const db={query:async sql=>{queries.push(sql);return {rows:sql.includes('FOR UPDATE')?[{id:'workspace',organization_id:'org'}]:sql.includes('SELECT owner_id')?[{owner_id:'owner',organization_id:'org'}]:[]};}};
 await assert.rejects(()=>changeWorkspaceTeamGrant(db,'outsider',{workspaceId:'workspace',teamId:'team',action:'grant',role:'member'}),e=>e.status===403);
 assert.equal(queries.some(sql=>sql.includes('FROM team WHERE')),false);
});
test('owner cannot attach a team from an unrelated organization',async()=>{
 const {changeWorkspaceTeamGrant}=await import('./workspace-team-grants.mjs');
 const db={query:async sql=>({rows:sql.includes('FROM workspace WHERE')?[sql.includes('owner_id')?{owner_id:'owner',organization_id:'org'}:{id:'workspace',organization_id:'org'}]:[]})};
 await assert.rejects(()=>changeWorkspaceTeamGrant(db,'owner',{workspaceId:'workspace',teamId:'foreign',action:'grant',role:'member'}),e=>e.status===404);
});
