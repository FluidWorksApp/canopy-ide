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
it('offers the API storage selector, shows each size per hour, and sends the chosen size',async()=>{
 const {invoke}=await import('@tauri-apps/api/core');
 const sizes=[{gib:50,billableGib:0,pricePerHour:'0.000000'},{gib:100,billableGib:50,pricePerHour:'0.008062'},{gib:1000,billableGib:950,pricePerHour:'0.153172'}];
 mocks.plans={plans:[plan('standard',{storage_gib:50})],regions:[{id:'ap-southeast-1',name:'Singapore'}],storage:{mode:'disk',disk:{minGib:50,maxGib:1000,stepGib:50,freeGib:50,defaultGib:50,pricePerGibMonth:'0.1177',resize:'grow-only',sizes}}};
 render(<CreateWorkspace onCreated={()=>{}}/>);await act(async()=>{});
 expect(screen.getByRole('option',{name:'50 GB · included'})).toBeInTheDocument();
 expect(screen.getByRole('option',{name:'1000 GB · +$0.153172/hour'})).toBeInTheDocument();
 expect(screen.getByText(/You can grow storage later, but not shrink it\./)).toBeInTheDocument();
 expect(screen.queryByRole('option',{name:/50 GB storage/})).toBeNull();
 fireEvent.change(screen.getByRole('combobox',{name:/Storage/}),{target:{value:'1000'}});
 fireEvent.change(screen.getByRole('textbox',{name:/Workspace name/}),{target:{value:'Big'}});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/Create workspace/}));});
 expect(vi.mocked(invoke)).toHaveBeenCalledWith('canopy_account_request',{route:'/api/workspaces',body:{name:'Big',planId:'standard',regionId:'ap-southeast-1',storageGib:1000}});
});
