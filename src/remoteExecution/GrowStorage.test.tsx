import {render,screen,act,cleanup,fireEvent} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({plans:null as unknown}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>mocks.plans)}));
import {GrowStorage} from './GrowStorage';
import {WorkspaceHero} from './WorkspaceHero';
import {growPhaseLabel} from './storageStatus';
afterEach(()=>{cleanup();mocks.plans=null;});
const sizes=[50,100,150,200,1000].map(gib=>({gib,billableGib:Math.max(0,gib-50),pricePerHour:(Math.max(0,gib-50)*0.1177/730).toFixed(6)}));
const disk={minGib:50,maxGib:1000,stepGib:50,freeGib:50,defaultGib:50,pricePerGibMonth:'0.1177',resize:'grow-only',sizes};
const workspace={id:'synthetic',name:'Machine Works',state:'ready',cpu_max:8,memory_max_mib:32768,storage_gib:100,storage_mode:'disk' as const,canGrowStorage:true};
it('offers only larger sizes with their hourly price, and grows only after the one-way acknowledgement',async()=>{
 mocks.plans={plans:[],storage:{mode:'disk',disk}};const grow=vi.fn();
 render(<GrowStorage workspace={workspace} onCancel={()=>{}} onGrow={grow}/>);await act(async()=>{});
 expect(screen.getByText(/This workspace has 100 GB of storage \(\$0\.008062 per hour\)/)).toBeInTheDocument();
 expect(screen.getAllByRole('option').map(o=>o.textContent)).toEqual(['150 GB · +$0.016123/hour','200 GB · +$0.024185/hour','1000 GB · +$0.153171/hour']);
 const confirm=screen.getByRole('button',{name:'Grow to 150 GB'});expect(confirm).toBeDisabled();
 fireEvent.change(screen.getByRole('combobox',{name:/New size/}),{target:{value:'1000'}});
 expect(screen.getByText(/New storage: 1000 GB \(\$0\.153171 per hour, was \$0\.008062 per hour\)/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('checkbox',{name:/can’t be reduced after it grows/}));
 fireEvent.click(screen.getByRole('button',{name:'Grow to 1000 GB'}));expect(grow).toHaveBeenCalledWith(1000);
});
it('says when the workspace already has the largest storage',async()=>{
 mocks.plans={plans:[],storage:{mode:'disk',disk}};
 render(<GrowStorage workspace={{...workspace,storage_gib:1000}} onCancel={()=>{}} onGrow={()=>{}}/>);await act(async()=>{});
 expect(screen.getByText(/already has the largest storage available \(1000 GB\)/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'Grow storage'})).toBeDisabled();
});
it('puts Grow storage in the More menu with the current size and the one-way note',()=>{
 const grow=vi.fn();render(<WorkspaceHero workspace={workspace} onOpen={()=>{}} onGrowStorage={grow}/>);
 screen.getByLabelText('More actions for Machine Works').closest('details')!.open=true;
 fireEvent.click(screen.getByRole('button',{name:/Grow storage…\s*Now 100 GB · can’t be reduced later/}));expect(grow).toHaveBeenCalledOnce();
});
it('labels each step of a storage grow, naming the target size',()=>{
 expect(growPhaseLabel({action:'grow-storage',phase:'saving-storage',target_storage_gib:300})).toBe('Growing storage to 300 GB… saving your files');
 expect(growPhaseLabel({action:'grow-storage',phase:'retiring-previous-storage'})).toBe('Growing storage… removing the old disk');
 expect(growPhaseLabel({action:'resume',phase:'saving-storage'})).toBeNull();
});
