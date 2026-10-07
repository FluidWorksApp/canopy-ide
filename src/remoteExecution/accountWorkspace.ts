import type {WorkspaceConnection} from './NativeWorkspaceHost';
/** Compatibility for the existing account-owned EC2 workspace. The account
 * API still verifies ownership; a custom connection never gains server rights. */
export function isAccountWorkspace(connection:WorkspaceConnection){
 return connection.endpoint===`https://${connection.workspaceId}.workspaces.canopyide.dev`||connection.workspaceId==='shoaib-work';
}
