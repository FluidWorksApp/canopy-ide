import {createHash} from 'node:crypto';
import {grantedProjects} from './project-mounts.mjs';
// Derive internal resource names from authenticated identity, never request paths.
// Each member gets a distinct home, project volume, network and runner credential.
export function memberRuntime(workspace,principal,access){
 if(!principal.memberId)return workspace;
 if(typeof principal.memberId!=='string'||principal.memberId.length<1||principal.memberId.length>256)throw Error('Invalid member identity');
 if(principal.workspaceId!==workspace.id)throw Error('Forbidden');
 if(!/^canopy-[a-z0-9]+\.slice$/.test(workspace.cgroupParent??''))throw Error('Shared workspace capacity is not configured');
 if(principal.scope==='view')throw Error('Viewer execution is not allowed');
 const key=createHash('sha256').update(JSON.stringify([workspace.id,principal.memberId])).digest('hex').slice(0,40);
 const {ownerImage,...shared}=workspace;
 return {...shared,id:`member-${key}`,accounts:[],projectMounts:grantedProjects(workspace,access),parentWorkspaceId:workspace.id,memberId:principal.memberId};
}
