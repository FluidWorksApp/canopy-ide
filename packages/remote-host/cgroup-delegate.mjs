// Per-terminal memory limits need a cgroup tree the workspace may write, and a
// workspace container is unprivileged: every capability dropped,
// no-new-privileges, Docker's default seccomp and AppArmor, and a read-only
// /sys/fs/cgroup. Nothing about that changes. Instead the gateway runs this one
// fixed script, once per container start, as root through `docker exec
// --privileged` (which grants capabilities to this process only). It:
//
//  1. checks the container has its own cgroup namespace (created with
//     --cgroupns private; /proc/self/cgroup reads `0::/`) — in the host's
//     namespace a fresh mount would expose the host tree, so it stops;
//  2. mounts a writable cgroup2 at /run/canopy-cgroup, which in that namespace
//     is the container's own cgroup and nothing above it;
//  3. moves every process into canopy-host/ (cgroup v2: a cgroup with children
//     holds no processes), enables the memory controller for children, creates
//     sessions/ and enables memory there too;
//  4. delegates like systemd's Delegate=yes: the runner's user gets the root's
//     cgroup.procs (to move processes between children) and sessions/ itself.
//     The container's own limits (memory.max at the root) stay root's.
//
// Its outcome — or the exact step the kernel refused — is written to
// /run/canopy-cgroup.json for cgroup-sessions.mjs to report.
import {mkdir,readFile,writeFile,chown,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DELEGATED_ROOT='/run/canopy-cgroup';
export const STATUS_FILE='/run/canopy-cgroup.json';
const RUNNER_UID=1000,RUNNER_GID=1000;

const defaultMount=target=>new Promise((resolve,reject)=>execFile('/bin/mount',['-t','cgroup2','-o','rw,nosuid,nodev,noexec','cgroup2',target],error=>error?reject(error):resolve()));

/** Run every step; resolves with the status written (never throws). */
export async function delegate({entered=process.env.CANOPY_CGROUP_NSENTER==='1',root=DELEGATED_ROOT,statusFile=STATUS_FILE,mount=defaultMount,read=f=>readFile(f,'utf8'),uid=RUNNER_UID,gid=RUNNER_GID,own=chown,now=Date.now}={}){
 let step='check the cgroup namespace';
 const done=async status=>{await writeFile(statusFile,JSON.stringify({...status,at:now()})).catch(()=>{});return status;};
 try{
  const self=(await read('/proc/self/cgroup')).trim();
  // Run through nsenter from the gateway's helper (docker.mjs), this process
  // entered the container's cgroup namespace without being in its tree, so
  // its own path reads outside the root; the gateway checked the mode.
  if(self!=='0::/'&&!entered)return done({ok:false,step,error:`this container shares the host's cgroup namespace (${self.slice(0,120)}); recreate the workspace to enable per-terminal limits`});
  step='mount a writable cgroup2';
  await mkdir(root,{recursive:true,mode:0o755});
  let mounted=false;try{await read(path.join(root,'cgroup.controllers'));mounted=true;}catch{}
  if(!mounted)await mount(root);
  const controllers=(await read(path.join(root,'cgroup.controllers'))).split(/\s+/);
  if(!controllers.includes('memory'))return done({ok:false,step:'find the memory controller',error:'the memory controller is not available to this workspace'});
  const host=path.join(root,'canopy-host');await mkdir(host,{recursive:true});
  // A process forked while moving lands in the root again, and the kernel
  // refuses children controllers (EBUSY) until the root is empty: a few rounds.
  for(let round=0;;round++){
   step='move processes into canopy-host';
   for(const pid of (await read(path.join(root,'cgroup.procs'))).split('\n').filter(Boolean)){
    try{await writeFile(path.join(host,'cgroup.procs'),pid);}catch(error){if(error.code!=='ESRCH')throw error;}
   }
   step='enable the memory controller for children';
   try{await writeFile(path.join(root,'cgroup.subtree_control'),'+memory');break;}
   catch(error){if(error.code!=='EBUSY'||round>=4)throw error;}
  }
  step='create sessions';
  const sessions=path.join(root,'sessions');await mkdir(sessions,{recursive:true});
  await writeFile(path.join(sessions,'cgroup.subtree_control'),'+memory');
  step='delegate to the runner';
  for(const file of [path.join(root,'cgroup.procs'),sessions,path.join(sessions,'cgroup.procs'),path.join(sessions,'cgroup.subtree_control'),path.join(host,'cgroup.procs')])await own(file,uid,gid);
  await stat(sessions);
  return done({ok:true,root,sessions});
 }catch(error){
  return done({ok:false,step,error:`${error.code?error.code+': ':''}${error.message}`});
 }
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const status=await delegate();
 process.stdout.write(JSON.stringify(status)+'\n');
}
