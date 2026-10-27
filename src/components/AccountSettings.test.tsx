// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AccountSettings} from './AccountSettings';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../links',()=>({openInOsBrowser:mocks.open}));
afterEach(()=>{cleanup();window.dispatchEvent(new Event('canopy:account-changed'));vi.clearAllMocks();});
it('shows dollars without revaluing the existing account and opens workspace controls',async()=>{
 mocks.invoke.mockImplementation(async(_cmd,{route})=>route==='/api/me'?{user:{name:'Sam',email:'sam@example.test'}}:{balance:'4000',balanceUsd:'40.00',paymentsEnabled:false});
 const onWorkspaces=vi.fn();render(<AccountSettings onWorkspaces={onWorkspaces}/>);
 await screen.findByText('$40.00');expect(screen.queryByText(/4000 credits/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Workspaces & plans'}));expect(onWorkspaces).toHaveBeenCalledOnce();
});
it('preserves value when connected to the earlier API',async()=>{
 mocks.invoke.mockImplementation(async(_cmd,{route})=>route==='/api/me'?{user:{name:'Sam',email:'sam@example.test'}}:{balance:'200'});
 render(<AccountSettings/>);await screen.findByText('$2.00');
});
it('provides sign-in and account creation when unauthenticated',async()=>{
 mocks.invoke.mockRejectedValue(Error('Unauthorized'));render(<AccountSettings/>);
 expect(await screen.findByRole('button',{name:'Sign in or create account'})).toBeEnabled();
 expect(screen.queryByText('$0.00')).toBeNull();
});

it('shows a loading skeleton instead of a signed-out flash',async()=>{
 let resolve!:(value:unknown)=>void;mocks.invoke.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 render(<AccountSettings/>);expect(screen.getByRole('status').textContent).toContain('Loading your account');expect(screen.queryByRole('button',{name:'Sign in or create account'})).toBeNull();
 resolve({user:{name:'Sam',email:'sam@example.test'}});await screen.findByText('sam@example.test');
});
it('reopens with the cached account and balance while refreshing',async()=>{
 mocks.invoke.mockImplementation(async(_,{route})=>route==='/api/me'?{user:{name:'Sam',email:'sam@example.test'}}:{balance:'4000',balanceUsd:'40.00'});
 const first=render(<AccountSettings/>);await screen.findByText('$40.00');first.unmount();
 mocks.invoke.mockImplementation(()=>new Promise(()=>{}));render(<AccountSettings/>);
 expect(screen.getByText('sam@example.test')).toBeTruthy();expect(screen.getByText('$40.00')).toBeTruthy();expect(screen.getByRole('status').textContent).toContain('Refreshing');
});
it('shows the paused banner with the amount owed, recent spend per workspace and the request action',async()=>{
 mocks.invoke.mockImplementation(async(_cmd,{route,body})=>route==='/api/me'?{user:{name:'Sam',email:'sam@coraa.test'}}:body?.action==='request-credit'?{requested:true}:{balanceUsd:'-64.48',paymentsEnabled:false,sessions:[{id:'s1',workspace_id:'ws-1',workspace_name:'Main',started_at:new Date().toISOString(),ended_at:null,metered_seconds:3600,consumed_usd:'1.25'},{id:'s2',workspace_id:'ws-1',workspace_name:'Main',started_at:new Date(Date.now()-86_400_000).toISOString(),ended_at:new Date().toISOString(),metered_seconds:60,consumed_usd:'0.75'}]});
 render(<AccountSettings/>);
 expect(await screen.findByRole('alert')).toHaveTextContent(/Workspaces paused.*Add at least \$54\.49/);
 expect(screen.getByRole('region',{name:'Recent usage by workspace'})).toHaveTextContent(/Main.*\$2\.00/);
 fireEvent.click(screen.getByRole('button',{name:'Request more credit'}));
 await screen.findByText(/Request sent/);
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',{route:'/api/credits',body:{action:'request-credit'}});
});
it('shows no credit banner while the balance is healthy and prefers server usage totals',async()=>{
 mocks.invoke.mockImplementation(async(_cmd,{route})=>route==='/api/me'?{user:{name:'Sam',email:'sam@example.test'}}:{balanceUsd:'40.00',paymentsEnabled:false,status:'ok',usageByWorkspace:[{workspace_id:'ws-2',workspace_name:'Data',usd:'3.5',last_at:new Date().toISOString()}],lastCreditRequestAt:new Date().toISOString()});
 render(<AccountSettings/>);await screen.findByText('$40.00');
 expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByText('Data')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Credit requested'})).toBeDisabled();
});
