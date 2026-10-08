import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button,TextInput} from '../components/ui';
type Plan={id:string;name:string;cpu_cores:number;memory_mib:number;pricePerMinute?:string;pricePerHour?:string;storagePricePerGibMonth?:string;storage_gib?:number;storageMode?:'disk'|'snapshot';storageNote?:string;storageMonthlyUsd?:string};
// The retained-disk size selector the plans API offers (storage_option).
type DiskSelector={minGib:number;maxGib:number;stepGib:number;freeGib:number;defaultGib:number;pricePerGibMonth:string;resize:'grow-only';sizes:{gib:number;billableGib:number;pricePerHour:string}[]};
export function CreateWorkspace({onCreated}:{onCreated:()=>void}){
 const [name,setName]=useState(''),[plan,setPlan]=useState('standard'),[region,setRegion]=useState('ap-southeast-1');
 const [options,setOptions]=useState<{plans:Plan[];regions:{id:string;name:string}[];storage?:{disk?:DiskSelector}}|null>(null),[storageGib,setStorageGib]=useState<number|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const disk=options?.storage?.disk;
 useEffect(()=>{let live=true;void invoke<typeof options>('canopy_account_request',{route:'/api/plans',body:null}).then(r=>{if(live){setOptions(r);setStorageGib(r?.storage?.disk?.defaultGib??null);}}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[]);
 return <form className="workspace-create" onSubmit={e=>{e.preventDefault();if(busy||!options)return;setBusy(true);setError('');void invoke('canopy_account_request',{route:'/api/workspaces',body:{name,planId:plan,regionId:region,...(disk&&storageGib!=null?{storageGib}:{})}}).then(onCreated).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>
 <h3>New workspace</h3><p className="workspace-description">Choose where your projects run. Compute starts when you open the workspace.</p>
 <label>Workspace name<TextInput width="full" required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
 <label>Size<select value={plan} onChange={e=>setPlan(e.target.value)}>{options?.plans.map(p=><option key={p.id} value={p.id}>{p.name} · {p.cpu_cores} CPUs · {p.memory_mib/1024} GB{p.storage_gib&&!disk?` · ${p.storage_gib} GB storage`:''}{p.pricePerHour!=null?` · $${Number(p.pricePerHour).toFixed(4)}/hour while running`:''}</option>)}</select>{(()=>{const chosen=options?.plans.find(p=>p.id===plan);if(chosen?.storageMode==='snapshot'&&chosen.storageNote)return <small className="workspace-plan-note">{chosen.storageNote}</small>;if(options?.storage?.disk)return null;const storage=chosen?.storagePricePerGibMonth;if(!storage)return null;const disk=chosen.storage_gib,monthly=chosen.storageMonthlyUsd??(disk?(Number(storage)*disk).toFixed(2):null);return <small className="workspace-plan-note">Storage: ${storage} per GB-month while the workspace exists, including when it’s stopped{disk&&monthly?` (${disk} GB ≈ $${monthly}/month)`:''}.</small>;})()}</label>
 {disk&&<label>Storage<select value={storageGib??disk.defaultGib} onChange={e=>setStorageGib(Number(e.target.value))}>{disk.sizes.map(s=><option key={s.gib} value={s.gib}>{s.gib} GB{s.billableGib?` · +$${s.pricePerHour}/hour`:' · included'}</option>)}</select><small className="workspace-plan-note">The first {disk.freeGib} GB are included. Storage above that costs ${disk.pricePerGibMonth} per GB-month, charged by the hour for as long as the workspace exists, including when it’s stopped. You can grow storage later, but not shrink it.</small></label>}
 <label>Location<select value={region} onChange={e=>setRegion(e.target.value)}>{options?.regions.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
 {error&&<p role="alert">{error}</p>}<Button type="submit" variant="accent" disabled={busy||!options||!name.trim()}>{busy?'Creating…':'Create workspace'}</Button>
 </form>;
}
