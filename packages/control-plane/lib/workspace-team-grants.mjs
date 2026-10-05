import {canDelegateWorkspacePolicy} from './delegation.mjs';
import {sharingPolicy,invitationRole,canRevoke} from './team-policy.mjs';
import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
// Caller must wrap this operation in a transaction. Lock the workspace before
// resolving authority so grant changes for the same workspace serialize.
export async function changeWorkspaceTeamGrant(db,actorId,input){
 const workspace=(await db.query('SELECT id,organization_id FROM workspace WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[input.workspaceId])).rows[0];
 if(!workspace)fail(404,'Workspace not found');
 const access=await workspaceAccess(db,input.workspaceId,actorId);
 if(!allowsWorkspaceAccess(access,{action:'invite'}))fail(403,'You cannot manage access to this workspace');
 if(!workspace.organization_id)fail(409,'Add this workspace to an organization before sharing it with teams');
 const team=(await db.query('SELECT id FROM team WHERE id=$1 AND organization_id=$2 FOR UPDATE',[input.teamId,workspace.organization_id])).rows[0];
 if(!team)fail(404,'Team not found in this organization');
 const actorRole=access.some(g=>g.role==='owner')?'owner':'admin';
 const previous=(await db.query('SELECT role FROM workspace_team_access WHERE workspace_id=$1 AND team_id=$2 AND revoked_at IS NULL',[input.workspaceId,input.teamId])).rows[0];
 if(previous&&!canRevoke(actorRole,previous.role))fail(403,'You cannot change this team’s access');
 if(input.action==='revoke'){
  await db.query('UPDATE workspace_team_access SET revoked_at=now(),access_version=access_version+1 WHERE workspace_id=$1 AND team_id=$2 AND revoked_at IS NULL',[input.workspaceId,input.teamId]);
 }else if(input.action==='grant'){
  let role,permissions;try{role=invitationRole(actorRole,input.role);permissions=sharingPolicy(input.permissions);}catch(e){fail(400,e.message);}
  if(!canDelegateWorkspacePolicy(access,permissions))fail(403,'You can only share projects and resources within your administrative access');
  await db.query(`INSERT INTO workspace_team_access(workspace_id,team_id,role,permissions) VALUES($1,$2,$3,$4)
   ON CONFLICT(workspace_id,team_id) DO UPDATE SET role=EXCLUDED.role,permissions=EXCLUDED.permissions,revoked_at=NULL,access_version=workspace_team_access.access_version+1`,[input.workspaceId,input.teamId,role,JSON.stringify(permissions)]);
 }else fail(400,'Unknown access action');
 await db.query('INSERT INTO workspace_access_audit(workspace_id,actor_id,action,subject_id) VALUES($1,$2,$3,$4)',[input.workspaceId,actorId,`team-${input.action}`,input.teamId]);
 return {ok:true};
}

export async function listWorkspaceTeamGrants(db,actorId,workspaceId){
 const access=await workspaceAccess(db,workspaceId,actorId);
 if(!allowsWorkspaceAccess(access,{action:'invite'}))fail(403,'You cannot manage access to this workspace');
 const workspace=(await db.query('SELECT organization_id FROM workspace WHERE id=$1 AND deleted_at IS NULL',[workspaceId])).rows[0];
 const grants=(await db.query(`SELECT a.team_id,t.name,a.role,a.permissions FROM workspace_team_access a JOIN team t ON t.id=a.team_id WHERE a.workspace_id=$1 AND a.revoked_at IS NULL AND t.organization_id=$2 ORDER BY t.name`,[workspaceId,workspace.organization_id])).rows;
 const teams=workspace.organization_id?(await db.query('SELECT id,name FROM team WHERE organization_id=$1 ORDER BY name',[workspace.organization_id])).rows:[];
 return {organizationId:workspace.organization_id,grants,teams,yourAccess:access};
}
