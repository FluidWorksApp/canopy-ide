import {canDelegateWorkspacePolicy} from './delegation.mjs';
import {sharingPolicy,invitationRole,canRevoke} from './team-policy.mjs';
import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
// Transaction required. Workspace lock serializes access edits and audit records.
export async function changeWorkspacePersonGrant(db,actorId,input){
 const workspace=(await db.query('SELECT id,owner_id,organization_id FROM workspace WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[input.workspaceId])).rows[0];
 if(!workspace)fail(404,'Workspace not found');
 const access=await workspaceAccess(db,input.workspaceId,actorId);
 if(!allowsWorkspaceAccess(access,{action:'invite'}))fail(403,'You cannot manage access to this workspace');
 if(!workspace.organization_id)fail(409,'Add this workspace to an organization before sharing it');
 if(input.userId===workspace.owner_id)fail(409,'The workspace owner already has full access');
 const actorRole=access.some(g=>g.role==='owner')?'owner':'admin';
 const previous=(await db.query('SELECT role,permissions FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL',[input.workspaceId,input.userId])).rows[0];
 if(previous&&!canRevoke(actorRole,previous.role))fail(403,'You cannot change this person’s access');
 if(previous&&!canDelegateWorkspacePolicy(access,previous.permissions))fail(403,'You cannot change access outside your administrative projects and resources');
 if(input.action==='revoke'){
  await db.query('UPDATE workspace_member SET revoked_at=now(),access_version=access_version+1 WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL',[input.workspaceId,input.userId]);
 }else if(input.action==='grant'){
  const member=(await db.query('SELECT 1 FROM organization_member WHERE organization_id=$1 AND user_id=$2 AND removed_at IS NULL',[workspace.organization_id,input.userId])).rows[0];
  if(!member)fail(404,'Person not found in this organization');
  let role,permissions;try{role=invitationRole(actorRole,input.role);permissions=sharingPolicy(input.permissions);}catch(e){fail(400,e.message);}
  if(!canDelegateWorkspacePolicy(access,permissions))fail(403,'You can only share projects and resources within your administrative access');
  await db.query(`INSERT INTO workspace_member(workspace_id,user_id,role,permissions) VALUES($1,$2,$3,$4)
   ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role,permissions=EXCLUDED.permissions,revoked_at=NULL,access_version=workspace_member.access_version+1`,[input.workspaceId,input.userId,role,JSON.stringify(permissions)]);
 }else fail(400,'Unknown access action');
 await db.query('INSERT INTO workspace_access_audit(workspace_id,actor_id,action,subject_id) VALUES($1,$2,$3,$4)',[input.workspaceId,actorId,`person-${input.action}`,input.userId]);
 return {ok:true};
}
export async function listWorkspacePersonGrants(db,actorId,workspaceId){
 const access=await workspaceAccess(db,workspaceId,actorId);
 if(!allowsWorkspaceAccess(access,{action:'invite'}))fail(403,'You cannot manage access to this workspace');
 const workspace=(await db.query('SELECT organization_id,owner_id FROM workspace WHERE id=$1 AND deleted_at IS NULL',[workspaceId])).rows[0];
 const people=workspace.organization_id?(await db.query('SELECT u.id,u.name,u.email FROM organization_member m JOIN "user" u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.removed_at IS NULL AND u.id<>$2 ORDER BY u.name',[workspace.organization_id,workspace.owner_id])).rows:[];
 const grants=(await db.query('SELECT m.user_id,u.name,u.email,m.role,m.permissions FROM workspace_member m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.revoked_at IS NULL ORDER BY u.name',[workspaceId])).rows;
 return {people,grants};
}
