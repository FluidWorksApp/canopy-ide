import {readFile} from 'node:fs/promises';
export function cpuPercent(previous,current,cpus){
 if(!previous||current.time<=previous.time||current.usage<previous.usage)return null;
 return Math.max(0,Math.min(100,(current.usage-previous.usage)/((current.time-previous.time)*1000*cpus)*100));
}
/** Cores in use between two samples (usage_usec over wall-clock ms), or null.
 *  Works without a CPU quota, unlike the percentage. */
export function cpusUsed(previous,current){
 if(!previous||current.time<=previous.time||current.usage<previous.usage)return null;
 return Math.max(0,(current.usage-previous.usage)/((current.time-previous.time)*1000));
}
/** cgroup v2 memory.stat as {key: bytes}; null when it has no counters. */
export function parseMemoryStat(raw){
 const stat={};
 for(const line of String(raw??'').split('\n')){const [key,value]=line.trim().split(/\s+/);if(key&&/^\d+$/.test(value??''))stat[key]=Number(value);}
 return Object.keys(stat).length?stat:null;
}
const KERNEL_PARTS=['slab','kernel_stack','pagetables','percpu'];
/** What the workspace's memory is actually doing. memory.current counts the
 *  page cache, much of which the kernel drops the moment anything asks for
 *  memory, so "in use" is the working set: memory.current − inactive_file,
 *  the number Kubernetes and `docker stats` report. Without memory.stat the
 *  working set is memory.current: an over-count, never an under-count. */
export function memoryFigures(current,limit,stat){
 const reclaimable=stat&&Number.isFinite(stat.inactive_file)?Math.min(current,stat.inactive_file):null;
 const workingSet=Math.max(0,current-(reclaimable??0));
 // `kernel` is newer kernels' total; older ones only have its parts.
 const kernel=!stat?null:Number.isFinite(stat.kernel)?stat.kernel:KERNEL_PARTS.some(k=>Number.isFinite(stat[k]))?KERNEL_PARTS.reduce((sum,k)=>sum+(stat[k]??0),0):null;
 // cgroup v2 `file` includes shmem (tmpfs, /dev/shm), which can't be dropped
 // like cache, so the breakdown lists them apart and its parts add up.
 const breakdown=stat&&Number.isFinite(stat.anon)&&Number.isFinite(stat.file)?{anonBytes:stat.anon,fileBytes:Math.max(0,stat.file-(stat.shmem??0)),shmemBytes:stat.shmem??0,kernelBytes:kernel,activeFileBytes:stat.active_file??null,inactiveFileBytes:stat.inactive_file??null}:null;
 return {workingSetBytes:workingSet,availableBytes:limit==null?null:Math.max(0,limit-workingSet),reclaimableBytes:reclaimable,memoryBreakdown:breakdown};
}
export function metricsReader(read=readFile,now=()=>performance.now()){
 let previous;
 return async()=>{
  const [memory,limit,cpu,quota]=await Promise.all(['memory.current','memory.max','cpu.stat','cpu.max'].map(file=>read('/sys/fs/cgroup/'+file,'utf8')));
  // Optional: a kernel or runtime without memory.stat still reports totals.
  const stat=await Promise.resolve().then(()=>read('/sys/fs/cgroup/memory.stat','utf8')).then(parseMemoryStat,()=>null);
  const parts=quota.trim().split(/\s+/),cpus=parts[0]==='max'?null:Number(parts[0])/Number(parts[1]);
  const usage=Number(cpu.match(/^usage_usec\s+(\d+)/m)?.[1]);
  if(!Number.isFinite(usage)||!Number.isFinite(Number(memory)))throw Error('Workspace metrics unavailable');
  const current={time:now(),usage};const percent=cpus?cpuPercent(previous,current,cpus):null;const used=cpusUsed(previous,current);previous=current;
  const memoryBytes=Number(memory),memoryLimitBytes=limit.trim()==='max'?null:Number(limit);
  return {
   // What older desktops read: memoryBytes stays memory.current.
   memoryBytes,memoryLimitBytes,cpuPercent:percent,cpus,scope:'workspace',sampledAt:Date.now(),
   ...memoryFigures(memoryBytes,memoryLimitBytes,stat),
   cpusUsed:used,cpusAvailable:cpus!=null&&used!=null?Math.max(0,cpus-used):null,
  };
 };
}
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)?value.trim():null;
/** Who started a terminal, as its desktop recorded it in the terminal's
 *  metadata at spawn ({id, name}); null for terminals from older desktops. */
export function sessionOwner(meta){
 const owner=meta?.owner,id=text(owner?.id,256);
 return id?{id,name:text(owner?.name,80)??'Teammate'}:null;
}
/** The governor's last pass over the live terminals, as the status bar's
 *  per-person attribution reads it: each terminal's working set (its cgroup's,
 *  cache left out, when it has one; else its processes' resident set), the
 *  cores its processes used, and who started it. A pass older than `maxAgeMs`
 *  is no answer: the terminals may be long gone. */
export function sessionUsage(pass,now=Date.now(),maxAgeMs=10_000){
 if(!pass||!Array.isArray(pass.sessions)||now-pass.at>maxAgeMs)return null;
 return pass.sessions.slice(0,32).map(o=>({id:o.id,memoryBytes:Math.max(0,Number(o.workingSet??o.bytes)||0),cpusUsed:Math.max(0,Number(o.cpu)||0)/100,kind:o.kind==='build'?'build':'terminal',owner:sessionOwner(o.meta)}));
}
