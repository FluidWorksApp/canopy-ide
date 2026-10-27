// Proof receipts in a Linux workspace: the workspace (not the agent) re-runs a
// project's checks and reports the raw exit code and output tail. The desktop
// twin is src-tauri/src/receipt.rs; both answer `receipt_run_check` with the
// same shape, so src/receipts/ never knows which side ran it.
//
// Not the native host's shared `run()`: that throws on a non-zero exit (the
// failing suite's output is the evidence we need most), caps output at 1 MB by
// failing, and shares a four-slot pool with git, so a three-minute test run
// would starve every panel. Checks get their own single slot here.
import {execFile,spawn} from 'node:child_process';
import {copyFile,lstat,mkdir,readFile,readdir,rm,stat,symlink,unlink as unlinkFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const DEFAULT_TIMEOUT=5*60*1000, CEILING=20*60*1000;
const DEFAULT_KEEP=64*1024, MAX_KEEP=1024*1024;

/** Keeps the first or last `max` bytes while draining everything. */
export function capture(max,tail){
 let chunks=[],size=0,truncated=false;
 return {
  push(chunk){
   if(tail){chunks.push(chunk);size+=chunk.length;if(size>max*2){const all=Buffer.concat(chunks);chunks=[all.subarray(all.length-max)];size=max;truncated=true;}}
   else if(size<max){const take=chunk.subarray(0,max-size);chunks.push(take);size+=take.length;if(take.length<chunk.length)truncated=true;}
   else truncated=true;
  },
  done(){let all=Buffer.concat(chunks);if(tail&&all.length>max){all=all.subarray(all.length-max);truncated=true;}return {text:all.toString('utf8'),truncated};},
 };
}

let active=Promise.resolve();
/** Run one check. `scoped` confines cwd to the workspace. */
export function receiptRunCheck(args,{scoped,env=process.env,home}){
 const run=active.catch(()=>{}).then(()=>runOne(args,{scoped,env,home}));
 active=run;
 return run;
}

async function runOne(args,{scoped,env,home}){
 const argv=args?.argv;
 if(!Array.isArray(argv)||!argv.length||argv.length>256||argv.some(a=>typeof a!=='string'||a.length>16384||a.includes('\0'))||!argv[0].trim())throw Error('Invalid check command');
 const cwd=await scoped(String(args.cwd??''));
 const keep=Math.min(MAX_KEEP,Math.max(1024,Number(args.keepBytes)||DEFAULT_KEEP));
 const timeout=Math.min(CEILING,Math.max(100,Number(args.timeoutMs)||DEFAULT_TIMEOUT));
 const tail=!args.head;
 // Same scrub as the desktop: CANOPY* would make the check look like an agent
 // session to the hooks. CI=1 keeps every runner we parse out of watch mode.
 const childEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('CANOPY')));
 Object.assign(childEnv,{CI:'1',NO_COLOR:'1',FORCE_COLOR:'0',GIT_TERMINAL_PROMPT:'0'},home?{HOME:home}:{});
 // What an isolated copy asks for (a build cache shared with the live
 // checkout); never a CANOPY* key.
 for(const pair of Array.isArray(args.env)?args.env.slice(0,16):[]){
  const [key,value]=Array.isArray(pair)?pair:[];
  if(typeof key==='string'&&typeof value==='string'&&key&&!key.startsWith('CANOPY')&&!/[=\0]/.test(key))childEnv[key]=value;
 }
 const started=Date.now();
 return new Promise(resolve=>{
  let child;
  try{child=spawn(argv[0],argv.slice(1),{cwd,env:childEnv,stdio:['ignore','pipe','pipe'],detached:true});}
  catch(error){resolve(result({spawnError:`could not start \`${argv[0]}\`: ${error.message}`}));return;}
  const out=capture(keep,tail),err=capture(keep,tail);
  let timedOut=false,settled=false;
  const killGroup=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}};
  const timer=setTimeout(()=>{timedOut=true;killGroup();},timeout);
  child.stdout.on('data',chunk=>out.push(chunk));
  child.stderr.on('data',chunk=>err.push(chunk));
  child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result({spawnError:`could not start \`${argv[0]}\`: ${error.message}`}));});
  child.once('exit',()=>{if(!timedOut&&child.pid)killGroup();});
  child.once('close',(code)=>{
   if(settled)return;settled=true;clearTimeout(timer);
   const o=out.done(),e=err.done();
   resolve(result({code:timedOut?null:code,stdout:o.text,stderr:e.text,stdoutTruncated:o.truncated,stderrTruncated:e.truncated,timedOut,durationMs:Date.now()-started}));
  });
 });
}

