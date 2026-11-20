// canopy-host on the user's own machine runs as a systemd user service with
// Delegate=yes: the service's cgroup is the host's to divide, no root needed.
// The twin of cgroup-delegate.mjs (which does this inside a container, as
// root) for that case. At start, before any runner exists, the host:
//
//  1. finds its own cgroup (/proc/self/cgroup) — the service's;
//  2. moves every process there into host/ (cgroup v2: a cgroup with children
//     holds no processes), so the host, its runners and their agents live in
//     host/ and are born there;
//  3. enables the memory controller for children and creates sessions/, where
//     the governor (terminal-governor.mjs, cgroup-sessions.mjs) gives each
//     terminal its own memory group, throttled at memory.high.
//
// The outcome, or the step that failed, goes to a status file that
// cgroup-sessions.mjs reads; the runner finds both through CANOPY_CGROUP_*.
// Without delegation (a unit written before it) the governor stays
// monitor-only and says how to turn limits on.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

export const UPGRADE_HINT='re-run `npx canopy-host up` on this machine to turn on per-terminal memory limits';

/** Never throws; resolves with the status it wrote. */
export async function delegateHostCgroup({statusFile,delegated=process.env.CANOPY_CGROUP_DELEGATE==='1',read=f=>readFile(f,'utf8'),write=writeFile,makeDir=mkdir,cgroupFs='/sys/fs/cgroup',now=Date.now}={}){
 const done=async status=>{
  const value={...status,at:now()};
  try{await makeDir(path.dirname(statusFile),{recursive:true,mode:0o700});await write(statusFile,JSON.stringify(value));}catch{}
  return value;
 };
 if(!delegated)return done({ok:false,step:'delegate',detail:`this service's cgroup is not delegated to it; ${UPGRADE_HINT}`});
 let step='find this service\'s cgroup';
 try{
  const line=(await read('/proc/self/cgroup')).split('\n').find(l=>l.startsWith('0::'));
  let cgroupPath=line?.slice(3).trim();
  if(!cgroupPath||!cgroupPath.startsWith('/')||cgroupPath.split('/').includes('..'))throw Error('no cgroup v2 path');
  // Already moved (an in-place restart of the process tree): use the parent.
  if(path.posix.basename(cgroupPath)==='host')cgroupPath=path.posix.dirname(cgroupPath);
  const root=path.join(cgroupFs,cgroupPath);
  step='find the memory controller';
  if(!(await read(path.join(root,'cgroup.controllers'))).split(/\s+/).includes('memory'))return done({ok:false,step,detail:'the memory controller is not delegated to this service'});
  const host=path.join(root,'host');await makeDir(host,{recursive:true});
  // A process forked while moving lands in the root again, and the kernel
  // refuses children controllers (EBUSY) until the root is empty: a few rounds.
  for(let round=0;;round++){
   step='move the host into host/';
   for(const pid of (await read(path.join(root,'cgroup.procs'))).split('\n').filter(Boolean)){
    try{await write(path.join(host,'cgroup.procs'),pid);}catch(error){if(error.code!=='ESRCH')throw error;}
   }
   step='enable the memory controller for children';
   try{await write(path.join(root,'cgroup.subtree_control'),'+memory');break;}
   catch(error){if(error.code!=='EBUSY'||round>=4)throw error;}
  }
  step='create sessions';
  const sessions=path.join(root,'sessions');await makeDir(sessions,{recursive:true});
  await write(path.join(sessions,'cgroup.subtree_control'),'+memory');
  return done({ok:true,root,sessions,cgroupPath});
 }catch(error){
  return done({ok:false,step,error:`${error.code?error.code+': ':''}${error.message}`});
 }
}

/** The environment a runner needs to find the delegated tree. */
export function cgroupEnv(status,statusFile){
 return {CANOPY_CGROUP_STATUS:statusFile,...(status?.ok?{CANOPY_CGROUP_ROOT:status.root,CANOPY_CGROUP_PATH:status.cgroupPath}:{})};
}
