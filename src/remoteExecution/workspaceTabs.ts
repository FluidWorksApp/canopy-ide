export type SavedWorkspaceTab={id:string;endpoint:string;workspaceId?:string;workspaceName:string};
type ManagedTab={id:string;name:string};
export type WorkspaceTab={id:string;workspaceName:string;endpoint?:string;workspaceId?:string;savedId?:string;managedId?:string};
const endpoint=(value:string)=>{try{const url=new URL(value);return url.origin+url.pathname.replace(/\/+$/,'');}catch{return value.replace(/\/+$/,'');}};
/** Managed workspace IDs are authoritative across old and current saved URLs.
 * Generic hosts retain endpoint scope, since two hosts can use the same local ID. */
export function workspaceTabId(connection:SavedWorkspaceTab,managed:ManagedTab[]):string{
 const workspaceId=connection.workspaceId??connection.id.slice(connection.id.lastIndexOf('/')+1);
 const match=managed.find(w=>w.id===workspaceId||endpoint(connection.endpoint)===`https://${w.id}.workspaces.canopyide.dev`);
 return match?`managed:${match.id}`:`${endpoint(connection.endpoint)}/${workspaceId}`;
}
export function workspaceTabs(saved:SavedWorkspaceTab[],managed:ManagedTab[],active:SavedWorkspaceTab|null,previous:WorkspaceTab[]=[]):WorkspaceTab[]{
 const byId=new Map<string,WorkspaceTab>();
 for(const connection of [...saved,...(active?[active]:[])]){
  const id=workspaceTabId(connection,managed),old=byId.get(id);
  byId.set(id,{...old,id,workspaceName:connection.workspaceName,endpoint:connection.endpoint,workspaceId:connection.workspaceId,savedId:connection.id});
 }
 for(const workspace of managed){const id=`managed:${workspace.id}`;byId.set(id,{...byId.get(id),id,workspaceName:workspace.name,managedId:workspace.id});}
 const ordered=[...previous.filter(tab=>tab.id!=='local').map(tab=>byId.has(tab.id)?tab.id:[...byId.values()].find(next=>next.savedId&&next.savedId===tab.savedId)?.id??tab.id),...byId.keys()];
 return [{id:'local',workspaceName:'Local workspace'},...[...new Set(ordered)].flatMap(id=>byId.has(id)?[byId.get(id)!]:[])];
}
