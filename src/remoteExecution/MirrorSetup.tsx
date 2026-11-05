import {useRef,useState} from 'react';
import {invoke as tauriInvoke} from '@tauri-apps/api/core';
import {invoke as hostInvoke} from '../host';
import {Button,Checkbox} from '../components/ui';
import {runMirror,STAYS_ON_MAC,type MirrorProgress,type MirrorStep,type RepoResult} from './mirror';

// This Mac's native commands, and the selected workspace's host.
const local=<T,>(command:string,args?:Record<string,unknown>)=>tauriInvoke<T>(command,args);
const remote=<T,>(command:string,args?:Record<string,unknown>)=>hostInvoke<T>(command,args);

const MARK:Record<MirrorStep['state'],string>={pending:'○',running:'…',done:'✓',skipped:'–',failed:'✕'};
const tone=(state:string)=>state==='failed'?'attention':state==='done'?'running':'quiet';

function Repo({repo}:{repo:RepoResult}){
 return <li className="mirror-repo">
  <div><strong>{repo.name}</strong> <span className={`account-sync-state ${tone(repo.state)}`}>{repo.state==='running'?repo.stage??'Working…':repo.state==='done'?'Ready':repo.state==='failed'?'Needs attention':repo.state}</span></div>
  {repo.carried.length>0&&<small>{repo.carried.join(' · ')}</small>}
  {repo.detail&&<small className="mirror-problem">{repo.detail}</small>}
  {repo.problems.map((problem,i)=><small key={`p${i}`} className="mirror-problem">{problem}</small>)}
  {repo.notes.map((note,i)=><small key={`n${i}`}>{note}</small>)}
  {repo.installs.map((install,i)=><small key={`i${i}`}>{install.tool} in {install.cwd}: {install.state}</small>)}
 </li>;
}

/** Make the selected workspace match this Mac: logins, projects, branches and
 * work in progress, then dependencies. Nothing is sent until the button is
 * pressed, and env files only when that box is ticked. */
export function MirrorSetup({workspaceName,disabled=false}:{workspaceName:string;disabled?:boolean}){
 const [includeEnv,setIncludeEnv]=useState(false),[install,setInstall]=useState(true);
 const [progress,setProgress]=useState<MirrorProgress|null>(null);
 const [running,setRunning]=useState(false),[error,setError]=useState('');
 const abort=useRef<AbortController|null>(null);
 async function start(){
  const controller=new AbortController();abort.current=controller;
  setRunning(true);setError('');setProgress(null);
  try{await runMirror({local,remote,signal:controller.signal},{includeEnv,install},setProgress);}
  catch(e){setError(String((e as {message?:string})?.message??e));}
  finally{abort.current=null;setRunning(false);}
 }
 const failed=progress?.done&&progress.projects.some(p=>p.state==='failed');
 return <div className="mirror-setup">
  <p className="workspace-description">Copy your projects from this Mac into {workspaceName}: each repository on the same branch and commit, with unpushed commits, staged and unstaged changes and new files, then reinstall dependencies. This also copies your Claude, Codex and GitHub logins, replacing the workspace’s.</p>
  <details><summary>What stays on this Mac</summary><ul>{STAYS_ON_MAC.map(item=><li key={item}>{item}</li>)}</ul></details>
  <Checkbox checked={includeEnv} disabled={running} onChange={setIncludeEnv} label="Include .env and other credential files" hint="Sends .env files, private keys and similar files, including ones git does not track. Off by default."/>
  <Checkbox checked={install} disabled={running} onChange={setInstall} label="Install dependencies in the workspace" hint="Runs each project’s package manager. Existing installs are left alone."/>
  <div className="account-sync-footer">
   <small>Projects already set up here are skipped.</small>
   {running
    ?<Button disabled={abort.current?.signal.aborted} onClick={()=>abort.current?.abort()}>Stop after this repository</Button>
    :<Button variant="accent" disabled={disabled} onClick={()=>void start()}>Set up from this Mac</Button>}
  </div>
  {progress&&<ul className="mirror-steps" aria-label="Setup progress">{progress.steps.map(step=><li key={step.key}><span aria-hidden="true">{MARK[step.state]}</span> {step.label}{step.detail&&<small> · {step.detail}</small>}</li>)}</ul>}
  {progress?.projects.map((project,i)=><section key={i} className="mirror-project">
   <strong>{project.name}</strong> <span className={`account-sync-state ${tone(project.state)}`}>{project.state==='done'?'Set up':project.state==='skipped'?'Skipped':project.state==='failed'?'Needs attention':'Working…'}</span>
   {project.detail&&<small className={project.state==='failed'?'mirror-problem':undefined}>{project.detail}</small>}
   <ul>{project.repos.map((repo,j)=><Repo key={j} repo={repo}/>)}</ul>
  </section>)}
  {progress?.done&&!error&&<p className={`workspace-feedback${failed?' error':''}`} role="status">{failed?'Some work could not be set up. Fix what is listed and run it again; finished projects are skipped.':'✓ Your projects are set up in this workspace.'}</p>}
  {error&&<p className="workspace-feedback error" role="alert">{error}</p>}
 </div>;
}
