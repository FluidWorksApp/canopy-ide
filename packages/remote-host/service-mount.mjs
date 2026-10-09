import {validId} from './policy.mjs';
// The one bind mount a workspace container may carry: its own Canopy service
// socket directory, read-only. Every other mount stays a Docker volume.
export const SERVICE_SOCKET_ROOT='/run/canopy-service/ws';
export const SERVICE_CONTAINER_DIR='/run/canopy-ctx';
export function serviceMountSource(workspaceId){
 if(!validId(workspaceId))throw Error('Invalid service workspace');
 return `${SERVICE_SOCKET_ROOT}/${workspaceId}`;
}
export function serviceMountArgs(workspace){
 return ['--mount',`type=bind,source=${serviceMountSource(workspace.id)},target=${SERVICE_CONTAINER_DIR},readonly,bind-propagation=rprivate`];
}
const isServiceDestination=mount=>mount?.Destination===SERVICE_CONTAINER_DIR;
/** Mounts minus a service mount, for the volume-only comparisons. */
export function volumeMounts(mounts){return (mounts??[]).filter(mount=>!isServiceDestination(mount));}
/** true when the container carries exactly this workspace's service mount,
 *  false when it predates the service; anything else is drift. */
export function verifyServiceMount(workspace,mounts){
 const found=(mounts??[]).filter(isServiceDestination);
 if(!found.length)return false;
 const [mount]=found;
 if(found.length!==1||workspace.memberId||workspace.parentWorkspaceId||mount.Type!=='bind'||mount.Source!==serviceMountSource(workspace.id)||mount.RW!==false||(mount.Propagation??'rprivate')!=='rprivate')throw Error('Workspace service mount differs; administrator action required');
 return true;
}
