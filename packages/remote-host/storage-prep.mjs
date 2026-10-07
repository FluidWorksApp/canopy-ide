// Stop preparation for snapshot-backed workspaces. The control plane asks the
// gateway for it before StopInstance; a root-only systemd unit performs it (the
// gateway runs unprivileged and can only drop a request file). Goal: a
// consistent disk whose snapshot holds as few blocks as possible.
//
// EBS snapshots store only blocks that were written. Deleting a file does not
// unwrite its blocks; a discard (fstrim) on Nitro NVMe EBS deallocates them.
// Whether Lightsail then stops storing (and billing) those blocks in the next
// snapshot is the assumption the paid verification test measures; see
// docs/snapshot-storage.md in canopy-website.
//
// Every step is bounded and best effort except ordering: containers stop
// before anything is trimmed, swap is emptied before it is released. A failed
// step is reported, never fatal: the snapshot after StopInstance is still
// consistent (the OS shuts down cleanly), only possibly larger.
import {open,readFile,rm,statfs} from 'node:fs/promises';
import {constants} from 'node:fs';
import {runner,MOUNT_POINT,storageUsage} from './user-storage.mjs';
import {publishRuntimeFile} from './runtime-dir.mjs';

export const REQUEST_FILE='/srv/canopy/host-state/storage-prep-request.json';
export const STATUS_FILE='/run/canopy/storage-prep.json';
export const SWAP_FILE='/swapfile';
export const SWAP_BYTES=3*1024**3;
export const DEADLINE_MS=10*60000;
const REQUEST_ID=/^[A-Za-z0-9-]{8,64}$/;

export function trimmedBytes(output){
 const match=String(output).match(/\((\d+) bytes\) trimmed/);
 return match?Number(match[1]):null;
}
// Only stale, regenerable data: never volumes, never containers' writable layers.
export const CACHE_CLEANUP=Object.freeze([
 ['apt-get',['clean']],
 ['journalctl',['--vacuum-size=64M']],
 ['docker',['builder','prune','--force']],
 ['docker',['image','prune','--force']],
]);

export const DATA_DISK_MOUNT='/srv/canopy';
export async function prepareForSnapshot({dataDiskMounted=null,run=runner(),now=Date.now,deadlineMs=DEADLINE_MS,captureRecent=async()=>null,cleanTmp=defaultCleanTmp,usage=defaultUsage,userMounted=null}={}){
 const started=now(),steps=[],warnings=[];
 const remaining=()=>Math.max(1000,deadlineMs-(now()-started));
 const step=async(name,action,{critical=false,limit=120000}={})=>{
  const begin=now();
  try{const detail=await action(Math.min(limit,remaining()));steps.push({name,ok:true,ms:now()-begin,...(detail&&typeof detail==='object'?{detail}:{})});return true;}
  catch(error){steps.push({name,ok:false,ms:now()-begin,error:String(error.message).slice(0,200)});warnings.push(`${name}: ${String(error.message).slice(0,200)}`);if(critical)throw error;return false;}
 };
 const ok=async(command,args,timeout)=>{const result=await run(command,args,{timeout});if(result.code!==0)throw Error(`${command} exited ${result.code}${result.timedOut?' (timeout)':''}`);return result;};
 // 1. Quiesce: stop workspace containers cleanly so their files are closed.
 await step('stop-containers',async timeout=>{
  const names=(await ok('docker',['ps','--format','{{.Names}}'],Math.min(timeout,30000))).stdout.split('\n').map(s=>s.trim()).filter(name=>/^canopy-[A-Za-z0-9_.-]+$/.test(name));
  if(names.length)await ok('docker',['stop','--time','30',...names],timeout);
  return {stopped:names.length};
 },{limit:120000});
 // 2. Remember what the user worked on, for the next start's warm-up.
 await step('record-recent-files',async timeout=>captureRecent(timeout),{limit:60000});
 // 3. Drop caches that never need to persist.
 await step('clean-caches',async timeout=>{
  let failed=0;for(const [command,args] of CACHE_CLEANUP){const result=await run(command,args,{timeout:Math.min(timeout,60000)});if(result.code!==0)failed++;}
  await cleanTmp();
  if(failed)throw Error(`${failed} cache cleanup command(s) failed`);
 },{limit:180000});
 await step('sync',async timeout=>{await ok('sync',[],timeout);});
 // 4. Empty swap: a swap file keeps every stale page it ever held. Turn it
 // off (containers are stopped, so RAM has room), delete it so fstrim can
 // discard its blocks, and recreate it after the trim with unwritten extents.
 const swapReleased=await step('release-swap',async timeout=>{
  const active=(await run('swapon',['--show=NAME','--noheadings'],{timeout:10000})).stdout.split('\n').map(s=>s.trim()).includes(SWAP_FILE);
  if(active)await ok('swapoff',[SWAP_FILE],timeout);
  await ok('rm',['-f',SWAP_FILE],10000);
 },{limit:180000});
 // 5. Trim inside the user image first (punches holes in the backing file),
 // then the root filesystem, which releases those holes and all other free
 // blocks to EBS.
 const trimmed={};
 // Snapshot layout: the user image is a mount. Retained-disk layout (today):
 // /srv/canopy is the data disk. Inner filesystems first, root last. Trimming
 // is harmless when no snapshot follows; it only returns free blocks.
 const isMount=async path=>(await run('findmnt',['--noheadings','--mountpoint',path],{timeout:10000})).code===0;
 const mounted=userMounted??(()=>isMount(MOUNT_POINT));
 const extra=[...(await mounted()?[MOUNT_POINT]:[]),...(dataDiskMounted?await dataDiskMounted():await isMount(DATA_DISK_MOUNT))?[DATA_DISK_MOUNT]:[]];
 for(const mount of [...extra,'/']){
  await step(`trim:${mount}`,async timeout=>{const result=await ok('fstrim',['-v',mount],timeout);trimmed[mount]=trimmedBytes(result.stdout);return {bytes:trimmed[mount]};},{limit:300000});
 }
 if(swapReleased)await step('recreate-swap',async timeout=>{
  await ok('fallocate',['-l',String(SWAP_BYTES),SWAP_FILE],timeout);await ok('chmod',['600',SWAP_FILE],10000);await ok('mkswap',[SWAP_FILE],timeout);
 },{limit:60000});
 await step('final-sync',async timeout=>{await ok('sync',[],timeout);});
 let used=null;await step('measure',async()=>{used=await usage();return used;},{limit:30000});
 const total=Object.values(trimmed).reduce((sum,n)=>sum+(n??0),0);
 return {status:'succeeded',startedAt:new Date(started).toISOString(),finishedAt:new Date(now()).toISOString(),durationMs:now()-started,trimmedBytes:total,trimmedByMount:trimmed,usedBytes:used,warnings,steps};
}

