import {canDelegateWorkspacePolicy} from './delegation.mjs';
import {sharingPolicy,invitationRole,canRevoke} from './team-policy.mjs';
import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};

// Transaction required. This is a dynamic grant to current organization members,
// not a copied list of people; future members inherit it and removal cuts it off.
export async function changeWorkspaceOrganizationGrant(db,actorId,input){
 const workspace=(await db.query('SELECT id,organization_id FROM workspace WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[input.workspaceId])).rows[0];
 if(!workspace)fail(404,'Workspace not found');
 const access=await workspaceAccess(db,input.workspaceId,actorId);
 if(!allowsWorkspaceAccess(access,{action:'invite'}))fail(403,'You cannot manage access to this workspace');
 if(!workspace.organization_id)fail(409,'Add this workspace to an organization before sharing it with everyone');
 if(input.organizationId!==workspace.organization_id)fail(404,'Organization does not own this workspace');
 const organization=(await db.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE',[workspace.organization_id])).rows[0];
 if(!organization)fail(404,'Organization not found');
 const actorRole=access.some(g=>g.role==='owner')?'owner':'admin';
 const previous=(await db.query('SELECT role,permissions FROM workspace_organization_access WHERE workspace_id=$1 AND organization_id=$2 AND revoked_at IS NULL',[input.workspaceId,workspace.organization_id])).rows[0];
 if(previous&&!canRevoke(actorRole,previous.role))fail(403,'You cannot change this organization’s access');
 if(previous&&!canDelegateWorkspacePolicy(access,previous.permissions))fail(403,'You cannot change access outside your administrative projects and resources');
 if(input.action==='revoke'){
  await db.query('UPDATE workspace_organization_access SET revoked_at=now(),access_version=access_version+1 WHERE workspace_id=$1 AND organization_id=$2 AND revoked_at IS NULL',[input.workspaceId,workspace.organization_id]);
 }else if(input.action==='grant'){
  let role,permissions;try{role=invitationRole(actorRole,input.role);permissions=sharingPolicy(input.permissions);}catch(e){fail(400,e.message);}
  if(!canDelegateWorkspacePolicy(access,permissions))fail(403,'You can only share projects and resources within your administrative access');
  await db.query(`INSERT INTO workspace_organization_access(workspace_id,organization_id,role,permissions) VALUES($1,$2,$3,$4)
   ON CONFLICT(workspace_id,organization_id) DO UPDATE SET role=EXCLUDED.role,permissions=EXCLUDED.permissions,revoked_at=NULL,access_version=workspace_organization_access.access_version+1`,[input.workspaceId,workspace.organization_id,role,JSON.stringify(permissions)]);
 }else fail(400,'Unknown access action');
 await db.query('INSERT INTO workspace_access_audit(workspace_id,actor_id,action,subject_id) VALUES($1,$2,$3,$4)',[input.workspaceId,actorId,`organization-${input.action}`,workspace.organization_id]);
 return {ok:true};
}

export async function listWorkspaceOrganizationGrants(db,actorId,workspaceId){
 const access=await workspaceAccess(db,workspaceId,actorId);
 if(!allowsWorkspaceAccess(access,{action:'invite'}))fail(403,'You cannot manage access to this workspace');
 const workspace=(await db.query('SELECT w.organization_id,o.name AS organization_name FROM workspace w LEFT JOIN organization o ON o.id=w.organization_id WHERE w.id=$1 AND w.deleted_at IS NULL',[workspaceId])).rows[0];
 if(!workspace)fail(404,'Workspace not found');
 const grant=workspace.organization_id?(await db.query('SELECT a.organization_id,o.name,a.role,a.permissions FROM workspace_organization_access a JOIN organization o ON o.id=a.organization_id WHERE a.workspace_id=$1 AND a.organization_id=$2 AND a.revoked_at IS NULL',[workspaceId,workspace.organization_id])).rows[0]??null:null;
 return {organizationId:workspace.organization_id,organizationName:workspace.organization_name??null,grant,yourAccess:access};
}
