import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('./workspace',()=>({activeWorkspace:()=>undefined}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../links',()=>({openLink:vi.fn()}));
vi.mock('./RemoteDesktop',()=>({RemoteDesktop:()=>null}));
vi.mock('../components/WorkspaceSharing',()=>({WorkspaceSharing:()=>null}));
vi.mock('../components/SharedSessionsPanel',()=>({SharedSessionsPanel:()=>null}));
vi.mock('./WorkspaceOwnerTools',()=>({WorkspaceOwnerTools:()=>null}));
import {WorkspaceSelector} from './WorkspaceSelector';
import {dismissStopSwitchNotice,markStopRequested,resetWorkspaceLifecycle,saveStopSwitchNotice} from './workspaceLifecycle';

afterEach(()=>{cleanup();resetWorkspaceLifecycle();dismissStopSwitchNotice();vi.useRealTimers();vi.clearAllMocks();});
function serve(){
 const server={state:'ready',operation:{phase:'quiesce',status:'pending',action:'hibernate'} as object|null};
 mocks.invoke.mockImplementation(async(command:string,args?:{route?:string})=>{
  if(command==='execution_remote_list')return [];
  if(command!=='canopy_account_request')return null;
  if(args?.route==='/api/workspaces')return {workspaces:[{id:'machine-works',name:'Machine Works',provider:'lightsail',state:server.state,operation:server.operation,cpu_max:2,memory_max_mib:8192,access:{owner:true,canManageAccess:true,canStop:true,canConnect:true}}]};
  return {};
 });
 return server;
}

it('after leaving a stopped workspace, says so and follows the stop to Stopped',async()=>{
 vi.useFakeTimers();const server=serve();
 markStopRequested('machine-works');
 saveStopSwitchNotice({workspaceId:'machine-works',name:'Machine Works',at:Date.now()});
 render(<WorkspaceSelector/>);await act(async()=>{});
 const notice=screen.getByRole('complementary',{name:'Workspace stop'});
 expect(within(notice).getByText('Stopping Machine Works')).toBeInTheDocument();
 expect(within(notice).getByText(/You’re now on your Local workspace/)).toBeInTheDocument();
 expect(within(notice).getByRole('status')).toHaveTextContent('Stopping…');
 // Header menu and sidebar agree with the notice; the row cannot be reopened.
 fireEvent.click(screen.getByRole('button',{name:/Local workspace/}));
 const row=screen.getByRole('menuitemradio',{name:/Machine Works/});
 expect(row).toHaveTextContent('Stopping…');expect(row).toHaveAttribute('aria-disabled','true');
 fireEvent.click(screen.getByRole('menuitem',{name:/Manage workspaces/}));
 fireEvent.click(screen.getByRole('tab',{name:'Machine Works'}));await act(async()=>{});
 expect(screen.getByRole('tab',{name:'Machine Works'})).toHaveTextContent('Stopping…');
 expect(screen.getByRole('heading',{name:'Workspace is stopping'})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Open workspace'})).toBeNull();
 server.state='stopped';server.operation={phase:'complete',status:'succeeded',action:'hibernate'};
 await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 expect(within(notice).getByText('Machine Works stopped')).toBeInTheDocument();
 expect(screen.getByRole('tab',{name:'Machine Works'})).toHaveTextContent('Stopped');
 expect(screen.getByRole('button',{name:'Resume workspace'})).toBeInTheDocument();
 fireEvent.click(within(notice).getByRole('button',{name:'Dismiss'}));
 expect(screen.queryByRole('complementary',{name:'Workspace stop'})).toBeNull();
});
