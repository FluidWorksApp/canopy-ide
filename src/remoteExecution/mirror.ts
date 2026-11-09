// "Set up from this Mac": one operation that makes the selected remote
// workspace match this Mac as closely as Git + reinstall allows: agent and
// GitHub logins, every project with its components and run commands, each
// repository on the same branch and commit with unpushed commits, staged and
// unstaged changes and new files, optionally .env files, then dependencies.
//
// `local` reaches this Mac's native commands (src-tauri/src/mirror.rs and the
// existing account/GitHub copies); `remote` reaches the selected workspace
// (packages/remote-host/mirror-apply.mjs). Nothing here reads local files.
import type {Project,WorkspaceState} from '../projects';
import {newComponentId,newProjectId} from '../projects';

export type Invoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
export interface MirrorDeps{local:Invoke;remote:Invoke;sleep?:(ms:number)=>Promise<void>;newId?:()=>string;now?:()=>number;
 /** Stops the run between repositories and stops waiting on the current one. A setup already running in the workspace finishes there. */
 signal?:AbortSignal}
export interface MirrorOptions{includeEnv:boolean;install:boolean}

/** A local component as execution_mirror_inspect reports it. */
export interface LocalComponent{projectId:string;projectName:string;componentId:string;label:string;path:string;repo?:string;relative?:string;origin?:string;head?:string;branch?:string|null;unpushed?:number;staged?:number;unstaged?:number;untracked?:number;stashes?:number;envFiles?:string[];error?:string}
type StepState='pending'|'running'|'done'|'skipped'|'failed';
export interface MirrorStep{key:string;label:string;state:StepState;detail?:string}
export interface RepoResult{name:string;components:string[];state:StepState;stage?:string;detail?:string;carried:string[];problems:string[];notes:string[];installs:{cwd:string;tool:string;state:string;detail?:string}[]}
export interface ProjectResult{name:string;state:StepState;detail?:string;repos:RepoResult[]}
export interface MirrorProgress{steps:MirrorStep[];projects:ProjectResult[];done:boolean}

type ApplyStatus={state:'running'|'complete'|'failed';phase:string;steps:{name:string;state:string;detail?:string}[];notes:string[];installs:RepoResult['installs'];error:string|null};
type SendResult={head:string;branch:string|null;upstream:string|null;relative:string;sent:{commits:boolean;staged:boolean;unstaged:boolean;files:number;envFiles:number;skipped:string[];artifacts:Record<string,number>}};

/** Always true of a mirror: said up front, not discovered later. */
export const STAYS_ON_MAC=['Installed packages such as node_modules (reinstalled in the workspace instead)','Homebrew and other macOS-only tools','Keychain secrets and logins other than Claude, Codex and GitHub','Local databases, Docker volumes and services your projects reach on this Mac’s localhost'];

const message=(error:unknown)=>String((error as {message?:string})?.message??error).replace(/^Error: /,'');
const unsupported=(error:unknown,command:string)=>message(error).includes(`does not support ${command}`);
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
/** One failed poll is a blip, not a failed setup: the job keeps running in the
 * workspace, and giving up here would strand it and fail every later repo. */
export const POLL_FAILURES_TOLERATED=5;
/** A setup that has not finished by now is not going to; stop waiting. */
export const APPLY_DEADLINE_MS=45*60000;
const ACCOUNT_SKIP=/No Claude or Codex login|no refresh token/i, GIT_SKIP=/GitHub CLI|gh auth login/i;

