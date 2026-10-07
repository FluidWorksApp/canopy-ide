// Boot warm-up for snapshot-restored workspaces.
//
// A volume created from a snapshot loads each block from S3 on its first read
// (measured ~16 MB/s cold for binaries on 2026-10-07). Lightsail has no Fast
// Snapshot Restore, so the host reads ahead of the user, in priority order:
//   (a) binaries that boot services need (also prefetched by the early shell
//       unit before containerd/docker/caddy start);
//   (b) the workspace image files a previous successful start actually read
//       (captured from the page cache with fincore after that start);
//   (c) the user's recent projects: directory metadata first (what a cold
//       `git status` walks), git index/packs, recently modified files and
//       node_modules, captured at stop time;
//   (d) every other used block of the root filesystem, at idle priority, from
//       the ext4 block bitmap (free space is never read).
// Readiness never waits for (c) or (d). Progress is published for the UI.
// Restarting the service in the same boot resumes from its checkpoint.
import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,readdir,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runner} from './user-storage.mjs';

export const STATE_DIR='/var/lib/canopy-warmup';
export const STARTUP_LIST=`${STATE_DIR}/startup-files.json`;
export const RECENT_LIST=`${STATE_DIR}/recent-files.json`;
export const CHECKPOINT=`${STATE_DIR}/checkpoint.json`;
export const PROGRESS_FILE='/run/canopy/warmup.json';
export const VOLUME_ROOT='/srv/canopy/docker/volumes';
export const IMAGE_ROOTS=Object.freeze(['/srv/canopy/containerd','/srv/canopy/docker']);
export const BINARIES=Object.freeze(['/usr/local/bin/node','/usr/bin/node','/usr/bin/containerd','/usr/bin/containerd-shim-runc-v2','/usr/sbin/runc','/usr/bin/runc','/usr/bin/dockerd','/usr/bin/docker','/usr/bin/docker-proxy','/usr/bin/caddy']);
// Reads may only touch files under these trees; lists are host-written, but a
// project can contain symlinks, which are never followed.
export const ALLOWED_ROOTS=Object.freeze(['/usr/','/opt/canopy-host/','/srv/canopy/']);
export const PHASES=Object.freeze([
 {id:'binaries',label:'Loading workspace services',concurrency:8,critical:true},
 {id:'startup',label:'Loading the workspace image',concurrency:8,critical:true},
 {id:'recent',label:'Loading your recent projects',concurrency:8,critical:false},
 {id:'background',label:'Loading remaining files',concurrency:2,critical:false},
]);
const CHUNK=32*1024**2;
const allowed=path=>typeof path==='string'&&path.startsWith('/')&&!path.split('/').includes('..')&&ALLOWED_ROOTS.some(root=>path.startsWith(root));

// ext4 block bitmap -> used byte ranges of the device, split into <=32 MiB
// reads. dumpe2fs works on a mounted filesystem; stale by seconds is fine.
export function usedExtents(dump,{chunk=CHUNK}={}){
 const blockSize=Number(dump.match(/^Block size:\s+(\d+)/m)?.[1]);
 if(!Number.isSafeInteger(blockSize)||blockSize<1024)throw Error('Unreadable filesystem layout');
 const ranges=[];let group=null;
 const flush=()=>{if(!group)return;let cursor=group.start;for(const [a,b] of group.free.sort((x,y)=>x[0]-y[0])){if(a>cursor)ranges.push([cursor,a-1]);cursor=Math.max(cursor,b+1);}if(cursor<=group.end)ranges.push([cursor,group.end]);group=null;};
 for(const line of dump.split('\n')){
  const g=line.match(/^Group \d+: \(Blocks (\d+)-(\d+)\)/);
  if(g){flush();group={start:Number(g[1]),end:Number(g[2]),free:[]};continue;}
  const f=group&&line.match(/^\s+Free blocks: ?(.*)$/);
  if(f){for(const part of f[1].split(',').map(s=>s.trim()).filter(Boolean)){const [a,b=a]=part.split('-').map(Number);if(Number.isSafeInteger(a)&&Number.isSafeInteger(b))group.free.push([a,b]);}}
 }
 flush();
 const merged=[];for(const [a,b] of ranges){const last=merged.at(-1);if(last&&last[1]+1>=a)last[1]=Math.max(last[1],b);else merged.push([a,b]);}
 const extents=[];
 for(const [a,b] of merged){let offset=a*blockSize;const end=(b+1)*blockSize;while(offset<end){const length=Math.min(chunk,end-offset);extents.push({offset,length});offset+=length;}}
 return {blockSize,extents,usedBytes:extents.reduce((s,e)=>s+e.length,0)};
}