function result(r){return {code:null,stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,timedOut:false,durationMs:0,spawnError:null,...r};}

// ------------------------------------------------------------- isolation
// The twin of receipt.rs `receipt_isolate` / `receipt_release`: checks run in
// a throwaway export of the turn's snapshot (or of the working tree as it is
// now), never in the live checkout the agent's next turn is editing. The copy
// sits under the checkout's git directory, inside the workspace scope, where
// no snapshot or `git status` looks; installed dependency folders are linked
// in from the live checkout. An export, not `git worktree add`, so it never
// shows up in a worktree list.

const LINK_NAMES=new Set(['node_modules','.venv','venv','bower_components']);
const MAX_LINKS=400,ORPHAN_MS=6*60*60*1000,COPIES='canopy-receipts';
const GIT_SCRUB=['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_COMMON_DIR','GIT_PREFIX'];
let copySeq=0;

function gitRun(cwd,argv,{env=process.env,home,extra={},timeout=120000}={}){
 const childEnv={...env,GIT_TERMINAL_PROMPT:'0',...(home?{HOME:home}:{})};
 for(const key of GIT_SCRUB)delete childEnv[key];
 Object.assign(childEnv,extra);
 return new Promise((resolve,reject)=>execFile('git',['-C',cwd,'-c','core.fsmonitor=false','-c','core.splitIndex=false',...argv],{env:childEnv,timeout,maxBuffer:16*1024*1024},(error,stdout,stderr)=>error?reject(Error(String(stderr||error.message).trim().slice(0,2000))):resolve(String(stdout).trim())));
}

const validRev=rev=>typeof rev==='string'&&/^[0-9a-f]{7,64}$/i.test(rev);
const exists=async p=>{try{await lstat(p);return true;}catch{return false;}};

async function removeCopy(copy){
 try{for(const rel of (await readFile(copy+'.links','utf8')).split('\n').filter(Boolean))await unlinkFile(path.join(copy,rel)).catch(()=>{});}catch{}
 await rm(copy,{recursive:true,force:true});
 for(const extra of ['.links','.index','.index.lock'])await rm(copy+extra,{force:true});
}

async function sweepOrphans(base){
 let entries=[];try{entries=await readdir(base,{withFileTypes:true});}catch{return;}
 for(const entry of entries){
  if(!entry.isDirectory())continue;
  const full=path.join(base,entry.name);
  try{if(Date.now()-(await stat(full)).mtimeMs>ORPHAN_MS)await removeCopy(full);}catch{}
 }
}

/** Write the working tree (tracked + untracked, not ignored) into a tree id
 *  through a temporary index seeded from a copy of the user's. */
async function worktreeTree(top,index,opts){
 const userIndex=path.resolve(top,await gitRun(top,['rev-parse','--git-path','index'],opts));
 let seeded=false;try{await copyFile(userIndex,index);seeded=true;}catch{}
 if(!seeded){const head=await gitRun(top,['rev-parse','--verify','-q','HEAD^{commit}'],opts).catch(()=>'');if(head)await gitRun(top,['read-tree',head],{...opts,extra:{GIT_INDEX_FILE:index}});}
 await gitRun(top,['add','-A','--',':/'],{...opts,extra:{GIT_INDEX_FILE:index},timeout:300000});
 return gitRun(top,['write-tree'],{...opts,extra:{GIT_INDEX_FILE:index}});
}