async function defaultCleanTmp(){
 // /tmp is on the root disk on Lightsail Ubuntu. Keep service-private dirs of
 // still-running units; everything else is disposable at shutdown anyway.
 const {readdir}=await import('node:fs/promises');
 for(const entry of await readdir('/tmp')){if(entry.startsWith('systemd-private-')||entry.startsWith('.X')||entry==='.ICE-unix')continue;await rm(`/tmp/${entry}`,{recursive:true,force:true});}
}
async function defaultUsage(){
 const root=await statfs('/');const rootUsed=(Number(root.blocks)-Number(root.bfree))*Number(root.bsize);
 let user=null;try{user=(await storageUsage()).usedBytes;}catch{}
 return {rootBytes:rootUsed,userBytes:user};
}

// The request file sits in the gateway's writable directory, so it is read
// with O_NOFOLLOW, size-limited, and only its request identifier is used.
// The file is removed once read (unlink never follows a link), so the
// PathExists= unit does not trigger again.
export async function readRequest(file=REQUEST_FILE){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await handle.stat();if(!info.isFile()||info.size>1024)throw Error('Invalid storage preparation request');
  const input=JSON.parse(await handle.readFile('utf8'));if(!REQUEST_ID.test(input?.requestId??''))throw Error('Invalid storage preparation request');return {requestId:input.requestId};}
 finally{await handle.close();await rm(file,{force:true});}
}
export async function writeStatus(status,file=STATUS_FILE){
 await publishRuntimeFile(file,status);
}
export async function runRequested({read=readRequest,write=writeStatus,current=async()=>{try{return JSON.parse(await readFile(STATUS_FILE,'utf8'));}catch{return null;}},prepare=prepareForSnapshot,now=Date.now}={}){
 const {requestId}=await read();
 const previous=await current();
 // Idempotent: a retried request never trims or stops twice. A run that died
 // (status still "running" long past the deadline) may be repeated.
 const stale=previous?.status==='running'&&now()-Date.parse(previous.startedAt)>DEADLINE_MS+5*60000;
 if(previous?.requestId===requestId&&['running','succeeded','failed'].includes(previous.status)&&!stale)return previous;
 await write({requestId,status:'running',startedAt:new Date(now()).toISOString()});
 let result;
 try{result={requestId,...await prepare()};}
 catch(error){result={requestId,status:'failed',error:String(error.message).slice(0,200),finishedAt:new Date().toISOString()};}
 await write(result);return result;
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 const {captureRecentFiles}=await import('./warmup.mjs');
 try{await runRequested({prepare:()=>prepareForSnapshot({captureRecent:timeout=>captureRecentFiles({timeoutMs:timeout})})});}
 catch(error){process.stderr.write(`${error.message}\n`);process.exit(1);}
}
