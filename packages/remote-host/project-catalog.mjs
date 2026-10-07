import {projectMounts} from './project-mounts.mjs';
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const label=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200&&!/[\x00-\x1f]/.test(value);
// Names and relative component paths come from the trusted host catalog. Never
// propagate run commands, environment variables or account configuration.
export function sharedProjectDefinitions(workspace){
 projectMounts(workspace);
 return (workspace.projectMounts??[]).map(project=>{
  const name=project.name??project.id;if(!label(name))throw Error('Invalid shared project name');
  const components=project.components??[{id:project.id,label:name,relativePath:'.'}];
  if(!Array.isArray(components)||!components.length||components.length>64)throw Error('Invalid shared project components');
  const ids=new Set();
  return {id:project.id,name,sharedWorkspaceId:workspace.parentWorkspaceId??workspace.id,readOnly:!project.writable,components:components.map(component=>{
   const relative=component.relativePath;
   if(!identifier(component.id)||ids.has(component.id)||!label(component.label)||typeof relative!=='string'||
      relative.length>1024||relative!=='.'&&(!relative||relative.split('/').some(part=>!part||part==='.'||part==='..'))||
      /[\\\x00-\x1f]/.test(relative))throw Error('Invalid shared project component');
   ids.add(component.id);
   return {id:component.id,label:component.label,path:`/workspace/projects/${project.id}${relative==='.'?'':'/'+relative}`};
  })};
 });
}
// `owner` adds the owner's projects on the shared /workspace volume (from the
// host's sanitized catalog) for a member of a whole-workspace share.
// A shared project opens as a tab the first time a member sees it; the
// `sharedOpened` mark travels with the member's saved copy, so a tab they
// close stays closed. With owner projects present, the default `/workspace`
// root projects are dropped: on a whole-workspace share that root is the
// owner's volume, which those projects show as raw id folders.
export function mergeSharedProjects(serialized,workspace,owner=[]){
 // A member's own store is empty until their first save.
 const parsed=serialized==null||serialized===''?null:JSON.parse(serialized);
 const store=parsed??{projects:[],openIds:[],activeId:null};
 if(!Array.isArray(store.projects))throw Error('Invalid workspace project store');
 const legacy=sharedProjectDefinitions(workspace),legacyIds=new Set(legacy.map(p=>p.id));
 const ownerShared=owner.filter(p=>!legacyIds.has(p.id)).map(p=>({...p,sharedOpened:true}));
 const shared=[...legacy,...ownerShared],ids=new Set(shared.map(p=>p.id));
 const seen=new Set(store.projects.filter(p=>p?.sharedWorkspaceId&&p.sharedOpened===true).map(p=>p.id));
 const rawRoot=p=>ownerShared.length>0&&typeof p.id==='string'&&p.id.startsWith('remote-')&&Array.isArray(p.components)&&p.components.length===1&&p.components[0]?.path==='/workspace';
 // Drop previously discovered shared projects that are no longer granted.
 const projects=[...store.projects.filter(p=>p&&!p.sharedWorkspaceId&&!ids.has(p.id)&&!rawRoot(p)),...shared];
 const available=new Set(projects.map(p=>p.id));
 const openIds=(Array.isArray(store.openIds)?store.openIds:[]).filter(id=>available.has(id));
 for(const p of ownerShared)if(!seen.has(p.id)&&!openIds.includes(p.id))openIds.push(p.id);
 return JSON.stringify({...store,projects,openIds,activeId:available.has(store.activeId)&&openIds.includes(store.activeId)?store.activeId:openIds[0]??null});
}
