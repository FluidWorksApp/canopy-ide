import {useEffect,useState} from 'react';
import {activeWorkspace} from './workspace';
// Snapshot-backed managed workspaces: the control plane reports the package's
// storage size and the user files measured at the last stop; the host reports
// live usage and boot warm-up progress (GET /v1/workspaces/:id/storage).
export type StorageLevel='ok'|'warning'|'critical'|'unknown';
export type HostStorage={mode:'snapshot'|'disk';storageGiB:number|null;usage:{usedBytes:number;capacityBytes:number;percent:number;level:StorageLevel}|null;warmup:{state:'warming'|'done';phase:string|null;label:string;percent:number;criticalReady:boolean}|null};
export const STORAGE_WARNING=0.8,STORAGE_CRITICAL=0.95;
const GIB=1024**3;
export function storageLevel(usedBytes:number,capacityBytes:number):StorageLevel{
 if(!(capacityBytes>0)||!(usedBytes>=0))return 'unknown';
 const ratio=usedBytes/capacityBytes;return ratio>=STORAGE_CRITICAL?'critical':ratio>=STORAGE_WARNING?'warning':'ok';
}
export const storageLabel=(gib:number|null|undefined)=>Number.isFinite(gib)&&gib!>0?`${gib} GB storage`:null;
export function formatBytes(bytes:number){return bytes>=1e9?`${(bytes/1e9).toFixed(1)} GB`:`${Math.max(0,Math.round(bytes/1e6))} MB`;}
export function storageWarning(level:StorageLevel,capacityGb:number){
 if(level==='critical')return `Storage is almost full. Delete files or move to a larger package before writes start failing at ${capacityGb} GB.`;
 if(level==='warning')return 'Storage is over 80% full. Consider freeing space or moving to a larger package.';
 return null;
}
// Usage from the API (measured when the workspace last stopped) when the host
// is not reachable; live host usage replaces it while connected.
export function apiUsage(workspace:{storage_gib?:number|null;storage_used_bytes?:number|string|null}){
 const used=Number(workspace.storage_used_bytes),gib=Number(workspace.storage_gib);
 if(workspace.storage_used_bytes==null||!Number.isFinite(used)||!(gib>0))return null;
 const capacityBytes=gib*GIB;return {usedBytes:used,capacityBytes,percent:Math.min(100,Math.round(used/capacityBytes*1000)/10),level:storageLevel(used,capacityBytes)};
}
// Server phases of a snapshot-storage stop (canopy-website snapshot-reconciler).
const SAVE_PHASES:Record<string,string>={
 'saving-workspace':'Saving your workspace… cleaning up and compacting files',
 'stopping':'Saving your workspace… stopping the machine',
 'saving-snapshot':'Saving your workspace… storing a copy of your disk',
 'deleting-compute':'Saving your workspace… releasing compute',
 'retiring-previous-snapshot':'Saving your workspace… removing the older copy',
 'retiring-previous-storage':'Saving your workspace… removing the old disk',
};
export function savePhaseLabel(phase:string|null|undefined,progress?:string|null){
 const label=phase?SAVE_PHASES[phase]:undefined;if(!label)return null;
 return phase==='saving-snapshot'&&progress&&/^\d{1,3}%$/.test(progress)?`${label} (${progress})`:label;
}
// Server phases of growing a retained disk (canopy-website reconciler, grow-storage).
const GROW_PHASES:Record<string,string>={
 'stopping':'Growing storage… stopping the workspace',
 'retaining-storage':'Growing storage… stopping the workspace',
 'saving-storage':'Growing storage… saving your files',
 'growing-storage':'Growing storage… creating the larger disk',
 'creating-compute':'Growing storage… starting the workspace on the larger disk',
 'starting':'Growing storage… starting the workspace on the larger disk',
 'attaching-storage':'Growing storage… connecting the larger disk',
 'preparing-workspace':'Growing storage… preparing your tools',
 'connecting-workspace':'Growing storage… checking the connection',
 'retiring-previous-compute':'Growing storage… finishing up',
 'retiring-previous-storage':'Growing storage… removing the old disk',
};
export function growPhaseLabel(operation:{action?:string|null;phase?:string|null;target_storage_gib?:number|null}|null|undefined){
 if(operation?.action!=='grow-storage'||!operation.phase)return null;
 const label=GROW_PHASES[operation.phase];if(!label)return null;
 return operation.target_storage_gib?label.replace('Growing storage…',`Growing storage to ${operation.target_storage_gib} GB…`):label;
}
export function warmupLabel(warmup:HostStorage['warmup']){
 if(!warmup||warmup.state==='done')return null;
 return `Warming up files… ${Math.max(0,Math.min(99,Math.round(warmup.percent)))}%`;
}
/** Live storage for the connected workspace, polled while it stays active. */
export function useHostStorage(workspaceId:string|undefined,{intervalMs=15000}:{intervalMs?:number}={}){
 const [storage,setStorage]=useState<HostStorage|null>(null);
 useEffect(()=>{
  setStorage(null);if(!workspaceId)return;let live=true;
  const load=async()=>{const host=activeWorkspace();if(!host||host.connection.workspaceId!==workspaceId)return;try{const next=await host.client.workspace<HostStorage>(workspaceId,'/storage');if(live)setStorage(next);}catch{/* Host storage is advisory; keep the last value. */}};
  void load();const timer=setInterval(()=>void load(),intervalMs);return()=>{live=false;clearInterval(timer);};
 },[workspaceId,intervalMs]);
 return storage;
}
