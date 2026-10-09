import {render,screen,act,cleanup,fireEvent} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({plans:null as unknown}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>mocks.plans)}));
import {MachineConfiguration} from './MachineConfiguration';
import {WorkspaceHero} from './WorkspaceHero';
import {growPhaseLabel} from './storageStatus';
afterEach(()=>{cleanup();mocks.plans=null;});
const sizes=[50,100,150,300,1000].map(gib=>({gib,billableGib:Math.max(0,gib-50),pricePerHour:(Math.max(0,gib-50)*0.1177/730).toFixed(6)}));
const disk={minGib:50,maxGib:1000,stepGib:50,freeGib:50,defaultGib:50,pricePerGibMonth:'0.1177',resize:'grow-only',sizes};
const plans=[{id:'performance',name:'Performance',cpu_cores:8,memory_mib:32768,pricePerHour:'0.259380'},{id:'max',name:'Max',cpu_cores:16,memory_mib:65536,pricePerHour:'0.607200'}];
const workspace={id:'synthetic',name:'Machine Works',state:'ready',cpu_max:8,memory_max_mib:32768,storage_gib:100,storage_mode:'disk' as const,plan_id:'performance',canGrowStorage:true,canChangePackage:true};
const ready=async(save=vi.fn())=>{mocks.plans={plans,storage:{mode:'disk',disk}};render(<MachineConfiguration workspace={workspace} onCancel={()=>{}} onSave={save}/>);await act(async()=>{});return save;};
it('shows package and storage together: current size and larger ones only, nothing to apply until something changes',async()=>{
 await ready();
 expect(screen.getByRole('combobox',{name:/Storage/}).querySelectorAll('option')).toHaveLength(4);
 expect(screen.getByRole('option',{name:'100 GB · current'})).toBeInTheDocument();expect(screen.queryByRole('option',{name:/^50 GB/})).toBeNull();
 expect(screen.getByRole('combobox',{name:/Compute package/})).toHaveValue('performance');
 expect(screen.getByRole('button',{name:'Restart and apply'})).toBeDisabled();
});
it('a larger size needs the one-way acknowledgement, and a package change rides along in the same restart',async()=>{
 const save=await ready();
 fireEvent.change(screen.getByRole('combobox',{name:/Storage/}),{target:{value:'300'}});
 expect(screen.getByText((_,el)=>el?.tagName==='P'&&/^Grows to 300 GB \(\$0\.040308 per hour, was \$0\.008062 per hour\)/.test(el.textContent??''))).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Restart and apply'})).toBeDisabled();
 fireEvent.change(screen.getByRole('combobox',{name:/Compute package/}),{target:{value:'max'}});
 fireEvent.click(screen.getByRole('checkbox',{name:/can’t be reduced after it grows/}));
 fireEvent.click(screen.getByRole('button',{name:'Restart and apply'}));expect(save).toHaveBeenCalledWith({planId:'max',storageGib:300});
});
it('a package change alone applies without the storage acknowledgement',async()=>{
 const save=await ready();
 fireEvent.change(screen.getByRole('combobox',{name:/Compute package/}),{target:{value:'max'}});
 expect(screen.queryByRole('checkbox')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Restart and apply'}));expect(save).toHaveBeenCalledWith({planId:'max',storageGib:null});
});
it('puts Configure machine in the More menu instead of a separate storage action',()=>{
 const configure=vi.fn();render(<WorkspaceHero workspace={workspace} onOpen={()=>{}} onConfigure={configure}/>);
 screen.getByLabelText('More actions for Machine Works').closest('details')!.open=true;
 expect(screen.queryByRole('button',{name:/Grow storage/})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/Configure machine…\s*Compute package and storage/}));expect(configure).toHaveBeenCalledOnce();
});
it('labels each step of a storage grow, naming the target size',()=>{
 expect(growPhaseLabel({action:'grow-storage',phase:'saving-storage',target_storage_gib:300})).toBe('Growing storage to 300 GB… saving your files');
 expect(growPhaseLabel({action:'resume',phase:'saving-storage'})).toBeNull();
});
