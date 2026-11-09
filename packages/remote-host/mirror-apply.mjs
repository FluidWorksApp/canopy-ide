// Applies a local repository snapshot (sent by the desktop's "Set up from
// this Mac") onto a fresh clone in this workspace, then installs dependencies.
//
// The desktop uploads up to four artifacts into /workspace/.canopy-mirror/<id>/:
//   commits.bundle  commits the Mac has that origin does not (git bundle)
//   staged.patch    `git diff --cached --binary` (applied with --index)
//   unstaged.patch  `git diff --binary`
//   files.tgz       untracked, non-ignored files plus opted-in env files and
//                   ignored files the person picked
// `filesOnly` applies just files.tgz to an existing project (never overwriting).
// A job is started once and polled; the gateway gives native calls 15 seconds.
// Every step is a spawned process with its own deadline: installs routinely
// outlast run()'s budget and output cap. An artifact that cannot be applied is
// kept under ~/.canopy/mirror/<id>/ so the person's work is never discarded.
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access,lstat,mkdir,readdir,readFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';

const ARTIFACTS=['commits.bundle','staged.patch','unstaged.patch','files.tgz'];
const OBJECT=/^[a-f0-9]{40}([a-f0-9]{24})?$/;
const STEP_MS=5*60000, INSTALL_MS=20*60000, KEEP_MS=30*60000, TAIL_BYTES=4096, KILL_GRACE_MS=5000, STAGING_TTL_MS=24*3600000;
// Without this GNU tar prints non-ASCII names as \303\251 escapes under LC_ALL=C;
// the symlink check below would then lstat a name that does not exist and pass.
const LITERAL=['--quoting-style=literal'];
const STAGING_ID=/^[a-f0-9-]{36}$/;

export const mirrorStaging=(root,id)=>path.join(root,'.canopy-mirror',id);

