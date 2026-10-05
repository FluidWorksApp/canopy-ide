import {workspaceAccess,allowsWorkspaceAccess} from './workspace-access.mjs';
import {canDelegateWorkspacePolicy} from './delegation.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const label=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200&&!/[\x00-\x1f]/.test(value);
// The catalog is management-owned. Never discover sharing authority from a
// developer-controlled project store, path, runner reply, or request body.
export async function workspaceProjectCatalog(db,actorId,workspaceId,{load}){
 const access=await workspaceAccess(db,workspaceId,actorId);
 if(!allowsWorkspaceAccess(access,{action:'invite'}))fail(403,'You cannot manage access to this workspace');
 const workspace=(await db.query('SELECT id,state,desired_state,endpoint,instance_name FROM workspace WHERE id=$1 AND deleted_at IS NULL',[workspaceId])).rows[0];
 if(!workspace)fail(404,'Workspace not found');
 if(workspace.state!=='ready'||workspace.desired_state!=='running'||!workspace.endpoint)fail(409,'Start the workspace to load its projects');
 let response;try{response=await load(workspace);}catch{fail(503,'Projects could not be loaded. Try again shortly');}
 const projects=response?.projects;
 if(!Array.isArray(projects)||projects.length>128)fail(502,'Workspace project catalog is invalid');
 const seen=new Set();
 const safe=projects.map(p=>{
  if(!p||!id(p.id)||seen.has(p.id)||!label(p.name)||!Array.isArray(p.components)||p.components.length<1||p.components.length>64)fail(502,'Workspace project catalog is invalid');
  seen.add(p.id);const componentIds=new Set();
  return {id:p.id,name:p.name,components:p.components.map(c=>{
   if(!c||!id(c.id)||componentIds.has(c.id)||!label(c.name))fail(502,'Workspace project catalog is invalid');
   componentIds.add(c.id);return {id:c.id,name:c.name};
  })};
 });
 return {projects:safe.filter(p=>canDelegateWorkspacePolicy(access,{projects:'selected',projectIds:[p.id]}))};
}
