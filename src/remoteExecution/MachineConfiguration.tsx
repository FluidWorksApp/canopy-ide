import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button} from '../components/ui';
import type {ManagedWorkspace} from './ManagedWorkspaces';

// The retained-disk size selector the plans API offers (storage_option).
export type DiskSelector={minGib:number;maxGib:number;stepGib:number;freeGib:number;defaultGib:number;pricePerGibMonth:string;resize:'grow-only';sizes:{gib:number;billableGib:number;pricePerHour:string}[]};
type Plan={id:string;name:string;cpu_cores:number;memory_mib:number;pricePerHour?:string};
export type MachineChange={planId:string|null;storageGib:number|null};
const cost=(disk:DiskSelector,gib:number)=>{const size=disk.sizes.find(s=>s.gib===gib);return size&&size.billableGib?`$${size.pricePerHour} per hour`:'included';};

/** One machine configuration: compute package and storage side by side, applied
 * together in one restart. Storage lists the current size and larger ones only
 * (Lightsail disks grow but never shrink), and a larger size must be
 * acknowledged as one-way before it can be saved. */
export function MachineConfiguration({workspace,busy=false,error='',onCancel,onSave}:{workspace:ManagedWorkspace;busy?:boolean;error?:string;onCancel:()=>void;onSave:(change:MachineChange)=>void}){
 const currentGib=Number(workspace.storage_gib)||0,currentPlan=workspace.plan_id??'';
 const [plans,setPlans]=useState<Plan[]>([]),[disk,setDisk]=useState<DiskSelector|null>(null),[loadError,setLoadError]=useState('');
 const [plan,setPlan]=useState(currentPlan),[size,setSize]=useState(currentGib),[acknowledged,setAcknowledged]=useState(false);
 useEffect(()=>{let live=true;void invoke<{plans?:Plan[];storage?:{disk?:DiskSelector}}>('canopy_account_request',{route:'/api/plans',body:null}).then(result=>{if(!live)return;setPlans(result?.plans??[]);setDisk(result?.storage?.disk??null);}).catch(e=>{if(live)setLoadError(String(e));});return()=>{live=false;};},[]);
 const canPackage=workspace.canChangePackage===true&&plans.length>0,canStorage=workspace.canGrowStorage===true&&!!disk;
 const growing=size>currentGib,changingPlan=!!plan&&plan!==currentPlan,changed=growing||changingPlan;
 const sizes=disk?.sizes.filter(s=>s.gib>=currentGib)??[];
 return <section className="workspace-stop-confirm workspace-machine-config" role="dialog" aria-modal="false" aria-labelledby="workspace-config-title">
  <strong id="workspace-config-title">Configure {workspace.name}</strong>
  <div className="workspace-machine-fields">
   <label>Compute package<select value={plan} disabled={busy||!canPackage} onChange={event=>setPlan(event.target.value)}>{!plans.some(p=>p.id===currentPlan)&&<option value={currentPlan}>{currentPlan||'Current package'}</option>}{plans.map(p=><option key={p.id} value={p.id}>{p.name} · {p.cpu_cores} CPU · {p.memory_mib/1024} GB{p.pricePerHour?` · $${Number(p.pricePerHour).toFixed(4)}/hour`:''}</option>)}</select></label>
   <label>Storage<select value={size} disabled={busy||!canStorage} onChange={event=>{setSize(Number(event.target.value));setAcknowledged(false);}}>{!sizes.length&&<option value={currentGib}>{currentGib} GB · current</option>}{sizes.map(s=><option key={s.gib} value={s.gib}>{s.gib===currentGib?`${s.gib} GB · current`:`${s.gib} GB${s.billableGib?` · +$${s.pricePerHour}/hour`:' · included'}`}</option>)}</select></label>
  </div>
  {growing&&disk&&<p>Grows to {size} GB ({cost(disk,size)}, was {cost(disk,currentGib)}). Your files move to a larger disk during the restart.</p>}
  {growing&&<label className="workspace-grow-ack"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event=>setAcknowledged(event.target.checked)}/>I understand storage can’t be reduced after it grows.</label>}
  <p className="workspace-machine-note">Changes apply in one restart; running agents, terminals and jobs stop, files and setup are kept.</p>
  {(error||loadError)&&<p className="workspace-feedback error" role="alert">{error||loadError}</p>}
  <div className="workspace-inline-actions"><Button size="sm" disabled={busy} onClick={onCancel}>Cancel</Button><Button size="sm" variant="accent" disabled={busy||!changed||growing&&!acknowledged} onClick={()=>onSave({planId:changingPlan?plan:null,storageGib:growing?size:null})}>{busy?'Applying…':'Restart and apply'}</Button></div>
 </section>;
}