export async function receiptIsolate(args,{scoped,env=process.env,home}){
 const cwd=await scoped(String(args?.cwd??''));
 const rev=args?.rev??null;
 if(rev!=null&&!validRev(rev))throw Error('not a snapshot id');
 const opts={env,home};
 const top=await gitRun(cwd,['rev-parse','--show-toplevel'],opts);
 const gitDir=await gitRun(top,['rev-parse','--absolute-git-dir'],opts);
 const base=path.join(gitDir,COPIES);
 await scoped(base,true).catch(()=>{throw Error('the checkout\'s git folder is outside this workspace');});
 await mkdir(base,{recursive:true});
 await sweepOrphans(base);
 const copy=path.join(base,`${process.pid}-${Date.now()}-${copySeq++}`);
 const index=copy+'.index';
 let tree;
 try{
  tree=rev??await worktreeTree(top,copy+'.snapshot-index',opts);
 }finally{await rm(copy+'.snapshot-index',{force:true});}
 try{
  await mkdir(copy,{recursive:true});
  await gitRun(top,['read-tree',tree],{...opts,extra:{GIT_INDEX_FILE:index}});
  await gitRun(top,['checkout-index','-a','-f','--prefix',copy+'/'],{...opts,extra:{GIT_INDEX_FILE:index},timeout:300000});
 }catch(error){await removeCopy(copy);throw Error(`could not copy the checkout: ${error.message}`);}
 finally{await rm(index,{force:true});}
 const ignored=await gitRun(top,['ls-files','--others','--ignored','--exclude-standard','--directory'],opts).catch(()=>'');
 const linked=[];
 for(const line of ignored.split('\n')){
  if(linked.length>=MAX_LINKS)break;
  const rel=line.trim().replace(/\/+$/,'');
  if(!rel||rel.split('/').includes('..')||!LINK_NAMES.has(rel.split('/').pop()))continue;
  const source=path.join(top,rel),target=path.join(copy,rel);
  try{
   if(!(await stat(source)).isDirectory()||!(await stat(path.dirname(target))).isDirectory()||await exists(target))continue;
   await symlink(source,target,'dir');linked.push(rel);
  }catch{}
 }
 await writeFile(copy+'.links',linked.join('\n'));
 const envOut=[];
 if(!env.CARGO_TARGET_DIR&&await exists(path.join(top,'Cargo.toml'))){
  const live=path.join(top,'target');
  try{if((await stat(live)).isDirectory())envOut.push(['CARGO_TARGET_DIR',live]);}catch{}
 }
 return {dir:copy,tree,linked,env:envOut};
}

export async function receiptRelease(args,{scoped}){
 const dir=await scoped(String(args?.dir??''));
 if(path.basename(path.dirname(dir))!==COPIES||dir.includes('..'))throw Error('not a receipt copy');
 await removeCopy(dir);
 return null;
}

// A check can run for up to CEILING (20 minutes), longer than the gateway
// holds a request open (nativeTimeoutMs). So the IDE starts it as a job and
// long-polls for the answer; receipt_run_check stays for short checks and
// older desktops.
const jobs=new Map();
const JOB_KEEP=10*60*1000, POLL_MAX=10_000;
function pruneJobs(now=Date.now()){for(const [id,job] of jobs)if(job.state!=='running'&&now-job.touched>JOB_KEEP)jobs.delete(id);}
export function receiptCheckStart(args,opts){
 pruneJobs();
 const id=randomUUID(),job={state:'running',result:null,error:null,touched:Date.now(),waiters:new Set()};
 jobs.set(id,job);
 const finish=()=>{job.touched=Date.now();for(const wake of job.waiters)wake();job.waiters.clear();};
 receiptRunCheck(args,opts).then(result=>{job.state='done';job.result=result;finish();},error=>{job.state='failed';job.error=String(error?.message??error);finish();});
 return {id};
}
/** The job's state, waiting up to `wait` ms (≤ 10 s) for it to finish. A
 *  finished job keeps its answer for ten minutes after it was last asked. */
export async function receiptCheckStatus(args){
 const job=jobs.get(String(args?.id??''));
 if(!job)throw Error('No such check (it finished long ago, or the workspace restarted)');
 job.touched=Date.now();
 const wait=Math.min(POLL_MAX,Math.max(0,Number(args?.wait)||0));
 if(job.state==='running'&&wait>0)await new Promise(resolve=>{const timer=setTimeout(()=>{job.waiters.delete(done);resolve();},wait);const done=()=>{clearTimeout(timer);resolve();};job.waiters.add(done);});
 return job.state==='running'?{state:'running'}:job.state==='done'?{state:'done',result:job.result}:{state:'failed',error:job.error};
}
