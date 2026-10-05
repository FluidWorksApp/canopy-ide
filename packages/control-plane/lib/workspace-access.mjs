import {permits,sharingPolicy} from './team-policy.mjs';

// Evaluate each grant independently. Never union scopes before checking roles:
// a workspace-wide viewer plus a project developer is not a workspace developer.
export function allowsWorkspaceAccess(grants,{action,projectId,resource}={}) {
 return grants.some(grant=>{
  if(!permits(grant.role,action))return false;
  if(grant.role==='owner')return true;
  const policy=sharingPolicy(grant.permissions);
  if(projectId && policy.projects!=='all' && !policy.projectIds.includes(projectId))return false;
  if(resource==='git' && policy.git!=='shared')return false;
  if(resource==='agents' && policy.agents!=='shared')return false;
  if(resource==='sessions:view' && !['view','interact'].includes(policy.sessions))return false;
  if(resource==='sessions:interact' && policy.sessions!=='interact')return false;
  if(resource && !['git','agents','sessions:view','sessions:interact'].includes(resource))return false;
  return true;
 });
}

export async function workspaceAccess(db,workspaceId,userId){
 const workspace=(await db.query('SELECT owner_id,organization_id FROM workspace WHERE id=$1 AND deleted_at IS NULL',[workspaceId])).rows[0];
 if(!workspace)return [];
 if(workspace.owner_id===userId)return [{source:'owner',role:'owner',permissions:{projects:'all'}}];
 // For organizational workspaces, removal from the organization cuts off direct
 // grants too. Personal workspaces retain their existing direct-member model.
 const membership=workspace.organization_id?(await db.query('SELECT joined_at FROM organization_member WHERE organization_id=$1 AND user_id=$2 AND removed_at IS NULL',[workspace.organization_id,userId])).rows[0]:null;
 if(workspace.organization_id&&!membership)return [];
 const direct=(await db.query(`SELECT role,permissions,access_version FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`,[workspaceId,userId])).rows.map(row=>({...row,source:'direct',organizationJoinedAt:membership?.joined_at??null}));
 if(!workspace.organization_id)return direct;
 const teams=(await db.query(`SELECT a.role,a.permissions,a.access_version,m.joined_at AS team_joined_at,t.id AS team_id,t.name AS team_name
 FROM workspace_team_access a JOIN team t ON t.id=a.team_id
 JOIN team_member m ON m.team_id=t.id AND m.user_id=$2 AND m.removed_at IS NULL
 WHERE a.workspace_id=$1 AND a.revoked_at IS NULL AND t.organization_id=$3`,[workspaceId,userId,workspace.organization_id])).rows.map(row=>({...row,source:'team',organizationJoinedAt:membership?.joined_at??null}));
 return [...direct,...teams];
}