// Phases with duplicates removed: a file read in an earlier phase is skipped.
export function planWarmup({binaries=[],startup=[],recent=[],device=null,extents=[]}){
 const seen=new Set();
 const files=list=>list.filter(item=>{if(item.type==='walk')return allowed(item.path);if(!allowed(item.path)||seen.has(item.path))return false;seen.add(item.path);return true;});
 const items={
  binaries:files(binaries.map(path=>typeof path==='string'?{type:'file',path,size:0}:{type:'file',...path})),
  startup:files(startup.map(f=>({type:'file',path:f.path,size:f.size??0,direct:true}))),
  recent:files(recent.map(e=>e.type==='walk'?{type:'walk',path:e.path}:{type:'file',path:e.path,size:e.size??0})),
  background:device?extents.map(e=>({type:'extent',device,offset:e.offset,length:e.length})):[],
 };
 return PHASES.map(phase=>({...phase,items:items[phase.id],bytes:items[phase.id].reduce((s,i)=>s+(i.length??i.size??0),0)}));
}

export function progressView({phases,phaseIndex,done,bytesDone,startedAt,now=Date.now,finished=false,errors=0}){
 const total=phases.reduce((s,p)=>s+p.bytes,0);
 const critical=phases.filter(p=>p.critical).length;
 const percent=finished?100:total?Math.min(99,Math.floor(bytesDone/total*100)):0;
 const phase=phases[Math.min(phaseIndex,phases.length-1)];
 return {version:1,state:finished?'done':'warming',phase:finished?null:phase?.id??null,label:finished?'Workspace files are ready':phase?.label??'',percent,bytesDone,bytesTotal:total,criticalReady:finished||phaseIndex>=critical,errors,itemsDone:done,startedAt:new Date(startedAt).toISOString(),updatedAt:new Date(now()).toISOString()};
}

// Runs phases in order with bounded concurrency. The checkpoint stores, per
// boot, the completed phases and the count of contiguously finished items of
// the current phase, so a restart repeats at most `concurrency` reads.
export async function runWarmup({phases,read,bootId,checkpoint={load:async()=>null,save:async()=>{}},publish=async()=>{},now=Date.now,signal,onCriticalDone=async()=>{}}){
 const saved=await checkpoint.load();
 const resume=saved?.bootId===bootId?saved:null;
 let phaseIndex=resume?.phaseIndex??0,bytesDone=resume?.bytesDone??0,errors=resume?.errors??0,itemsDone=0;
 const startedAt=resume?.startedAt??now();
 let lastPublish=0;
 const report=async(force=false,finished=false)=>{if(!force&&now()-lastPublish<1000)return;lastPublish=now();await publish(progressView({phases,phaseIndex,done:itemsDone,bytesDone,startedAt,now,finished,errors}));};
 let criticalSignalled=false;
 const critical=phases.filter(p=>p.critical).length;
 for(;phaseIndex<phases.length;phaseIndex++){
  if(phaseIndex>=critical&&!criticalSignalled){criticalSignalled=true;await onCriticalDone();}
  const phase=phases[phaseIndex];
  let next=resume&&resume.phaseIndex===phaseIndex?resume.watermark??0:0;
  const finished=new Set();let watermark=next;
  const worker=async()=>{
   while(next<phase.items.length){
    if(signal?.aborted)return;
    const index=next++;const item=phase.items[index];
    try{bytesDone+=await read(item,phase);}catch{errors++;}
    itemsDone++;finished.add(index);
    while(finished.has(watermark)){finished.delete(watermark);watermark++;}
    if(now()-lastPublish>=1000){await checkpoint.save({bootId,phaseIndex,watermark,bytesDone,errors,startedAt});await report();}
   }
  };
  await Promise.all(Array.from({length:Math.max(1,Math.min(phase.concurrency,phase.items.length||1))},worker));
  if(signal?.aborted){await checkpoint.save({bootId,phaseIndex,watermark,bytesDone,errors,startedAt});return {aborted:true,bytesDone};}
  await checkpoint.save({bootId,phaseIndex:phaseIndex+1,watermark:0,bytesDone,errors,startedAt});
  await report(true);
 }
 if(!criticalSignalled)await onCriticalDone();
 await report(true,true);
 return {aborted:false,bytesDone,errors};
}