/** What one repository will carry, from the inspection, for the summary. */
/** Wait for the workspace's apply job. Poll errors are retried; the wait ends on completion, abort or deadline. */
async function waitForApply(deps:MirrorDeps,sleep:(ms:number)=>Promise<void>,id:string,onStatus:(status:ApplyStatus)=>void):Promise<ApplyStatus>{
 const now=deps.now??Date.now,deadline=now()+APPLY_DEADLINE_MS;
 let failures=0;
 for(;;){
  if(deps.signal?.aborted)throw Error('Setup was cancelled. A step already running in the workspace will finish there.');
  if(now()>deadline)throw Error('Setup is taking too long and was left running in the workspace; check it there.');
  try{
   const status=await deps.remote<ApplyStatus>('mirror_apply_status',{id});
   failures=0;onStatus(status);
   if(status.state!=='running')return status;
  }catch(error){
   // The workspace forgot the job (restart) or never had it: waiting more cannot help.
   if(/Setup job not found/.test(message(error))||++failures>POLL_FAILURES_TOLERATED)throw error;
  }
  await sleep(1500);
 }
}

type RemoteStore=Omit<WorkspaceState,'projects'>&{projects:(Project&{mirroredFrom?:string;mirrorIncomplete?:boolean})[]};
async function loadRemoteStore(deps:MirrorDeps){return JSON.parse(await deps.remote<string>('store_load')) as RemoteStore;}

/** Add (or replace the partial entry of) a mirrored project in the workspace store. */
async function recordProject(deps:MirrorDeps,p:{source?:Project;projectId:string;id:string;name:string;mirrored:{local:LocalComponent;path:string}[];incomplete:boolean}){
 const store=await loadRemoteStore(deps),{source,projectId,id}=p;
 // The retry replaces the earlier partial entry; its folders stay in the workspace.
 store.projects=store.projects.filter(x=>!(x.mirroredFrom===projectId&&x.mirrorIncomplete));
 store.projects.push({...(source?{...source,vibe:undefined}:{}),id,name:p.name,mirroredFrom:projectId,...(p.incomplete?{mirrorIncomplete:true}:{}),components:p.mirrored.map(({local,path})=>{const original=source?.components.find(c=>c.id===local.componentId);return {id:newComponentId(),label:local.label,path,...(original?.commands?{commands:original.commands}:{}),...(original?.role?{role:original.role}:{})};})} as Project&{mirroredFrom:string});
 store.openIds=[...(store.openIds??[]),id];store.activeId=store.activeId??id;
 await deps.remote('store_save',{data:JSON.stringify(store)});
}

export interface SendInput{id:string;path:string;projectId:string;componentId:string;relatives:string[];includeEnv:boolean;install:boolean;extraFiles?:string[];filesOnly?:boolean}
/** Package one repository on this Mac, upload it, apply it in the workspace and wait. `onStarted` fires once the workspace owns the staged files. */
async function sendAndApply(deps:MirrorDeps,sleep:(ms:number)=>Promise<void>,repo:RepoResult,input:SendInput,onStarted:()=>void,emit:()=>void){
 repo.stage='Sending work in progress';emit();
 const sent=await deps.local<SendResult>('execution_mirror_send',{id:input.id,projectId:input.projectId,componentId:input.componentId,includeEnv:input.includeEnv,...(input.extraFiles?.length?{extraFiles:input.extraFiles}:{}),...(input.filesOnly?{filesOnly:true}:{})});
 // What stayed on the Mac (stashes, over-limit files, withheld credentials) is information, not a failure.
 repo.notes.push(...sent.sent.skipped);
 repo.stage='Applying';emit();
 await deps.remote('mirror_apply_start',{id:input.id,repo:input.path,...(input.filesOnly?{filesOnly:true}:{head:sent.head,branch:sent.branch,upstream:sent.upstream}),components:input.relatives,install:input.install,expect:sent.sent.artifacts});
 onStarted();
 const status=await waitForApply(deps,sleep,input.id,status=>{repo.stage=status.phase==='dependencies'?'Installing dependencies':repo.stage;repo.installs=status.installs;emit();});
 if(status.state==='failed')throw Error(status.error??'Setup failed');
 for(const s of status.steps)(s.state==='failed'?repo.problems:repo.carried).push(s.detail??s.name);
 if(sent.sent.envFiles)repo.carried.push(`${plural(sent.sent.envFiles,'env file')} included`);
 repo.notes.push(...status.notes);
 for(const install of status.installs.filter(i=>i.state==='failed'))repo.problems.push(`${install.tool} install in ${install.cwd} failed${install.detail?`: ${install.detail.split('\n').slice(-3).join(' ')}`:''}`);
 return sent;
}

