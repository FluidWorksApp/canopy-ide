/** What remote Canopy services report about their workspaces' harness stores
 * (protocol §5). Kept apart from the local stores: a remote item is keyed by
 * service, workspace and its own id, so it can never overwrite a local one. */
export type HarnessStoreName='mesh'|'notes'|'research'|'attention';
export const HARNESS_STORES:readonly HarnessStoreName[]=['mesh','notes','research','attention'];
export type RemoteItem<T=Record<string,unknown>>={key:string;service:string;workspace:string;projectId:string;item:T&{id:string}};
export const REMOTE_HARNESS_EVENT='canopy:remote-harness-changed';
/** The project id a cloud workspace's service uses for its one project. */
export const workspaceProjectId=(workspace:string)=>`ws:${workspace}`;
const sources=new Map<string,Record<HarnessStoreName,Record<string,unknown>[]>>();
const sourceKey=(service:string,workspace:string)=>JSON.stringify([service,workspace]);
const listeners=new Set<(store:HarnessStoreName)=>void>();
const changed=(store:HarnessStoreName)=>{listeners.forEach(fn=>{try{fn(store);}catch{/* one listener never blocks another */}});window.dispatchEvent(new CustomEvent(REMOTE_HARNESS_EVENT,{detail:{store}}));};
const withIds=(rows:unknown):Record<string,unknown>[]=>(Array.isArray(rows)?rows:Array.isArray((rows as {items?:unknown})?.items)?(rows as {items:unknown[]}).items:[])
 .filter((r):r is Record<string,unknown>=>!!r&&typeof r==='object'&&typeof (r as {id?:unknown}).id==='string').slice(0,2000);
export function setRemoteStore(service:string,workspace:string,store:HarnessStoreName,rows:unknown){
 const key=sourceKey(service,workspace);const current=sources.get(key)??{mesh:[],notes:[],research:[],attention:[]};
 sources.set(key,{...current,[store]:withIds(rows)});changed(store);
}
export function forgetRemoteSource(service:string,workspace:string){
 if(sources.delete(sourceKey(service,workspace)))HARNESS_STORES.forEach(changed);
}
export function remoteItems<T=Record<string,unknown>>(store:HarnessStoreName,projectId?:string):RemoteItem<T>[]{
 const out:RemoteItem<T>[]=[];
 for(const [key,stores] of sources){
  const [service,workspace]=JSON.parse(key) as [string,string],project=workspaceProjectId(workspace);
  if(projectId!==undefined&&projectId!==project)continue;
  for(const item of stores[store])out.push({key:JSON.stringify([service,workspace,item.id]),service,workspace,projectId:project,item:item as T&{id:string}});
 }
 return out;
}
export function subscribeRemoteHarness(listener:(store:HarnessStoreName)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function resetRemoteHarnessForTest(){sources.clear();}
/** A project's local rows plus what remote services reported for it; a remote row never replaces a local one with the same id. */
export function withRemote<T extends {id:string}>(store:HarnessStoreName,projectId:string,local:T[]):T[]{
 const remote=remoteItems<T>(store,projectId);if(!remote.length)return local;
 const ids=new Set(local.map(r=>r.id));const out=[...local];
 for(const r of remote)if(!ids.has(r.item.id)){ids.add(r.item.id);out.push(r.item);}
 return out;
}