// Readers. Buffered reads leave pages cached (wanted for (a) and (c)). Direct
// reads hydrate EBS blocks without filling the page cache: (b) must not, or the
// next startup capture would record the warm-up itself; (d) must not evict
// the user's working set.
export function readers({run=runner(),openFile=open,statFile=lstat,readDir=readdir}={}){
 const buffered=async item=>{
  const info=await statFile(item.path);if(!info.isFile())return 0;
  const handle=await openFile(item.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const buffer=Buffer.allocUnsafe(1024*1024);let total=0,n;do{({bytesRead:n}=await handle.read(buffer,0,buffer.length,total));total+=n;}while(n>0);return total;}
  finally{await handle.close();}
 };
 const direct=async item=>{
  const info=await statFile(item.path);if(!info.isFile())return 0;
  const result=await run('dd',[`if=${item.path}`,'of=/dev/null','bs=1M','iflag=direct,nofollow','status=none'],{timeout:120000});
  return result.code===0?info.size:buffered(item);
 };
 const walk=async item=>{
  // Directory entries and inodes: what `git status` and file trees stat first.
  let count=0;const stack=[item.path];
  while(stack.length&&count<200000){const dir=stack.pop();let entries;try{entries=await readDir(dir,{withFileTypes:true});}catch{continue;}
   for(const entry of entries){count++;const path=join(dir,entry.name);try{await statFile(path);}catch{}if(entry.isDirectory()&&!entry.isSymbolicLink())stack.push(path);}}
  return 0;
 };
 const extent=async item=>{
  const result=await run('ionice',['-c3','nice','-n19','dd',`if=${item.device}`,'of=/dev/null','bs=4M','iflag=direct,skip_bytes,count_bytes',`skip=${item.offset}`,`count=${item.length}`,'status=none'],{timeout:300000});
  if(result.code!==0)throw Error('Block read failed');return item.length;
 };
 return async item=>item.type==='walk'?walk(item):item.type==='extent'?extent(item):item.direct?direct(item):buffered(item);
}

// (b) capture: files of the workspace image that are resident in the page
// cache shortly after a successful container start, i.e. what startup read.
export function parseFincore(output){
 const files=[];
 for(const line of output.split('\n')){const m=line.match(/^(\d+)\s+(\d+)\s+(\/.+)$/);if(m&&Number(m[1])>0)files.push({path:m[3],size:Number(m[2]),resident:Number(m[1])});}
 return files;
}
export async function captureStartupFiles({run=runner(),roots=IMAGE_ROOTS,maxFiles=50000,maxBytes=6*1024**3,write=writeJson,now=()=>new Date()}={}){
 const found=await run('find',[...roots,'-xdev','-type','f','-size','+0c','-not','-path','*/volumes/*','-print0'],{timeout:120000});
 const paths=found.stdout.split('\0').filter(path=>allowed(path)&&!/[\n\\]/.test(path));
 const files=[];
 for(let i=0;i<paths.length&&files.length<maxFiles;i+=400){
  const result=await run('fincore',['--bytes','--noheadings','--raw','--output','RES,SIZE,FILE',...paths.slice(i,i+400)],{timeout:60000});
  files.push(...parseFincore(result.stdout));
 }
 let bytes=0;const kept=[];for(const f of files){if(kept.length>=maxFiles||bytes+f.size>maxBytes)break;kept.push({path:f.path,size:f.size});bytes+=f.size;}
 await write(STARTUP_LIST,{version:1,capturedAt:now().toISOString(),files:kept});
 return {files:kept.length,bytes};
}

// (c) capture at stop: most recently active git repositories in the user's
// volumes, newest first. No git command runs as root in a user repository
// (config such as core.fsmonitor can execute code); only file metadata is read.
export async function captureRecentFiles({volumeRoot=VOLUME_ROOT,maxProjects=5,maxFiles=150000,maxBytes=4*1024**3,timeoutMs=60000,io={readdir,lstat},write=writeJson,now=Date.now}={}){
 const deadline=now()+timeoutMs;
 const list=async dir=>{try{return await io.readdir(dir,{withFileTypes:true});}catch{return [];}};
 const time=async path=>{try{const s=await io.lstat(path);return s.mtimeMs;}catch{return 0;}};
 const roots=(await list(volumeRoot)).filter(e=>e.isDirectory()&&/^canopy-(project|home)-/.test(e.name)).map(e=>join(volumeRoot,e.name,'_data'));
 const repos=[];
 for(const root of roots){
  const queue=[[root,0]];
  while(queue.length&&now()<deadline){const [dir,depth]=queue.shift();const entries=await list(dir);
   if(entries.some(e=>e.name==='.git'&&e.isDirectory())){repos.push({path:dir,active:Math.max(await time(join(dir,'.git','index')),await time(join(dir,'.git','HEAD')),await time(join(dir,'.git','logs','HEAD')))});continue;}
   if(depth<4)for(const e of entries)if(e.isDirectory()&&!e.isSymbolicLink()&&!['node_modules','.cache','.npm','.git'].includes(e.name))queue.push([join(dir,e.name),depth+1]);}
 }
 repos.sort((a,b)=>b.active-a.active);
 const entries=[];let bytes=0;
 const add=(path,size)=>{if(entries.length>=maxFiles||bytes+size>maxBytes)return false;entries.push({type:'file',path,size});bytes+=size;return true;};
 for(const repo of repos.slice(0,maxProjects)){
  if(now()>=deadline)break;
  entries.push({type:'walk',path:repo.path});
  const files=[],modules=[];
  const stack=[[repo.path,false]];
  while(stack.length&&now()<deadline&&files.length+modules.length<maxFiles){const [dir,inModules]=stack.pop();
   for(const e of await list(dir)){const path=join(dir,e.name);
    if(e.isSymbolicLink())continue;
    if(e.isDirectory()){if(e.name==='.git'&&!inModules){for(const name of ['index','HEAD','packed-refs'])files.push({path:join(path,name),mtime:Infinity,size:0});for(const p of await list(join(path,'objects','pack')))if(p.isFile())files.push({path:join(path,'objects','pack',p.name),mtime:p.name.endsWith('.idx')?Infinity:Number.MAX_VALUE,size:0});continue;}stack.push([path,inModules||e.name==='node_modules']);continue;}
    if(!e.isFile())continue;
    let info;try{info=await io.lstat(path);}catch{continue;}
    (inModules?modules:files).push({path,mtime:info.mtimeMs,size:info.size});}}
  files.sort((a,b)=>b.mtime-a.mtime);
  for(const f of [...files,...modules]){if(!add(f.path,f.size))break;}
 }
 await write(RECENT_LIST,{version:1,capturedAt:new Date(now()).toISOString(),projects:repos.slice(0,maxProjects).map(r=>r.path),entries});
 return {projects:Math.min(repos.length,maxProjects),files:entries.filter(e=>e.type==='file').length,bytes};
}