export function carriedSummary(row:LocalComponent,options:MirrorOptions){
 const parts=[row.branch?`branch ${row.branch}`:'detached commit'];
 if(row.unpushed)parts.push(plural(row.unpushed,'unpushed commit'));
 if(row.staged)parts.push(`${plural(row.staged,'staged file')}`);
 if(row.unstaged)parts.push(`${plural(row.unstaged,'changed file')}`);
 if(row.untracked)parts.push(plural(row.untracked,'new file'));
 if(options.includeEnv&&row.envFiles?.length)parts.push(plural(row.envFiles.length,'env file'));
 return parts;
}

export async function runMirror(deps:MirrorDeps,options:MirrorOptions,onProgress:(progress:MirrorProgress)=>void):Promise<MirrorProgress>{
 const sleep=deps.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
 const newId=deps.newId??(()=>crypto.randomUUID());
 const steps:MirrorStep[]=[{key:'inspect',label:'Reading projects on this Mac',state:'pending'},{key:'accounts',label:'Claude and Codex logins',state:'pending'},{key:'github',label:'GitHub login and Git identity',state:'pending'},{key:'projects',label:'Projects and work in progress',state:'pending'}];
 const progress:MirrorProgress={steps,projects:[],done:false};
 const emit=()=>onProgress({steps:steps.map(s=>({...s})),projects:progress.projects.map(p=>({...p,repos:p.repos.map(r=>({...r}))})),done:progress.done});
 const step=(key:string,state:StepState,detail?:string)=>{const s=steps.find(item=>item.key===key)!;s.state=state;s.detail=detail;emit();};

 step('inspect','running');
 const rows=await deps.local<LocalComponent[]>('execution_mirror_inspect');
 const localStore=JSON.parse(await deps.local<string>('store_load')??'null') as WorkspaceState|null;
 const usable=rows.filter(row=>!row.error);
 step('inspect','done',`${plural(new Set(rows.map(r=>r.projectId)).size,'project')}, ${plural(new Set(usable.map(r=>r.repo)).size,'repository')}`);

 // Logins first: private clones need the GitHub token in the workspace.
 step('accounts','running');
 try{const result=await deps.local<{imported?:string[];incomplete?:string[]}>('execution_remote_import_accounts');step('accounts','done',`${result.imported?.length?result.imported.join(', '):'Accounts'} copied${result.incomplete?.length?`. Sign in again on this Mac for: ${result.incomplete.join(', ')}`:''}`);}
 catch(error){step('accounts',ACCOUNT_SKIP.test(message(error))?'skipped':'failed',message(error));}
 step('github','running');
 try{await deps.local('execution_remote_import_git');step('github','done','Private repositories can be cloned');}
 catch(error){step('github',GIT_SKIP.test(message(error))?'skipped':'failed',message(error));}

 step('projects','running');
 // Older workspace runtimes can clone but not apply work in progress.
 let applies=true;
 try{await deps.remote('mirror_apply_status',{id:'00000000-0000-0000-0000-000000000000'});}
 catch(error){if(unsupported(error,'mirror_apply_status'))applies=false;}

 const remoteStore=()=>loadRemoteStore(deps);
 // A project whose last attempt had failures is retried, not skipped as done.
 const already=new Set((await remoteStore()).projects.filter(p=>p.mirroredFrom&&!p.mirrorIncomplete).map(p=>p.mirroredFrom));
 const byProject=new Map<string,LocalComponent[]>();
 for(const row of rows)byProject.set(row.projectId,[...(byProject.get(row.projectId)??[]),row]);

 for(const [projectId,components] of byProject){
  const result:ProjectResult={name:components[0].projectName||'Project',state:'running',repos:[]};progress.projects.push(result);emit();
  if(already.has(projectId)){result.state='skipped';result.detail='Already set up in this workspace';emit();continue;}
  const ready=components.filter(c=>!c.error);
  if(!ready.length){result.state='skipped';result.detail=components.map(c=>`${c.label}: ${c.error}`).join('; ');emit();continue;}
  const id=newProjectId(),parent=`/workspace/${id}`;
  const mirrored:{local:LocalComponent;path:string}[]=[];
  try{
   await deps.remote('fs_create_dir',{path:parent});
   const repos=new Map<string,LocalComponent[]>();
   for(const c of ready)repos.set(c.repo!,[...(repos.get(c.repo!)??[]),c]);
   let index=0;
   for(const [,members] of repos){
    const first=members[0];
    const repo:RepoResult={name:first.origin!.replace(/\/$/,'').split(/[/:]/).pop()!.replace(/\.git$/,''),components:members.map(m=>m.label),state:'running',stage:'Cloning',carried:[],problems:[],notes:[],installs:[]};
    result.repos.push(repo);emit();
    let staged:string|null=null,started=false;
    try{
     if(deps.signal?.aborted)throw Error('Setup was cancelled');
     const cloneParent=`${parent}/repo-${++index}`;await deps.remote('fs_create_dir',{path:cloneParent});
     const path=await clone(deps,sleep,cloneParent,first.origin!,stage=>{repo.stage=stage;emit();});
     if(applies){
      const mirrorId=newId();
      staged=mirrorId;
      await sendAndApply(deps,sleep,repo,{id:mirrorId,path,projectId,componentId:first.componentId,relatives:members.map(m=>m.relative??''),includeEnv:options.includeEnv,install:options.install},()=>{started=true;},emit);
     }else{
      if(first.branch){try{await deps.remote('git_checkout',{path,branch:first.branch});repo.carried.push(`On ${first.branch}`);}catch{repo.problems.push(`Branch ${first.branch} is not on origin; the default branch is checked out`);}}
      repo.problems.push('This workspace’s runtime predates full setup: unpushed commits, changes and new files were not carried. Update the workspace and set up again.');
     }
     for(const m of members){const componentPath=path+(m.relative?`/${m.relative}`:'');await deps.remote('fs_stat',{path:componentPath});mirrored.push({local:m,path:componentPath});}
     repo.state=repo.problems.length?'failed':'done';repo.stage=undefined;
    }catch(error){
     repo.state='failed';repo.stage=undefined;repo.detail=message(error);
     // Uploaded but never applied: the files (possibly .env contents) would sit in the workspace. Once started, the job removes them itself.
     if(staged&&!started)await deps.remote('mirror_apply_discard',{id:staged}).catch(()=>{});
    }
    emit();
   }
   if(!mirrored.length)throw Error('No repository could be set up');
   const incomplete=result.repos.some(r=>r.state==='failed');
   await recordProject(deps,{source:localStore?.projects.find(p=>p.id===projectId),projectId,id,name:result.name,mirrored,incomplete});
   result.state=incomplete?'failed':'done';
  }catch(error){result.state='failed';result.detail=message(error);}
  emit();
 }
 step('projects',progress.projects.some(p=>p.state==='failed')?'failed':'done',`${plural(progress.projects.filter(p=>p.state==='done').length,'project')} set up`);
 progress.done=true;emit();
 return progress;
}

