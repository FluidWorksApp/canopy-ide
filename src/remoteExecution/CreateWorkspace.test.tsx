import {render,screen,act,cleanup,fireEvent} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({plans:null as unknown}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>mocks.plans)}));
import {CreateWorkspace} from './CreateWorkspace';
afterEach(()=>{cleanup();mocks.plans=null;});
const plan=(id:string,extra:object)=>({id,name:id,cpu_cores:2,memory_mib:8192,pricePerHour:'0.1',storagePricePerGibMonth:'0.1177',storageMode:'disk',...extra});
it('shows the disk size and monthly estimate the plans API reports, not a fixed 50 GB',async()=>{
 mocks.plans={plans:[plan('standard',{storage_gib:100,storageMonthlyUsd:'11.77'}),plan('power',{storage_gib:100})],regions:[{id:'ap-southeast-1',name:'Singapore'}]};
 render(<CreateWorkspace onCreated={()=>{}}/>);await act(async()=>{});
 expect(screen.getByText(/\(100 GB ≈ \$11\.77\/month\)/)).toBeInTheDocument();
 expect(screen.getByRole('option',{name:/standard · 2 CPUs · 8 GB · 100 GB storage/})).toBeInTheDocument();
 fireEvent.change(screen.getByRole('combobox',{name:/Size/}),{target:{value:'power'}});
 expect(screen.getByText(/\(100 GB ≈ \$11\.77\/month\)/)).toBeInTheDocument();
 expect(screen.queryByText(/50 GB/)).toBeNull();
});
it('omits the estimate when the API reports no disk size',async()=>{
 mocks.plans={plans:[plan('standard',{})],regions:[]};
 render(<CreateWorkspace onCreated={()=>{}}/>);await act(async()=>{});
 expect(screen.getByText(/Storage: \$0\.1177 per GB-month while the workspace exists, including when it’s stopped\.$/)).toBeInTheDocument();
});
