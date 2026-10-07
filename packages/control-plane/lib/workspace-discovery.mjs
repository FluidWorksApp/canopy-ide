import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';
import {memberAccessSnapshot} from './member-access.mjs';
import {canResumeShared} from './member-resume.mjs';
export async function discoverWorkspaces(db,userId){
 const candidates=(await db.query(`SELECT w.id,w.name,w.state,w.desired_state,w.cpu_min,w.cpu_max,w.memory_min_mib,w.memory_max_mib,w.plan_id,w.created_at,w.host_id,w.generation,w.sharing_generation,w.provider,w.region_id,w.storage_gib,w.observed_at,w.metered_through,w.metering_rate,w.owner_id
 FROM workspace w WHERE w.deleted_at IS NULL AND (
 w.owner_id=$1 OR EXISTS(SELECT 1 FROM workspace_member m WHERE m.workspace_id=w.id AND m.user_id=$1 AND m.revoked_at IS NULL)
 OR EXISTS(SELECT 1 FROM workspace_team_access a JOIN active_team_member m ON m.team_id=a.team_id JOIN team t ON t.id=a.team_id WHERE a.workspace_id=w.id AND a.revoked_at IS NULL AND m.user_id=$1 AND t.organization_id=w.organization_id)
 OR EXISTS(SELECT 1 FROM workspace_organization_access a JOIN organization_member m ON m.organization_id=a.organization_id WHERE a.workspace_id=w.id AND a.organization_id=w.organization_id AND a.revoked_at IS NULL AND m.user_id=$1 AND m.removed_at IS NULL)) ORDER BY w.created_at`,[userId])).rows;
 const visible=[];
 for(const workspace of candidates){
  const grants=await workspaceAccess(db,workspace.id,userId);
  if(!allowsWorkspaceAccess(grants,{action:'view'}))continue;
  const owner=workspace.owner_id===userId;
  const verified=workspace.provider==='lightsail'&&workspace.sharing_generation!=null&&String(workspace.sharing_generation)===String(workspace.generation);
  const scope=verified&&!owner?(await memberAccessSnapshot(db,workspace.id,userId))?.scope:null;
  const canConnect=owner||scope==='drive'||scope==='view';
  const canWrite=owner||scope==='drive';
  const operation=owner?null:(await db.query('SELECT action,status,generation FROM workspace_operation WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[workspace.id])).rows[0];
  const canResume=owner||canResumeShared(workspace,grants,operation);
  const {owner_id,sharing_generation,...item}=workspace;
  visible.push({...item,access:{owner,canManageAccess:allowsWorkspaceAccess(grants,{action:'invite'}),canStop:owner,canConnect,canResume,canWrite,
   sources:grants.map(g=>({source:g.source,teamId:g.team_id??null,teamName:g.team_name??null,organizationId:g.organization_id??null,organizationName:g.organization_name??null,role:g.role})),
   ...(canConnect?{}:{connectionUnavailable:verified?'You do not have development access to this workspace.':'Shared connections are being prepared for this workspace.'})}});
 }
 return visible;
}
