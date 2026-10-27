// The VM a workspace runs on, as the gateway sees it from the host: what the
// whole machine has free, and what each runtime of one shared workspace uses
// (the owner's container and each member's own runtime container). A
// workspace's own host can't see its siblings (each container has a private
// cgroup namespace), so the gateway adds this to workspace_metrics.
//
// Only the runtimes of the workspace being asked about are listed, so a person
// sees teammates' usage only for a workspace they share.
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import {hostResources} from './host-resources.mjs';

const MiB=1048576;

/** /proc/meminfo → total and available (MemAvailable) bytes. */
export function parseMeminfo(text){
 const kb=name=>{const v=Number(String(text).match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`,'m'))?.[1]);return Number.isFinite(v)?v*1024:null;};
 const total=kb('MemTotal'),available=kb('MemAvailable');
 if(total==null||available==null)throw Error('Machine memory unavailable');
 return {totalBytes:total,availableBytes:available};
}
/** /proc/stat's aggregate cpu line → busy and total jiffies. */
export function parseProcStat(text){
 const fields=String(text).split('\n').find(line=>/^cpu\s/.test(line))?.trim().split(/\s+/).slice(1).map(Number);
 if(!fields||fields.length<4||fields.some(n=>!Number.isFinite(n)))throw Error('Machine CPU unavailable');
 const idle=fields[3]+(fields[4]??0),total=fields.slice(0,8).reduce((a,b)=>a+b,0);
 return {busy:total-idle,total};
}

export class MachineMetrics{
 /** `inspect(runtime)` answers the runtime's container (docker inspect) or
  *  null when it isn't there. */
 constructor({inspect,read=readFile,readResources=hostResources,cpus=()=>os.availableParallelism?.()??os.cpus().length,now=()=>Date.now(),minIntervalMs=1000}){
  Object.assign(this,{inspect,read,readResources,cpus,now,minIntervalMs});
  this.cpu=null;this.machineCache=null;this.containers=new Map();
 }
 /** The whole VM: memory free (MemAvailable) and cores free, from /proc. */
 async machine(){
  const at=this.now();
  if(this.machineCache&&at-this.machineCache.at<this.minIntervalMs)return this.machineCache.value;
  const [meminfo,stat]=await Promise.all([this.read('/proc/meminfo','utf8'),this.read('/proc/stat','utf8')]);
  const memory=parseMeminfo(meminfo),cpu=parseProcStat(stat),cores=this.cpus();
  const previous=this.cpu;this.cpu=cpu;
  const used=previous&&cpu.total>previous.total&&cpu.busy>=previous.busy?(cpu.busy-previous.busy)/(cpu.total-previous.total)*cores:null;
  const value={memoryTotalBytes:memory.totalBytes,memoryAvailableBytes:memory.availableBytes,cpus:cores,cpusUsed:used,cpusAvailable:used==null?null:Math.max(0,cores-used)};
  this.machineCache={at,value};
  return value;
 }
 /** One runtime container's working set and cores, or null when it isn't
  *  running or can't be read. Cores need two samples a second apart. */
 async container(runtime){
  // Several desktops poll the same workspace: one reading per interval
  // serves them all, without another docker inspect.
  const at=this.now(),old=this.containers.get(runtime.id);
  if(old&&at-old.at<this.minIntervalMs)return old.value;
  const inspected=await this.inspect(runtime).catch(()=>null);
  if(!inspected?.State?.Running){this.containers.delete(runtime.id);return null;}
  let sample;try{sample=await this.readResources(inspected);}catch{return null;}
  const usage=sample.cpuUsageUsec;
  const used=old&&old.containerId===inspected.Id&&at>old.at&&usage>=old.usage?(usage-old.usage)/((at-old.at)*1000):old?.containerId===inspected.Id?old.value.cpusUsed:null;
  const value={workingSetBytes:Math.round(sample.workingMiB*MiB),cpusUsed:used};
  this.containers.set(runtime.id,{containerId:inspected.Id,at,usage,value});
  return value;
 }
 /** The `machine` section of workspace_metrics for `viewer` on `workspace`:
  *  the VM's totals and every other runtime of this workspace. `members` are
  *  the member runtimes the gateway holds ({runtime, memberId, name}). */
 async forWorkspace(workspace,viewer,members){
  const machine=await this.machine();
  const mine=members.filter(m=>m.runtime.parentWorkspaceId===workspace.id);
  const rows=[];
  // A member sees the main workspace container (its owner and everyone
  // connected to it); the owner already sees inside it.
  if(viewer.memberId){const main=await this.container(workspace);if(main)rows.push({kind:'workspace',memberId:null,name:null,...main});}
  // One row per member: a member can briefly hold two runtimes while a
  // changed access level replaces one.
  const byMember=new Map();
  for(const m of mine){
   if(viewer.memberId&&m.memberId===viewer.memberId)continue;
   const usage=await this.container(m.runtime);if(!usage)continue;
   const row=byMember.get(m.memberId);
   if(row){row.workingSetBytes+=usage.workingSetBytes;row.cpusUsed=row.cpusUsed==null||usage.cpusUsed==null?null:row.cpusUsed+usage.cpusUsed;row.name??=m.name??null;}
   else byMember.set(m.memberId,{kind:'member',memberId:m.memberId,name:m.name??null,...usage});
  }
  rows.push(...byMember.values());
  return {...machine,runtimes:rows.slice(0,32),sampledAt:Date.now()};
 }
}
