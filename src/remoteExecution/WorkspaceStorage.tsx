import {apiUsage,formatBytes,storageWarning,useHostStorage,warmupLabel,type HostStorage} from './storageStatus';
type StorageWorkspace={id:string;state:string;storage_gib?:number|null;storage_mode?:string|null;storage_used_bytes?:number|string|null};
/** Storage usage (80%/95% warnings) and boot warm-up progress for a managed
 * workspace. Live values come from the connected host; otherwise the usage
 * measured when the workspace last stopped. */
export function WorkspaceStorage({workspace,live:provided}:{workspace:StorageWorkspace;live?:HostStorage|null}){
 const polled=useHostStorage(provided===undefined&&workspace.state==='ready'?workspace.id:undefined);
 const live=provided??polled;
 const usage=live?.usage??apiUsage(workspace);
 const warming=warmupLabel(live?.warmup??null);
 if(!usage&&!warming)return null;
 const capacityGb=Math.round((usage?.capacityBytes??0)/1024**3);
 const warning=usage?storageWarning(usage.level,capacityGb):null;
 return <div className="workspace-storage">
  {usage&&<><div className="workspace-storage-meter" role="meter" aria-label="Workspace storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage.percent} aria-valuetext={`${formatBytes(usage.usedBytes)} of ${capacityGb} GB used`}><span className={`workspace-storage-fill ${usage.level}`} style={{width:`${Math.max(1,Math.min(100,usage.percent))}%`}}/></div>
  <small className="workspace-storage-text">{formatBytes(usage.usedBytes)} of {capacityGb} GB used{live?.usage?'':' · measured at last stop'}</small>
  {warning&&<small className={`workspace-storage-warning ${usage.level}`} role={usage.level==='critical'?'alert':'status'}>{warning}</small>}</>}
  {warming&&<small className="workspace-storage-warmup" role="status">{warming}<span className="workspace-storage-warmup-note"> · you can keep working while files load</span></small>}
 </div>;
}
