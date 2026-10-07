import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button,TextInput} from '../components/ui';
type Plan={id:string;name:string;cpu_cores:number;memory_mib:number;pricePerMinute?:string};
export function CreateWorkspace({onCreated}:{onCreated:()=>void}){
 const [name,setName]=useState(''),[plan,setPlan]=useState('standard'),[region,setRegion]=useState('ap-southeast-1');
 const [options,setOptions]=useState<{plans:Plan[];regions:{id:string;name:string}[]}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;void invoke<typeof options>('canopy_account_request',{route:'/api/plans',body:null}).then(r=>{if(live)setOptions(r);}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[]);
 return <form className="workspace-create" onSubmit={e=>{e.preventDefault();if(busy||!options)return;setBusy(true);setError('');void invoke('canopy_account_request',{route:'/api/workspaces',body:{name,planId:plan,regionId:region}}).then(onCreated).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>
 <h3>New workspace</h3><p className="workspace-description">Choose where your projects run. Compute starts when you open the workspace.</p>
 <label>Workspace name<TextInput width="full" required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>
 <label>Size<select value={plan} onChange={e=>setPlan(e.target.value)}>{options?.plans.map(p=><option key={p.id} value={p.id}>{p.name} · {p.cpu_cores} CPUs · {p.memory_mib/1024} GB{p.pricePerMinute!=null?` · $${Number(p.pricePerMinute).toFixed(4)}/min`:''}</option>)}</select></label>
 <label>Location<select value={region} onChange={e=>setRegion(e.target.value)}>{options?.regions.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
 {error&&<p role="alert">{error}</p>}<Button type="submit" variant="accent" disabled={busy||!options||!name.trim()}>{busy?'Creating…':'Create workspace'}</Button>
 </form>;
}