async function clone(deps:MirrorDeps,sleep:(ms:number)=>Promise<void>,parent:string,url:string,stage:(stage:string)=>void){
 let job:{id:string;state:string;stage?:string;percent?:number|null;path:string;error?:string|null};
 try{job=await deps.remote('git_clone_start',{parent,url});}
 catch(error){if(!unsupported(error,'git_clone_start'))throw error;return (await deps.remote<{path:string}>('git_clone',{parent,url})).path;}
 while(job.state==='cloning'){stage(`Cloning${job.percent!=null?` · ${job.percent}%`:''}`);await sleep(1000);job=await deps.remote('git_clone_status',{id:job.id});}
 if(job.state!=='complete')throw Error(job.error??'Clone failed');
 return job.path;
}

export interface EnsureOptions{
 projectId:string;
 /** Limit to these local component ids; default is every component. */
 componentIds?:string[];
 /** Repo-relative ignored files to carry, by local component id (from execution_mirror_candidates). */
 selectedFiles:Record<string,string[]>;
 install:boolean;
 /** Skip selected files the remote already has. */
 onlyMissing:boolean;
}

/** Set up ONE project on the remote, on demand, without the whole-Mac mirror.
 * Idempotent: a project already there only gets the selected files it lacks
 * (never touching its commits, branch or changes). New projects are cloned and
 * given the Mac's work in progress plus the selected files, like runMirror. */
