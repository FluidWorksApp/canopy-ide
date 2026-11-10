import {useEffect,useRef,useState} from 'react';
import {invoke as tauriInvoke} from '@tauri-apps/api/core';
import {invoke as hostInvoke} from '../host';
import {mirrorCandidates,type MirrorCandidate,type MirrorCandidateCategory} from '../ipc';
import {Button,Checkbox} from '../components/ui';
import {ensureProjectOnRemote,type MirrorProgress} from './mirror';
import {MirrorProgressView} from './MirrorSetup';

const local=<T,>(command:string,args?:Record<string,unknown>)=>tauriInvoke<T>(command,args);
const remote=<T,>(command:string,args?:Record<string,unknown>)=>hostInvoke<T>(command,args);

const GROUPS:{category:MirrorCandidateCategory;title:string}[]=[{category:'secret',title:'Secrets'},{category:'config',title:'Config'},{category:'data',title:'Data'},{category:'other',title:'Other'}];
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1048576?`${Math.round(bytes/1024)} KB`:`${(bytes/1048576).toFixed(1)} MB`;

/** Set up ONE project on the selected workspace, on demand. Lists the
 * git-ignored files on this Mac (names and sizes only) so the person picks
 * which to copy; credential-shaped ones start unchecked. Nothing is sent until
 * the button is pressed. */
export function ProjectSetupDialog({projectId,projectName,workspaceName,components,disabled=false,onComplete,remoteInvoke}:{projectId:string;projectName:string;workspaceName:string;components:{componentId:string;label:string}[];disabled?:boolean;onComplete?:(ok:boolean)=>void;
 /** Run workspace commands here instead of on the window's live host: a temporary connection to another workspace (temporaryWorkspace.ts). */
 remoteInvoke?:<T>(command:string,args?:Record<string,unknown>)=>Promise<T>}){
 const [files,setFiles]=useState<Record<string,MirrorCandidate[]>>({});
 const [chosen,setChosen]=useState<Record<string,string[]>>({});
 const [install,setInstall]=useState(true);
 const [progress,setProgress]=useState<MirrorProgress|null>(null);
 const [running,setRunning]=useState(false),[error,setError]=useState('');
 const abort=useRef<AbortController|null>(null);
 useEffect(()=>{
  let live=true;
  (async()=>{
   try{
    const found:Record<string,MirrorCandidate[]>={},picked:Record<string,string[]>={};
    for(const c of components){
     const result=await mirrorCandidates(projectId,c.componentId);
     found[c.componentId]=result.files;
     picked[c.componentId]=result.files.filter(f=>f.category!=='secret').map(f=>f.path);
    }
    if(live){setFiles(found);setChosen(picked);}
   }catch(e){if(live)setError(String((e as {message?:string})?.message??e));}
  })();
  return ()=>{live=false;};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[projectId]);
 const toggle=(componentId:string,path:string,on:boolean)=>setChosen(old=>({...old,[componentId]:on?[...(old[componentId]??[]),path]:(old[componentId]??[]).filter(p=>p!==path)}));
 async function start(){
  const controller=new AbortController();abort.current=controller;
  setRunning(true);setError('');setProgress(null);
  onComplete?.(false);
  try{
   const final=await ensureProjectOnRemote({local,remote:remoteInvoke??remote,signal:controller.signal},{projectId,componentIds:components.map(c=>c.componentId),selectedFiles:chosen,install},setProgress);
   onComplete?.(final.projects.length>0&&!final.projects.some(p=>p.state==='failed'));
  }
  catch(e){setError(String((e as {message?:string})?.message??e));}
  finally{abort.current=null;setRunning(false);}
 }
 const failed=progress?.done&&progress.projects.some(p=>p.state==='failed');
 return <div className="mirror-setup" role="group" aria-label={`Set up ${projectName} on ${workspaceName}`}>
  <p className="workspace-description">Copy {projectName} to {workspaceName}: the repository on the same branch with your unpushed commits and changes. Pick any git-ignored files it also needs. Only names and sizes are listed here; files are read when you press the button.</p>
  {components.map(c=>{
   const list=files[c.componentId]??[];
   return <section key={c.componentId} className="mirror-project">
    <strong>{c.label}</strong>
    {GROUPS.map(({category,title})=>{
     const group=list.filter(f=>f.category===category);
     if(!group.length)return null;
     return <fieldset key={category} disabled={running}>
      <legend>{title}</legend>
      {category==='secret'&&<small className="mirror-problem">These look like credentials. They are copied to the workspace only if you tick them.</small>}
      {group.map(f=><Checkbox key={f.path} checked={(chosen[c.componentId]??[]).includes(f.path)} onChange={on=>toggle(c.componentId,f.path,on)} label={f.path} hint={size(f.size)}/>)}
     </fieldset>;
    })}
   </section>;
  })}
  <Checkbox checked={install} disabled={running} onChange={setInstall} label="Install dependencies in the workspace" hint="Runs the project’s package manager for new setups."/>
  <div className="account-sync-footer">
   {running
    ?<Button disabled={abort.current?.signal.aborted} onClick={()=>abort.current?.abort()}>Stop after this repository</Button>
    :<Button variant="accent" disabled={disabled} onClick={()=>void start()}>{`Set up on ${workspaceName}`}</Button>}
  </div>
  {progress&&<MirrorProgressView progress={progress}/>}
  {progress?.done&&!error&&<p className={`workspace-feedback${failed?' error':''}`} role="status">{failed?'Some work could not be set up. Fix what is listed and run it again.':'✓ Done.'}</p>}
  {error&&<p className="workspace-feedback error" role="alert">{error}</p>}
 </div>;
}
