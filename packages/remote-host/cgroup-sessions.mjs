// One cgroup per terminal, inside the tree cgroup-delegate.mjs handed to the
// runner: /run/canopy-cgroup/sessions/<id>. The governor (terminal-governor.mjs)
// puts each terminal's process tree there, measures it with memory.current and
// memory.events, and limits it the way the desktop's containment.rs does:
// memory.high at the terminal's allowance (soft: the kernel reclaims and
// throttles above it; raised when the person grants more), plus memory.max at
// the agent's allowance maximum when one is set (hard: the kernel stops the
// tree there).
//
// Everything is feature-detected. When the delegation never ran (a workspace
// created before per-terminal limits), or the kernel refused a step, this says
// exactly which, and the governor stays monitor-only on the resident set.
import {mkdir,readFile,readdir,rmdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {DELEGATED_ROOT,STATUS_FILE} from './cgroup-delegate.mjs';

const read=file=>readFile(file,'utf8');
const RECREATE='recreate the workspace to enable per-terminal limits';

export class SessionCgroups{
 constructor({root=DELEGATED_ROOT,statusFile=STATUS_FILE,procRoot='/proc',cgroupFs='/sys/fs/cgroup'}={}){
  Object.assign(this,{root,statusFile,procRoot,cgroupFs});
  this.sessions=path.join(root,'sessions');
  this.state={active:false,detail:'not checked yet'};this.checkedAt=0;
  this.applied=new Map();
 }
 /** Whether limits can be applied, rechecked at most every 30 s (a container
  *  restart drops the mount; the next delegation brings it back). */
 async probe(now=Date.now()){
  if(this.state.active&&now-this.checkedAt<30_000)return this.state;
  if(!this.state.active&&now-this.checkedAt<5_000&&this.checkedAt)return this.state;
  this.checkedAt=now;
  let status=null;try{status=JSON.parse(await read(this.statusFile));}catch{}
  if(!status){
   const v2=await read(path.join(this.cgroupFs,'cgroup.controllers')).then(()=>true,()=>false);
   this.state={active:false,detail:v2?`the workspace's cgroup was never delegated to it; ${RECREATE}`:'this kernel does not offer cgroup v2'};
   return this.state;
  }
  if(!status.ok){this.state={active:false,detail:`the kernel refused to ${status.step}: ${status.error}`};return this.state;}
  try{
   const enabled=(await read(path.join(this.sessions,'cgroup.subtree_control'))).split(/\s+/);
   if(!enabled.includes('memory'))throw Error('the memory controller is not enabled for terminals');
   const probe=await mkdtemp(path.join(this.sessions,'.probe-'));await rmdir(probe);
   this.state={active:true,detail:'each terminal runs in its own cgroup v2 memory group'};
  }catch(error){this.state={active:false,detail:`terminal cgroups are not writable (${error.code??error.message}); ${RECREATE}`};}
  return this.state;
 }
 dir(id){if(!Number.isSafeInteger(id)||id<0)throw Error('invalid terminal');return path.join(this.sessions,String(id));}
 /** Move a terminal's processes into its cgroup. Children it forks later are
  *  born there. A process that already exited is skipped. */
 async place(id,pids){
  const dir=this.dir(id);await mkdir(dir,{recursive:true});
  const want=`0::/sessions/${id}`;
  for(const pid of pids){
   if(!Number.isSafeInteger(pid)||pid<=1)continue;
   const current=(await read(path.join(this.procRoot,String(pid),'cgroup')).catch(()=>'')).trim();
   if(!current||current===want)continue;
   try{await writeFile(path.join(dir,'cgroup.procs'),String(pid));}catch(error){if(error.code!=='ESRCH')throw error;}
  }
 }
 /** memory.current and memory.events of one terminal, or null. */
 async sample(id){
  try{
   const dir=this.dir(id);
   const current=Number((await read(path.join(dir,'memory.current'))).trim());
   const events={};for(const line of (await read(path.join(dir,'memory.events'))).split('\n')){const [k,v]=line.trim().split(' ');if(k)events[k]=Number(v)||0;}
   return Number.isFinite(current)?{current,events}:null;
  }catch{return null;}
 }
 /** memory.high at the allowance, memory.max at the maximum (or none). */
 async limit(id,high,max){
  const key=`${high}|${max}`;if(this.applied.get(id)===key)return;
  const dir=this.dir(id);
  await writeFile(path.join(dir,'memory.high'),String(Math.max(1,Math.floor(high))));
  await writeFile(path.join(dir,'memory.max'),max==null?'max':String(Math.max(Math.floor(high),Math.floor(max))));
  this.applied.set(id,key);
 }
 /** Remove the cgroups of terminals that are gone. One still holding a
  *  process is left for the next pass. */
 async prune(live){
  let names=[];try{names=(await readdir(this.sessions,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^\d+$/.test(e.name)).map(e=>Number(e.name));}catch{return;}
  for(const id of names)if(!live.has(id)){this.applied.delete(id);await rmdir(this.dir(id)).catch(()=>{});}
 }
}

/** Tests: a writable fake of the delegated tree. */
export async function fakeDelegatedTree(base){
 const root=path.join(base,'cgroup'),sessions=path.join(root,'sessions');
 await mkdir(sessions,{recursive:true});await writeFile(path.join(sessions,'cgroup.subtree_control'),'memory');
 return {root,cleanup:()=>rm(base,{recursive:true,force:true})};
}