export async function ensureProjectOnRemote(deps:MirrorDeps,options:EnsureOptions,onProgress:(progress:MirrorProgress)=>void):Promise<MirrorProgress>{
 const sleep=deps.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
 const newId=deps.newId??(()=>crypto.randomUUID());
 const steps:MirrorStep[]=[{key:'inspect',label:'Reading the project on this Mac',state:'pending'},{key:'project',label:'Setting up the project',state:'pending'}];
 const progress:MirrorProgress={steps,projects:[],done:false};
 const emit=()=>onProgress({steps:steps.map(s=>({...s})),projects:progress.projects.map(p=>({...p,repos:p.repos.map(r=>({...r}))})),done:progress.done});
 const step=(key:string,state:StepState,detail?:string)=>{const s=steps.find(item=>item.key===key)!;s.state=state;s.detail=detail;emit();};
 const finish=()=>{progress.done=true;emit();return progress;};
 const fail=(project:ProjectResult,error:unknown)=>{project.state='failed';project.detail=message(error);step('project','failed');return finish();};

 step('inspect','running');
 const rows=(await deps.local<LocalComponent[]>('execution_mirror_inspect')).filter(r=>r.projectId===options.projectId&&(!options.componentIds||options.componentIds.includes(r.componentId)));
 const result:ProjectResult={name:rows[0]?.projectName||'Project',state:'running',repos:[]};
 progress.projects.push(result);
 if(!rows.length){step('inspect','failed');return fail(result,Error('This project is not on this Mac'));}
 step('inspect','done');
 step('project','running');
 const ready=rows.filter(r=>!r.error);
 if(!ready.length){result.state='skipped';result.detail=rows.map(c=>`${c.label}: ${c.error}`).join('; ');step('project','skipped');return finish();}

 try{
  const store=await loadRemoteStore(deps);
  const existing=store.projects.find(p=>p.mirroredFrom===options.projectId&&!p.mirrorIncomplete);
  const repos=new Map<string,LocalComponent[]>();
  for(const c of ready)repos.set(c.repo!,[...(repos.get(c.repo!)??[]),c]);
  const filesFor=(members:LocalComponent[])=>[...new Set(members.flatMap(m=>options.selectedFiles[m.componentId]??[]))];

  if(existing){
   // Incremental: find each repository's folder remotely, send only what is absent.
   for(const [,members] of repos){
    const first=members[0];
    const repo:RepoResult={name:first.label,components:members.map(m=>m.label),state:'running',carried:[],problems:[],notes:[],installs:[]};
    result.repos.push(repo);emit();
    try{
     const match=existing.components.find(c=>c.label===first.label)??existing.components.find(c=>first.relative&&c.path.endsWith(`/${first.relative}`));
     if(!match)throw Error(`${first.label} is not set up in this workspace yet`);
     const root=first.relative&&match.path.endsWith(`/${first.relative}`)?match.path.slice(0,-first.relative.length-1):match.path;
     let wanted=filesFor(members);
     if(options.onlyMissing){
      const missing:string[]=[];
      for(const file of wanted){try{await deps.remote('fs_stat',{path:`${root}/${file}`});}catch{missing.push(file);}}
      wanted=missing;
     }
     if(!wanted.length){repo.state='done';repo.carried.push('Selected files are already on the workspace');emit();continue;}
     const id=newId();let started=false;
     try{
      await sendAndApply(deps,sleep,repo,{id,path:root,projectId:options.projectId,componentId:first.componentId,relatives:members.map(m=>m.relative??''),includeEnv:false,install:false,extraFiles:wanted,filesOnly:true},()=>{started=true;},emit);
     }catch(error){if(!started)await deps.remote('mirror_apply_discard',{id}).catch(()=>{});throw error;}
     repo.state=repo.problems.length?'failed':'done';repo.stage=undefined;
    }catch(error){repo.state='failed';repo.stage=undefined;repo.detail=message(error);}
    emit();
   }
   const allSkipped=result.repos.every(r=>r.state==='done'&&r.carried.length===1&&/already on the workspace/.test(r.carried[0]));
   const failed=result.repos.some(r=>r.state==='failed');
   result.state=failed?'failed':allSkipped?'skipped':'done';
   if(allSkipped)result.detail='Selected files are already on the workspace';
   step('project',result.state==='failed'?'failed':result.state==='skipped'?'skipped':'done');
   return finish();
  }

  // Fresh setup. Private clones need the Mac's GitHub login in the workspace.
  try{await deps.local('execution_remote_import_git');}catch{/* public repositories still clone */}
  let applies=true;
  try{await deps.remote('mirror_apply_status',{id:'00000000-0000-0000-0000-000000000000'});}
  catch(error){if(unsupported(error,'mirror_apply_status'))applies=false;}
  const id=newProjectId(),parent=`/workspace/${id}`;
  const mirrored:{local:LocalComponent;path:string}[]=[];
  await deps.remote('fs_create_dir',{path:parent});
  let index=0;
  for(const [,members] of repos){
   const first=members[0];
   const repo:RepoResult={name:first.origin!.replace(/\/$/,'').split(/[/:]/).pop()!.replace(/\.git$/,''),components:members.map(m=>m.label),state:'running',stage:'Cloning',carried:[],problems:[],notes:[],installs:[]};
   result.repos.push(repo);emit();
   let staged:string|null=null,started=false;
   try{
    if(deps.signal?.aborted)throw Error('Setup was cancelled');
    const cloneParent=`${parent}/repo-${++index}`;await deps.remote('fs_create_dir',{path:cloneParent});
    const path=await clone(deps,sleep,cloneParent,first.origin!,stage=>{repo.stage=stage;emit();});
    if(applies){
     staged=newId();
     await sendAndApply(deps,sleep,repo,{id:staged,path,projectId:options.projectId,componentId:first.componentId,relatives:members.map(m=>m.relative??''),includeEnv:false,install:options.install,extraFiles:filesFor(members)},()=>{started=true;},emit);
    }else repo.problems.push('This workspace’s runtime predates full setup: only the clone was made. Update the workspace and set up again.');
    for(const m of members){const componentPath=path+(m.relative?`/${m.relative}`:'');await deps.remote('fs_stat',{path:componentPath});mirrored.push({local:m,path:componentPath});}
    repo.state=repo.problems.length?'failed':'done';repo.stage=undefined;
   }catch(error){
    repo.state='failed';repo.stage=undefined;repo.detail=message(error);
    if(staged&&!started)await deps.remote('mirror_apply_discard',{id:staged}).catch(()=>{});
   }
   emit();
  }
  if(!mirrored.length)throw Error('No repository could be set up');
  const incomplete=result.repos.some(r=>r.state==='failed');
  const localStore=JSON.parse(await deps.local<string>('store_load')??'null') as WorkspaceState|null;
  await recordProject(deps,{source:localStore?.projects.find(p=>p.id===options.projectId),projectId:options.projectId,id,name:result.name,mirrored,incomplete});
  result.state=incomplete?'failed':'done';
  step('project',result.state==='failed'?'failed':'done');
  return finish();
 }catch(error){return fail(result,error);}
}
