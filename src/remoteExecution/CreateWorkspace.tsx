import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button,TextInput} from '../components/ui';
import {canCreateWorkspace,creditExhaustedFromError,creditFloorMessage,openAccountSettings,type Credits} from '../credits';
type Plan={id:string;name:string;cpu_cores:number;memory_mib:number;pricePerMinute?:string;pricePerHour?:string;storagePricePerGibMonth?:string;storage_gib?:number;storageMode?:'disk'|'snapshot';storageNote?:string;storageMonthlyUsd?:string};
// The retained-disk size selector the plans API offers (storage_option).
type DiskSelector={minGib:number;maxGib:number;stepGib:number;freeGib:number;defaultGib:number;pricePerGibMonth:string;resize:'grow-only';sizes:{gib:number;billableGib:number;pricePerHour:string}[]};
export function CreateWorkspace({onCreated,onCancel}:{onCreated:()=>void;onCancel?:()=>void}){
 const [name,setName]=useState(''),[plan,setPlan]=useState('standard'),[region,setRegion]=useState('ap-southeast-1');
 const [options,setOptions]=useState<{plans:Plan[];regions:{id:string;name:string}[];storage?:{disk?:DiskSelector}}|null>(null),[storageGib,setStorageGib]=useState<number|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [credits,setCredits]=useState<Credits|null>(null),[creditsFailed,setCreditsFailed]=useState(false);
 const disk=options?.storage?.disk,allowed=canCreateWorkspace(credits);
 useEffect(()=>{let live=true;void invoke<Credits>('canopy_account_request',{route:'/api/credits',body:null}).then(r=>{if(live)setCredits(r);}).catch(()=>{if(live)setCreditsFailed(true);});return()=>{live=false;};},[]);
 useEffect(()=>{let live=true;void invoke<typeof options>('canopy_account_request',{route:'/api/plans',body:null}).then(r=>{if(live){setOptions(r);setStorageGib(r?.storage?.disk?.defaultGib??null);}}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[]);
 return <form className="workspace-create" onSubmit={e=>{e.preventDefault();if(busy||!options||!allowed)return;setBusy(true);setError('');void invoke('canopy_account_request',{route:'/api/workspaces',body:{name,planId:plan,regionId:region,...(disk&&storageGib!=null?{storageGib}:{})}}).then(onCreated).catch(e=>setError(creditExhaustedFromError(e)?.message??String(e))).finally(()=>setBusy(false));}}>
 {(()=>{const chosen=options?.plans.find(p=>p.id===plan);const select=(label:string,value:string,set:(v:string)=>void,items:{id:string;text:string}[])=><div className="workspace-create-row"><label htmlFor={`create-${label}`}>{label}</label><select id={`create-${label}`} value={value} onChange={e=>set(e.target.value)}>{options?items.map(i=><option key={i.id} value={i.id}>{i.text}</option>):<option>Loading…</option>}</select></div>;
 const storageNote=chosen?.storageMode==='snapshot'&&chosen.storageNote?chosen.storageNote:disk?`First ${disk.freeGib} GB included, then $${disk.pricePerGibMonth} per GB-month, billed hourly while the workspace exists (even when stopped). You can grow storage later, but not shrink it.`:chosen?.storagePricePerGibMonth?`$${chosen.storagePricePerGibMonth} per GB-month while the workspace exists, including when it’s stopped${chosen.storage_gib?` (${chosen.storage_gib} GB ≈ $${chosen.storageMonthlyUsd??(Number(chosen.storagePricePerGibMonth)*chosen.storage_gib).toFixed(2)}/month)`:''}.`:null;
 const storageSummary=disk?`${storageGib??disk.defaultGib} GB${(storageGib??disk.defaultGib)<=disk.freeGib?' included':''}`:chosen?.storage_gib?`${chosen.storage_gib} GB`:null;
 return <>
 <div className="workspace-create-row"><label htmlFor="create-name">Name</label><TextInput id="create-name" width="full" required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></div>
 {select('Size',plan,setPlan,(options?.plans??[]).map(p=>({id:p.id,text:`${p.name} · ${p.cpu_cores} CPUs · ${p.memory_mib/1024} GB`})))}
 {select('Location',region,setRegion,(options?.regions??[]).map(r=>({id:r.id,text:r.name})))}
 {(storageSummary||storageNote)&&<details className="workspace-create-storage"><summary><span>Storage</span>{storageSummary??'Details'}</summary>
  {disk&&<select aria-label="Storage" value={storageGib??disk.defaultGib} onChange={e=>setStorageGib(Number(e.target.value))}>{disk.sizes.map(s=><option key={s.gib} value={s.gib}>{s.gib} GB{s.billableGib?` · +$${s.pricePerHour}/hour`:' · included'}</option>)}</select>}
  {storageNote&&<small className="workspace-plan-note">{storageNote}</small>}
 </details>}
 {credits&&!allowed&&<div role="alert"><p>{creditFloorMessage(credits)}</p><Button type="button" variant="ghost" onClick={openAccountSettings}>Add credit</Button></div>}
 {creditsFailed&&<p role="alert">Couldn’t check your balance, so a workspace can’t be created right now. Try again.</p>}
 {error&&<p role="alert">{error}</p>}
 <footer className="add-workspace-footer"><small className="workspace-plan-note">{chosen?.pricePerHour!=null?`$${Number(chosen.pricePerHour).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4})}/hour while running. Files are kept when stopped.`:''}</small><div className="workspace-inline-actions">{onCancel&&<Button type="button" onClick={onCancel}>Cancel</Button>}<Button type="submit" variant="accent" disabled={busy||!options||!name.trim()||!allowed}>{busy?'Creating…':'Create'}</Button></div></footer>
 </>;})()}
 </form>;
}
