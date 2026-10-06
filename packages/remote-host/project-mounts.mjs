import {createHash} from 'node:crypto';

// This input comes from the trusted host catalog and current access authority,
// never from a container response or a browser-supplied filesystem path.
export function projectMounts(workspace) {
  const projects = workspace.projectMounts ?? [];
  if (!Array.isArray(projects) || projects.length > 128) throw Error('Invalid project mounts');
  const seen = new Set();
  const owner = workspace.parentWorkspaceId ?? workspace.id;
  if (typeof owner !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(owner)) throw Error('Invalid project workspace');
  return projects.map(project => {
    if (!project || typeof project.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(project.id) ||
        seen.has(project.id) || typeof project.writable !== 'boolean') throw Error('Invalid project mount');
    seen.add(project.id);
    const key = createHash('sha256').update(JSON.stringify([owner, project.id])).digest('hex');
    return [`/workspace/projects/${project.id}`, `canopy-shared-project-${key}`, project.writable];
  }).sort((a,b) => a[0].localeCompare(b[0]));
}

export function validateProjectAccess(access){
  if(!access||typeof access.allRead!=='boolean'||typeof access.allWrite!=='boolean'||
     access.allWrite&&!access.allRead||!Array.isArray(access.selected)||access.selected.length>128)throw Error('Invalid project access');
  const ids=new Set();
  for(const item of access.selected){
    if(!item||typeof item.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(item.id)||typeof item.writable!=='boolean'||ids.has(item.id))throw Error('Invalid project access');
    ids.add(item.id);
  }
  return access;
}

export function grantedProjects(workspace,access){
  if(!access)return [];
  validateProjectAccess(access);
  projectMounts(workspace); // validate trusted catalog before resolving it
  const selected=new Map(access.selected.map(item=>[item.id,item.writable]));
  return (workspace.projectMounts??[]).filter(item=>access.allRead||selected.has(item.id))
    .map(item=>({id:item.id,...(item.name!==undefined?{name:item.name}:{}),...(item.components!==undefined?{components:item.components}:{}),writable:item.writable&&(access.allWrite||selected.get(item.id)===true)}));
}
