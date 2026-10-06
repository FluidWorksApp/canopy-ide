import {test} from 'node:test';
import assert from 'node:assert/strict';
import {organizationAction} from './organizations.mjs';
const org='11111111-1111-4111-8111-111111111111';
const team='22222222-2222-4222-8222-222222222222';
const user={id:'user',email:'user@example.invalid'};
function dbWith(responder){const calls=[];return {calls,query:async(sql,args)=>{calls.push({sql,args});return {rows:responder(sql,args)??[]};}};}
test('member cannot attach workspaces or administer teams',async()=>{
 const db=dbWith(sql=>sql.includes('SELECT role FROM organization_member')?[{role:'member'}]:[]);
 await assert.rejects(()=>organizationAction(db,user,{action:'organization-team-create',organizationId:org,name:'Eng'}),e=>e.code===403);
 assert.equal(db.calls.some(q=>q.sql.startsWith('INSERT')),false);
});
test('team membership requires active organization membership',async()=>{
 const db=dbWith(sql=>sql.includes('SELECT role FROM organization_member')?[{role:'owner'}]:sql.includes('SELECT id FROM team')?[{id:team}]:[]);
 await assert.rejects(()=>organizationAction(db,user,{action:'organization-team-member-add',organizationId:org,teamId:team,userId:'outsider'}),e=>e.code===409);
 assert.equal(db.calls.some(q=>q.sql.startsWith('INSERT')),false);
});
test('organization administrator cannot seize another user workspace',async()=>{
 const db=dbWith(sql=>sql.includes('SELECT role FROM organization_member')?[{role:'admin'}]:sql.includes('SELECT owner_id')?[{owner_id:'other'}]:[]);
 await assert.rejects(()=>organizationAction(db,user,{action:'organization-workspace-attach',organizationId:org,workspaceId:'workspace'}),e=>e.code===403);
});
test('attaching a workspace cannot silently cut off current collaborators',async()=>{
 const db=dbWith(sql=>sql.includes('SELECT role FROM organization_member')?[{role:'owner'}]:sql.includes('SELECT owner_id')?[{owner_id:user.id}]:sql.includes('FROM workspace_member')?[{exists:1}]:[]);
 await assert.rejects(()=>organizationAction(db,user,{action:'organization-workspace-attach',organizationId:org,workspaceId:'workspace'}),e=>e.code===409);
 assert.equal(db.calls.some(q=>q.sql.startsWith('UPDATE workspace')),false);
});
test('invitation acceptance requires current email-bound invitation',async()=>{
 const db=dbWith(sql=>sql.includes('SELECT organization_id FROM organization_invitation')?[{organization_id:org}]:[]);
 await assert.rejects(()=>organizationAction(db,user,{action:'organization-accept',invitationId:team}),e=>e.code===404);
 assert.equal(db.calls.some(q=>q.sql.startsWith('INSERT')),false);
});