export function validBranch(value){
 return typeof value==='string'&&value.length>0&&value.length<=255&&!/[\0-\x20~^:?*[\\\x7f]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$|^HEAD$/.test(value);
}

/** Archive members must be plain files below the repository, never inside
 * .git, never through a symlink. `types` are `tar -tv` mode characters. */
export function checkMembers(names,types){
 if(names.length!==types.length)throw Error('Unreadable file archive');
 if(names.length>20000)throw Error('Too many files in archive');
 names.forEach((name,index)=>{
  const parts=name.split('/');
  if(types[index]!=='-'||!name||name.startsWith('/')||parts.some(part=>part===''||part==='.'||part==='..')||parts[0]==='.git'||parts.includes('.git'))throw Error(`Unsafe archive member: ${name.slice(0,200)}`);
 });
}

/** Where dependency installs run and with what. Each component folder uses the
 * nearest lockfile between it and the repository root; one install per folder. */
export async function installPlan(repo,components,exists=file=>access(file).then(()=>true,()=>false)){
 const plans=new Map();
 const lockfile=async directory=>{
  const at=name=>exists(path.join(directory,name));
  if(await at('pnpm-lock.yaml'))return {tool:'pnpm',argv:['corepack','pnpm','install','--frozen-lockfile']};
  if(await at('yarn.lock'))return {tool:'yarn',argv:['corepack','yarn','install']};
  if(await at('bun.lock')||await at('bun.lockb'))return {tool:'bun',argv:['bun','install','--frozen-lockfile']};
  if(await at('package-lock.json'))return {tool:'npm',argv:['npm','ci']};
  if(await at('requirements.txt'))return {tool:'pip',argv:['/bin/sh','-c','python3 -m venv .venv && .venv/bin/pip install -r requirements.txt']};
  return null;
 };
 for(const relative of components.length?components:['']){
  const component=path.resolve(repo,relative);
  if(component!==repo&&!component.startsWith(repo+'/'))continue;
  let directory=component,plan=await lockfile(directory);
  while(!plan&&directory!==repo){directory=path.dirname(directory);plan=await lockfile(directory);}
  // A package without any lockfile up to the repository root installs alone.
  if(!plan&&await exists(path.join(component,'package.json'))){directory=component;plan={tool:'npm',argv:['npm','install']};}
  if(!plan||plans.has(directory))continue;
  // An existing install is the person's (or a previous run's); leave it.
  plans.set(directory,{...plan,cwd:directory,installed:await exists(path.join(directory,plan.tool==='pip'?'.venv':'node_modules'))});
 }
 return [...plans.values()];
}

/** Things the workspace cannot reproduce exactly, stated instead of guessed. */
export async function toolchainNotes(repo,read=file=>readFile(file,'utf8'),nodeMajor=Number(process.versions.node.split('.')[0])){
 const notes=[];
 const text=async name=>{try{return await read(path.join(repo,name));}catch{return null;}};
 const wanted=(await text('.nvmrc'))??(await text('.node-version'));
 let major=wanted?.trim().replace(/^v/,'').match(/^(\d+)/)?.[1];
 if(!major){const tools=await text('.tool-versions');major=tools?.match(/^(?:nodejs|node)\s+v?(\d+)/m)?.[1];}
 if(major&&Number(major)!==nodeMajor)notes.push(`Project asks for Node ${major}; this workspace has Node ${nodeMajor}.`);
 const attributes=await text('.gitattributes');
 if(attributes&&/filter=lfs/.test(attributes))notes.push('Uses Git LFS; large files may be pointers until git-lfs is available in the workspace.');
 for(const [file,tool] of [['Cargo.toml','Rust'],['go.mod','Go'],['Gemfile','Ruby'],['pom.xml','Java'],['build.gradle','Java']])
  if(await text(file)!==null)notes.push(`${tool} toolchain is not installed in the workspace image; install it before building.`);
 return notes;
}

export class MirrorJobs {
 constructor({scoped,root='/workspace',home='/home/agent',launch=spawn,now=Date.now,killGrace=KILL_GRACE_MS}){
  this.killGrace=killGrace;this.scoped=scoped;this.root=root;this.home=home;this.launch=launch;this.now=now;this.jobs=new Map();
 }
 /** Remove staged artifacts for a setup that will not run (upload failed or
  * was cancelled). Refused while that setup is running: the job owns them. */
 async discard(args){
  const id=String(args?.id??'');
  if(!STAGING_ID.test(id))throw Error('Invalid setup identifier');
  if(this.jobs.get(id)?.state==='running')throw Error('That setup is running');
  await rm(await this.scoped(mirrorStaging(this.root,id)),{recursive:true,force:true});
  return {discarded:true};
 }
 /** Staging that nothing will ever apply (the app quit mid-upload) is removed
  * after a day, so env files and bundles never linger on the workspace. */
 async sweep(){
  const base=path.join(this.root,'.canopy-mirror');
  for(const name of await readdir(base).catch(()=>[])){
   if(!STAGING_ID.test(name)||this.jobs.get(name)?.state==='running')continue;
   const info=await lstat(path.join(base,name)).catch(()=>null);
   if(info&&this.now()-info.mtimeMs>STAGING_TTL_MS)await rm(path.join(base,name),{recursive:true,force:true}).catch(()=>{});
  }
 }
 async start(args){
  for(const [id,job] of this.jobs)if(job.finishedAt&&this.now()-job.finishedAt>KEEP_MS)this.jobs.delete(id);
  await this.sweep();
  if([...this.jobs.values()].some(job=>job.state==='running'))throw Error('Another setup is already running in this workspace');
  const id=String(args.id??'');
  if(!STAGING_ID.test(id))throw Error('Invalid setup identifier');
  if(this.jobs.has(id))return this.status(id);
  const filesOnly=args.filesOnly===true;
  if(!filesOnly&&!OBJECT.test(String(args.head??'')))throw Error('Invalid commit');
  if(args.branch!=null&&!validBranch(args.branch))throw Error('Invalid branch name');
  if(args.upstream!=null&&!(typeof args.upstream==='string'&&args.upstream.startsWith('origin/')&&validBranch(args.upstream.slice(7))))throw Error('Invalid upstream branch');
  const components=Array.isArray(args.components)?args.components:[];
  if(components.length>64||components.some(c=>typeof c!=='string'||c.length>1024||c.includes('\0')||path.isAbsolute(c)||c.split('/').includes('..')))throw Error('Invalid component folders');
  const repo=await this.scoped(args.repo);
  if(!(await lstat(path.join(repo,'.git')).catch(()=>null)))throw Error('Repository not found in the workspace');
  const staging=await this.scoped(mirrorStaging(this.root,id));
  const present={};
  // The sender says what it uploaded. An artifact that is missing or the wrong
  // size means the upload went elsewhere or was cut short; applying "nothing"
  // would report success on an empty setup.
  const expect=args.expect&&typeof args.expect==='object'?args.expect:{};
  for(const name of ARTIFACTS){
   const info=await lstat(path.join(staging,name)).catch(()=>null);
   if(info&&!info.isFile())throw Error('Invalid setup artifact');
   present[name]=!!info;
   const size=expect[name];
   if(size!=null&&(!info||info.size!==size))throw Error(`Setup artifact ${name} is missing or incomplete; retry setup`);
  }
  await mkdir(path.join(this.home,'.canopy','mirror'),{recursive:true,mode:0o700});
  const job={id,state:'running',phase:'commits',repo,staging,steps:[],notes:[],installs:[],log:path.join(this.home,'.canopy','mirror',id+'.log'),startedAt:this.now(),finishedAt:null};
  this.jobs.set(id,job);
  this.run(job,{filesOnly,head:args.head,branch:args.branch??null,upstream:args.upstream??null,components,install:args.install!==false,present}).catch(error=>{job.state='failed';job.error=String(error.message??error).slice(0,2048);}).finally(()=>{job.finishedAt=this.now();if(job.state==='running')job.state='complete';});
  return this.status(id);
 }
 status(id){
  const job=this.jobs.get(id);if(!job)throw Error('Setup job not found');
  return {id:job.id,state:job.state,phase:job.phase,repo:job.repo,steps:job.steps,notes:job.notes,installs:job.installs,error:job.error??null,log:job.log,elapsedSeconds:Math.floor((this.now()-job.startedAt)/1000)};
 }
 exec(job,argv,{cwd=job.repo,timeout=STEP_MS,env={}}={}){
  return new Promise(resolve=>{
   let tail='';const log=createWriteStream(job.log,{flags:'a',mode:0o600});log.write(`\n$ ${argv.join(' ')}\n`);
   let child;
   try{child=this.launch(argv[0],argv.slice(1),{cwd,env:{...process.env,HOME:this.home,GIT_TERMINAL_PROMPT:'0',CI:'1',...env},stdio:['ignore','pipe','pipe']});}
   catch{log.end();resolve({ok:false,output:`${argv[0]} could not start`});return;}
   const take=chunk=>{log.write(chunk);tail=(tail+chunk.toString()).slice(-TAIL_BYTES);};
   child.stdout?.on('data',take);child.stderr?.on('data',take);
   let settled=false,killer;
   const done=ok=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killer);log.end();resolve({ok,output:tail.trim()});};
   // SIGTERM first. A child that ignores it, or a grandchild holding the pipes
   // open (a postinstall daemon), would keep 'close' from ever firing and the
   // job would run forever, so the step is abandoned after a short grace.
   const timer=setTimeout(()=>{
    child.kill('SIGTERM');tail+=`\nTimed out after ${Math.round(timeout/60000)} minutes`;
    killer=setTimeout(()=>{child.kill('SIGKILL');done(false);},this.killGrace);
   },timeout);timer.unref?.();
   child.once('error',()=>{tail+=`\n${argv[0]} could not start`;done(false);});
   child.once('close',code=>done(code===0));
  });
 }
 record(job,name,state,detail){job.steps.push({name,state,...(detail?{detail:String(detail).slice(-TAIL_BYTES)}:{})});}
 async keep(job,name){
  const kept=path.join(this.home,'.canopy','mirror',job.id);await mkdir(kept,{recursive:true,mode:0o700});
  await rename(path.join(job.staging,name),path.join(kept,name)).catch(()=>{});return path.join(kept,name);
 }
 async run(job,{filesOnly=false,head,branch,upstream,components,install,present}){
  const git=(...argv)=>this.exec(job,['git',...argv]);
  try{
   // Files-only (incremental sync into a project already here) leaves commits, branch and changes alone.
   if(!filesOnly){
   // Commits: from the bundle when the Mac had unpushed work, else origin.
   if(present['commits.bundle']){
    const bundle=path.join(job.staging,'commits.bundle');
    const fetched=await git('fetch','--no-tags',bundle,'+HEAD:refs/canopy/mirror');
    if(!fetched.ok)throw Error(`Local commits could not be added: ${fetched.output}`);
    this.record(job,'commits','done','Unpushed commits copied');
   }
   if(!(await git('cat-file','-e',head+'^{commit}')).ok){
    const fetched=await git('fetch','--no-tags','origin',head);
    if(!fetched.ok||!(await git('cat-file','-e',head+'^{commit}')).ok)throw Error('The commit checked out on the Mac is not on origin and was not sent. Push it, or retry setup.');
   }
   if(!present['commits.bundle'])this.record(job,'commits','done','Commit found on origin');
   job.phase='checkout';
   const checkout=branch?await git('checkout','-B',branch,head):await git('checkout','--detach',head);
   if(!checkout.ok)throw Error(`Checkout failed: ${checkout.output}`);
   await git('update-ref','-d','refs/canopy/mirror');
   if(branch){
    const tracking=upstream??`origin/${branch}`;
    if((await git('rev-parse','--verify','--quiet','refs/remotes/'+tracking)).ok)await git('branch','--set-upstream-to='+tracking,branch);
   }
   this.record(job,'checkout','done',branch?`On ${branch}`:'Detached at the Mac’s commit');
   job.phase='changes';
   for(const [name,argv,label] of [['staged.patch',['--index'],'Staged changes'],['unstaged.patch',[],'Unstaged changes']]){
    if(!present[name])continue;
    const applied=await git('apply',...argv,'--binary','--whitespace=nowarn',path.join(job.staging,name));
    if(applied.ok)this.record(job,name.replace('.patch',''),'done',label+' applied');
    else this.record(job,name.replace('.patch',''),'failed',`${label} did not apply; the patch is kept at ${await this.keep(job,name)}. ${applied.output}`);
   }
   }
   if(present['files.tgz']){
    job.phase='files';
    const archive=path.join(job.staging,'files.tgz');
    try{
     const list=await this.capture(['tar','-tzf',archive,...LITERAL]),types=(await this.capture(['tar','-tvzf',archive,...LITERAL])).map(line=>line[0]);
     checkMembers(list,types);
     for(const name of list){const parts=name.split('/');for(let i=1;i<parts.length;i++){const info=await lstat(path.join(job.repo,...parts.slice(0,i))).catch(()=>null);if(info?.isSymbolicLink())throw Error(`Archive path goes through a symlink: ${name.slice(0,200)}`);}}
     // --skip-old-files keeps what is there, so count only members that were absent.
     let absent=0;for(const name of list)if(!await lstat(path.join(job.repo,name)).catch(()=>null))absent++;
     const extracted=await this.exec(job,['tar','-xzf',archive,'-C',job.repo,'--no-same-owner','--skip-old-files'],{env:{LC_ALL:'C'}});
     if(!extracted.ok)throw Error(extracted.output);
     this.record(job,'files','done',`${absent} new or local-only ${absent===1?'file':'files'} copied${absent<list.length?` (${list.length-absent} already there, left as is)`:''}`);
    }catch(error){this.record(job,'files','failed',`New files were not copied; the archive is kept at ${await this.keep(job,'files.tgz')}. ${error.message??error}`);}
   }
   if(!filesOnly&&await lstat(path.join(job.repo,'.gitmodules')).catch(()=>null)){
    const submodules=await git('submodule','update','--init','--recursive');
    this.record(job,'submodules',submodules.ok?'done':'failed',submodules.ok?'Submodules checked out':submodules.output);
   }
   if(!filesOnly)job.notes.push(...await toolchainNotes(job.repo));
   if(install){
    job.phase='dependencies';
    for(const plan of await installPlan(job.repo,components)){
     const where=path.relative(job.repo,plan.cwd)||'.';
     if(plan.installed){job.installs.push({cwd:where,tool:plan.tool,state:'skipped',detail:'Already installed'});continue;}
     const entry={cwd:where,tool:plan.tool,state:'running'};job.installs.push(entry);
     const result=await this.exec(job,plan.argv,{cwd:plan.cwd,timeout:INSTALL_MS,env:{COREPACK_ENABLE_DOWNLOAD_PROMPT:'0'}});
     entry.state=result.ok?'done':'failed';if(!result.ok)entry.detail=result.output;
    }
   }
   job.phase='complete';
  }finally{await rm(job.staging,{recursive:true,force:true});}
 }
 capture(argv){
  return new Promise((resolve,reject)=>{
   const child=this.launch(argv[0],argv.slice(1),{env:{...process.env,LC_ALL:'C'},stdio:['ignore','pipe','ignore']});let out='';
   child.stdout.on('data',chunk=>{out+=chunk;if(out.length>8*1024*1024){child.kill('SIGTERM');reject(Error('File archive listing too large'));}});
   child.once('error',reject);child.once('close',code=>code===0?resolve(out.split('\n').filter(Boolean)):reject(Error('Unreadable file archive')));
  });
 }
}
