import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,fireEvent,act,cleanup} from '@testing-library/react';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),canSwitch:vi.fn(()=>true),switchMode:vi.fn(),active:vi.fn<()=>unknown>(()=>null)}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../components/AccountSettings',()=>({AccountSettings:()=>null}));
vi.mock('../components/ui',()=>({Button:({children,...props}:React.ComponentProps<'button'>)=><button {...props}>{children}</button>,TextInput:({width:_,...props}:React.ComponentProps<'input'>&{width?:string})=><input {...props}/>}));
vi.mock('../executionMode',()=>({canSwitchExecutionMode:mocks.canSwitch,setExecutionMode:mocks.switchMode}));
vi.mock('./workspace',()=>({activeWorkspace:mocks.active}));
vi.mock('./client',()=>({RemoteExecutionClient:class{workspace=vi.fn();}}));
import {ManagedWorkspaces} from './ManagedWorkspaces';
import {connectionKey,reportWorkspaceLifecycle,workspaceLifecyclePhase} from './connectionState';
import {dismissStopSwitchNotice,resetWorkspaceLifecycle,STOP_ACKNOWLEDGE_TIMEOUT_MS,takeStopSwitchNotice} from './workspaceLifecycle';

const endpoint='https://ws-test.workspaces.canopyide.dev',key=connectionKey(endpoint,'ws-test');
afterEach(()=>{cleanup();reportWorkspaceLifecycle(key,null);resetWorkspaceLifecycle();dismissStopSwitchNotice();vi.useRealTimers();vi.clearAllMocks();mocks.active.mockReturnValue(null);});

type Server={state:string;operation:ManagedWorkspaceOperation|null;stop:()=>Promise<unknown>};
type ManagedWorkspaceOperation={phase:string;status:string;action?:string;last_error?:string};
function setup(){
 vi.useFakeTimers();
 const server:Server={state:'ready',operation:null,stop:async()=>({accepted:true})};
 mocks.invoke.mockImplementation(async(command:string,args:{route:string;body?:{action?:string}})=>{
  if(command!=='canopy_account_request')return;
  if(args.route==='/api/workspaces')return {workspaces:[{id:'ws-test',name:'Machine Works',provider:'lightsail',state:server.state,operation:server.operation,cpu_max:2,memory_max_mib:8192,canDelete:true,access:{owner:true,canManageAccess:true,canStop:true,canConnect:true}}]};
  if(args.body?.action==='hibernate')return server.stop();
  return {};
 });
 return server;
}
const deferred=()=>{let resolve!:(value:unknown)=>void,reject!:(error:unknown)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const badge=()=>document.querySelector('.workspace-status-badge')?.textContent;
async function requestStop(){
 fireEvent.click(screen.getByLabelText('More actions for Machine Works'));
 fireEvent.click(screen.getByRole('button',{name:/Stop workspace/}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm stop'}));await act(async()=>{});
}

it('moves Running → Stopping → Stopped consistently even while the server still reports ready',async()=>{
 const server=setup(),request=deferred();server.stop=()=>request.promise;
 render(<ManagedWorkspaces/>);await act(async()=>{});
 expect(badge()).toBe('Running');
 await requestStop();
 // In flight: the confirm button explains what is happening; no "Requesting…".
 expect(screen.getByRole('button',{name:'Stopping…'})).toBeDisabled();
 expect(screen.queryByText('Requesting…')).toBeNull();
 await act(async()=>{request.resolve({accepted:true});});
 // Accepted: the card closes and every surface agrees, although the list
 // refresh right after acceptance still says ready with no operation.
 expect(screen.queryByText('Stop Machine Works?')).toBeNull();
 expect(badge()).toBe('Stopping…');
 expect(document.querySelector('.workspace-status-badge.busy')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Open workspace'})).toBeNull();
 expect(screen.getByRole('button',{name:'Stopping…'})).toBeDisabled();
 expect(screen.getByText('Workspace is stopping. Files and setup are saved.')).toBeTruthy();
 // No second Stop (or a Delete the server would reject) while stopping.
 expect(screen.queryByLabelText('More actions for Machine Works')).toBeNull();
 expect(screen.queryByRole('button',{name:/Stop workspace/})).toBeNull();
 await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 expect(badge()).toBe('Stopping…');
 server.operation={phase:'stop-compute',status:'running',action:'hibernate'};server.state='stopping';
 await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 expect(badge()).toBe('Stopping…');
 // The stop watcher nudges the queued operation forward for the owner.
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',{route:'/api/operations',body:{workspaceId:'ws-test',action:'advance'}});
 server.state='stopped';server.operation={phase:'complete',status:'succeeded',action:'hibernate'};
 await act(async()=>{await vi.advanceTimersByTimeAsync(5_000);});
 expect(badge()).toBe('Stopped');
 expect(screen.getByRole('button',{name:'Resume workspace'})).not.toBeDisabled();
 expect(screen.getByText(/Workspace stopped\. Files and setup are saved/)).toBeTruthy();
 expect(mocks.switchMode).not.toHaveBeenCalled();
});

it('shows a rejected stop inline in the confirm card and keeps Running',async()=>{
 const server=setup();server.stop=async()=>{throw Error('Workspace operation is already in progress');};
 render(<ManagedWorkspaces/>);await act(async()=>{});
 await requestStop();
 expect(screen.getByRole('alert').textContent).toContain('Workspace operation is already in progress');
 expect(screen.getByText('Stop Machine Works?')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Confirm stop'})).not.toBeDisabled();
 expect(badge()).toBe('Running');
});

it('reports an unconfirmed stop after the timeout instead of showing Stopping forever',async()=>{
 setup();render(<ManagedWorkspaces/>);await act(async()=>{});
 await requestStop();
 expect(badge()).toBe('Stopping…');
 await act(async()=>{await vi.advanceTimersByTimeAsync(STOP_ACKNOWLEDGE_TIMEOUT_MS+10_000);});
 expect(badge()).toBe('Running');
 expect(screen.getByRole('alert').textContent).toMatch(/stop was not confirmed/);
 expect(screen.getByRole('button',{name:'Open workspace'})).toBeTruthy();
});

it('leaves a connected workspace deliberately, without a reconnect loop, once the stop is accepted',async()=>{
 const server=setup(),request=deferred();server.stop=()=>request.promise;
 mocks.active.mockReturnValue({connection:{endpoint,workspaceId:'ws-test',workspaceName:'Machine Works',token:'synthetic'}});
 render(<ManagedWorkspaces/>);await act(async()=>{});
 await requestStop();
 // While the request is in flight the dropped connection is already
 // intentional: transports park instead of reporting "Connecting…".
 expect(workspaceLifecyclePhase(key)).toBe('stopping');
 expect(mocks.switchMode).not.toHaveBeenCalled();
 await act(async()=>{request.resolve({accepted:true});});
 expect(mocks.switchMode).toHaveBeenCalledWith('local');
 expect(takeStopSwitchNotice()).toMatchObject({workspaceId:'ws-test',name:'Machine Works'});
});

it('restores the live connection when a connected stop is rejected',async()=>{
 const server=setup();server.stop=async()=>{throw Error('Sign in again');};
 mocks.active.mockReturnValue({connection:{endpoint,workspaceId:'ws-test',workspaceName:'Machine Works',token:'synthetic'}});
 render(<ManagedWorkspaces/>);await act(async()=>{});
 await requestStop();
 expect(workspaceLifecyclePhase(key)).toBeUndefined();
 expect(mocks.switchMode).not.toHaveBeenCalled();
 expect(takeStopSwitchNotice()).toBeNull();
});