async function writeJson(file,value,mode=0o600){await mkdir(STATE_DIR,{recursive:true,mode:0o700});const temp=`${file}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(value),{mode});await rename(temp,file);}
async function readJson(file){try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}}
export async function workspaceRunning(run=runner()){const result=await run('docker',['ps','--filter','name=^canopy-ws-','--filter','status=running','--format','{{.Names}}'],{timeout:15000});return result.code===0&&result.stdout.trim().length>0;}

export async function retainedDiskLayout(run=runner()){return (await run('findmnt',['--noheadings','--mountpoint','/srv/canopy'],{timeout:10000})).code===0;}
export async function main({run=runner(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 // Retained-disk layout (today): /srv/canopy is a live block disk, not
 // restored from a snapshot, so only the root volume loads lazily. Phases
 // (b) and (c) apply to snapshot storage only.
 const retainedDisk=await retainedDiskLayout(run);
 const startup=retainedDisk?[]:(await readJson(STARTUP_LIST))?.files??[];
 const recent=retainedDisk?[]:(await readJson(RECENT_LIST))?.entries??[];
 let device=null,extents=[];
 try{
  const source=(await run('findmnt',['--noheadings','--output','SOURCE','/'],{timeout:10000})).stdout.trim();
  if(/^\/dev\/[a-z0-9]+$/.test(source)){const dump=await run('dumpe2fs',[source],{timeout:120000});if(dump.code===0){device=source;extents=usedExtents(dump.stdout).extents;}}
 }catch{}
 const phases=planWarmup({binaries:BINARIES,startup,recent,device,extents});
 const publish=async view=>{await mkdir('/run/canopy',{recursive:true,mode:0o755});const temp=`${PROGRESS_FILE}.tmp`;await writeFile(temp,JSON.stringify(view),{mode:0o644});await rename(temp,PROGRESS_FILE);};
 // Record what this start reads, once per boot, after the workspace runs.
 const capture=(async()=>{
  if(retainedDisk)return;
  const state=await readJson(CHECKPOINT);if(state?.bootId===bootId&&state.startupCaptured)return;
  for(let waited=0;waited<20*60000;waited+=5000){if(await workspaceRunning(run))break;await sleep(5000);}
  if(!(await workspaceRunning(run)))return;
  await sleep(60000);
  await captureStartupFiles({run});
  const current=await readJson(CHECKPOINT);await writeJson(CHECKPOINT,{...(current??{bootId}),startupCaptured:true});
 })().catch(()=>{});
 await runWarmup({phases,read:readers({run}),bootId,publish,checkpoint:{load:()=>readJson(CHECKPOINT),save:async value=>{const current=await readJson(CHECKPOINT);await writeJson(CHECKPOINT,{...value,startupCaptured:current?.bootId===bootId&&current.startupCaptured===true});}}});
 await capture;
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 const command=process.argv[2]??'run';
 const action=command==='run'?main:command==='capture-startup'?()=>captureStartupFiles():command==='capture-recent'?()=>captureRecentFiles():null;
 if(!action){process.stderr.write('Usage: warmup.mjs run | capture-startup | capture-recent\n');process.exit(2);}
 try{await action();}catch(error){process.stderr.write(`${error.message}\n`);process.exit(1);}
}
