import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
// The owner's project list, as members see it. Members share the owner's
// project volume at the same /workspace path, but the owner's project store
// lives in the owner's private home. The host keeps a sanitized copy whenever
// the owner loads or saves it: only ids, names, labels and paths inside
// /workspace. Commands, environment, accounts and anything outside /workspace
// never leave the owner's home.
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const label=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200&&!/[\x00-\x1f]/.test(value);
const workspacePath=value=>typeof value==='string'&&value.length<=1024&&(value==='/workspace'||value.startsWith('/workspace/'))&&!/[\\\x00-\x1f]/.test(value)&&value.split('/').slice(2).every(part=>part&&part!=='.'&&part!=='..')&&!value.startsWith('/workspace/projects/');
export function sanitizeOwnerProjects(store){
 const projects=Array.isArray(store?.projects)?store.projects:[];const seen=new Set();const result=[];
 for(const project of projects.slice(0,128)){
  if(!project||project.sharedWorkspaceId||!identifier(project.id)||seen.has(project.id)||!label(project.name)||!Array.isArray(project.components))continue;
  const ids=new Set();
  const components=project.components.slice(0,64).filter(c=>c&&identifier(c.id)&&!ids.has(c.id)&&label(c.label??c.id)&&workspacePath(c.path)&&ids.add(c.id)).map(c=>({id:c.id,label:c.label??c.id,path:c.path}));
  if(!components.length)continue;
  seen.add(project.id);result.push({id:project.id,name:project.name,components});
 }
 return result;
}
export class SharedCatalog{
 constructor({directory}){this.directory=directory;this.cache=new Map();}
 file(workspaceId){if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspaceId))throw Error('Invalid workspace');return join(this.directory,workspaceId+'.json');}
 async update(workspaceId,serialized){
  let store;try{store=typeof serialized==='string'?JSON.parse(serialized):serialized;}catch{return;}
  const projects=sanitizeOwnerProjects(store),data=JSON.stringify(projects);
  if(this.cache.has(workspaceId)&&JSON.stringify(this.cache.get(workspaceId))===data)return;
  this.cache.set(workspaceId,projects);
  await mkdir(this.directory,{recursive:true,mode:0o700});
  const target=this.file(workspaceId),temporary=`${target}.${randomUUID()}.next`;let handle;
  try{handle=await open(temporary,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=null;await rename(temporary,target);}
  finally{await handle?.close();await unlink(temporary).catch(()=>{});}
 }
 async get(workspaceId){
  if(this.cache.has(workspaceId))return this.cache.get(workspaceId);
  let projects=[];try{projects=sanitizeOwnerProjects({projects:JSON.parse(await readFile(this.file(workspaceId),'utf8'))});}catch(error){if(error.code!=='ENOENT')projects=[];}
  this.cache.set(workspaceId,projects);return projects;
 }
 /** Definitions in the same shape as legacy shared projects, for a member store. */
 async definitions(workspaceId,{readOnly}){
  return (await this.get(workspaceId)).map(p=>({id:p.id,name:p.name,sharedWorkspaceId:workspaceId,readOnly,components:p.components}));
 }
}
