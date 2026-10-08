import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button} from '../components/ui';
import type {ManagedWorkspace} from './ManagedWorkspaces';

// The retained-disk size selector the plans API offers (storage_option).
export type DiskSelector={minGib:number;maxGib:number;stepGib:number;freeGib:number;defaultGib:number;pricePerGibMonth:string;resize:'grow-only';sizes:{gib:number;billableGib:number;pricePerHour:string}[]};
const cost=(disk:DiskSelector,gib:number)=>{const size=disk.sizes.find(s=>s.gib===gib);return size&&size.billableGib?`$${size.pricePerHour} per hour`:'included';};

/** Grow a workspace's retained disk. Lightsail only creates a disk from a
 * snapshot at the same or a larger size, so this offers larger sizes only and
 * asks the person to acknowledge that storage cannot shrink again. */
export function GrowStorage({workspace,busy=false,error='',onCancel,onGrow}:{workspace:ManagedWorkspace;busy?:boolean;error?:string;onCancel:()=>void;onGrow:(storageGib:number)=>void}){
 const current=Number(workspace.storage_gib)||0;
 const [disk,setDisk]=useState<DiskSelector|null>(null),[loadError,setLoadError]=useState(''),[size,setSize]=useState<number|null>(null),[acknowledged,setAcknowledged]=useState(false);
 useEffect(()=>{let live=true;void invoke<{storage?:{disk?:DiskSelector}}>('canopy_account_request',{route:'/api/plans',body:null}).then(plans=>{if(!live)return;const selector=plans?.storage?.disk??null;setDisk(selector);setSize(selector?.sizes.find(s=>s.gib>current)?.gib??null);if(!selector)setLoadError('Storage sizes aren’t available for this workspace.');}).catch(e=>{if(live)setLoadError(String(e));});return()=>{live=false;};},[current]);
 const larger=disk?.sizes.filter(s=>s.gib>current)??[];
 return <section className="workspace-stop-confirm" role="alertdialog" aria-modal="false" aria-labelledby="workspace-grow-title">
  <strong id="workspace-grow-title">Grow storage for {workspace.name}?</strong>
  {disk&&<p>This workspace has {current} GB of storage ({cost(disk,current)}).</p>}
  {disk&&!larger.length&&<p>This workspace already has the largest storage available ({disk.maxGib} GB).</p>}
  {disk&&!!larger.length&&size!=null&&<>
   <label>New size<select value={size} disabled={busy} onChange={event=>setSize(Number(event.target.value))}>{larger.map(s=><option key={s.gib} value={s.gib}>{s.gib} GB{s.billableGib?` · +$${s.pricePerHour}/hour`:' · included'}</option>)}</select></label>
   <p>New storage: {size} GB ({cost(disk,size)}, was {cost(disk,current)}). Charged by the hour for as long as the workspace exists, including when it’s stopped.</p>
   <p>The workspace stops, your files are copied to a larger disk, and it starts again. This usually takes a few minutes. Running agents, terminals and jobs stop, including those used by other connected people.</p>
   <label className="workspace-grow-ack"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event=>setAcknowledged(event.target.checked)}/>I understand storage can’t be reduced after it grows.</label>
  </>}
  {(error||loadError)&&<p className="workspace-feedback error" role="alert">{error||loadError}</p>}
  <div className="workspace-inline-actions"><Button disabled={busy} onClick={onCancel}>Cancel</Button><Button variant="accent" disabled={busy||!acknowledged||size==null||size<=current} onClick={()=>size!=null&&onGrow(size)}>{busy?'Starting…':size!=null?`Grow to ${size} GB`:'Grow storage'}</Button></div>
 </section>;
}
