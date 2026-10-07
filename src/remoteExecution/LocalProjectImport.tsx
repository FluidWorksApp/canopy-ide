import {Button,Checkbox} from '../components/ui';
import {useState} from 'react';
import {invoke as localInvoke} from '@tauri-apps/api/core';
import {invoke} from '../host';
import type {Project,WorkspaceState} from '../projects';
import {newProjectId,newComponentId} from '../projects';
type ComponentSource={key:string;index:number;label:string;path:string;url:string;repository:string;relative:string;error?:string};
type Source={project:Project;components:ComponentSource[]};
export function LocalProjectImport(){
 const [sources,setSources]=useState<Source[]>([]),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[commands,setCommands]=useState(false);
 async function inspect(){setBusy(true);setNotice('');try{
  const store=JSON.parse(await localInvoke<string>('store_load')) as WorkspaceState;const result:Source[]=[];
  for(const project of store.projects){const source:Source={project,components:[]};
   for(const [index,component] of project.components.entries()){
    const item:ComponentSource={key:`${project.id}:${component.id}`,index,label:component.label,path:component.path,url:'',repository:'',relative:''};
    try{
     const canonical=await localInvoke<string>('workspace_add',{path:component.path});
     const repos=await localInvoke<Array<{path:string}>>('git_repos',{components:[[component.id,canonical]]});
     const repository=repos[0]?.path;if(!repository)throw Error('This folder is not a Git repository');
     await localInvoke('workspace_add',{path:repository});
     const url=await localInvoke<string>('git_remote_url',{repo:repository});if(!url)throw Error('No Git origin is configured');
     if(canonical!==repository&&!canonical.startsWith(repository+'/'))throw Error('Folder is outside its repository');
     Object.assign(item,{url,repository,relative:canonical===repository?'':canonical.slice(repository.length+1)});
    }catch(error){const message=String(error).replace(/^Error: /,'');item.error=/No such file|os error 2/.test(message)?'Saved folder no longer exists on this device':message;}
    source.components.push(item);
   }
   result.push(source);
  }
  setSources(result);setSelected(old=>old.filter(key=>result.some(s=>s.components.some(c=>c.key===key&&!c.error))));
 }catch(e){setNotice(String(e));}finally{setBusy(false);}}
 async function copy(){setBusy(true);setNotice('');try{
  const store=JSON.parse(await invoke<string>('store_load')) as WorkspaceState;
  for(const source of sources.filter(s=>s.components.some(c=>selected.includes(c.key)))){
   const id=newProjectId(),parent='/workspace/'+id;await invoke('fs_create_dir',{path:parent});const cloned=new Map<string,string>();const components=[];
   for(let i=0;i<source.components.length;i++){const component=source.components[i];if(!selected.includes(component.key)||component.error)continue;let repo=cloned.get(component.repository);if(!repo){setNotice(`Cloning ${source.project.name} · ${component.label}…`);const cloneParent=parent+'/repo-'+(cloned.size+1);await invoke('fs_create_dir',{path:cloneParent});const result=await invoke<{path:string}>('git_clone',{parent:cloneParent,url:component.url});repo=result.path;cloned.set(component.repository,repo);}
    const path=repo+(component.relative?'/'+component.relative:'');await invoke('fs_stat',{path});components.push({id:newComponentId(),label:component.label,path,...(commands?{commands:source.project.components[component.index].commands}: {})});
   }
   store.projects.push({id,name:source.project.name,components});store.openIds.push(id);store.activeId=id;
   await invoke('store_save',{data:JSON.stringify(store)});
  }
  window.location.reload();
 }catch(e){setNotice(`Import stopped: ${String(e)}. Completed projects are saved; any cloned folders remain available in /workspace.`);}finally{setBusy(false);}}
 const chosen=sources.filter(s=>s.components.some(c=>selected.includes(c.key))).length;
 return <details className="workspace-import"><summary>Import local projects</summary><p className="workspace-description">Choose projects and the repositories to include. Each project keeps its component grouping. Only checked components are cloned; local edits and environment files stay on this device.</p><Button disabled={busy} onClick={()=>void inspect()}>{busy?'Checking projects…':sources.length?'Refresh local projects':'Find local projects'}</Button><div className="workspace-import-list">{sources.map(source=>{
 const available=source.components.filter(c=>!c.error);const count=available.filter(c=>selected.includes(c.key)).length;
 return <section className="workspace-import-item" key={source.project.id}><div className="workspace-import-project"><Checkbox disabled={busy||!available.length} checked={!!available.length&&count===available.length} onChange={checked=>setSelected(v=>checked?[...new Set([...v,...available.map(c=>c.key)])]:v.filter(key=>!source.components.some(c=>c.key===key)))} label={source.project.name}/><span>{count} of {source.components.length} selected</span></div><div className="workspace-import-components">{source.components.map(component=><div className="workspace-import-component" key={component.key}><Checkbox disabled={busy||!!component.error} checked={selected.includes(component.key)} onChange={checked=>setSelected(v=>checked?[...v,component.key]:v.filter(key=>key!==component.key))} label={component.label}/><small title={component.path}>{component.error??component.url}</small></div>)}</div></section>;
 })}</div>{!!sources.length&&<div className="workspace-import-footer"><Checkbox disabled={busy} checked={commands} onChange={setCommands} label="Include project run commands"/><Button variant="accent" disabled={busy||!selected.length} onClick={()=>void copy()}>Import {chosen||'selected'} {chosen===1?'project':'projects'}</Button></div>}{notice&&<p role="status">{notice}</p>}</details>;
}
