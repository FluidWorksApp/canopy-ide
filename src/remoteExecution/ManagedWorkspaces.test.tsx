import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,act,cleanup} from '@testing-library/react';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),canSwitch:vi.fn(()=>true),switchMode:vi.fn(),open:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../components/AccountSettings',()=>({AccountSettings:()=>null}));
vi.mock('../components/ui',()=>({Button:({children,...props}:React.ComponentProps<'button'>)=><button {...props}>{children}</button>,TextInput:({width:_,...props}:React.ComponentProps<'input'>&{width?:string})=><input {...props}/>}));
vi.mock('../executionMode',()=>({canSwitchExecutionMode:mocks.canSwitch,setExecutionMode:mocks.switchMode}));
vi.mock('../links',()=>({openInOsBrowser:vi.fn()}));
vi.mock('./workspace',()=>({activeWorkspace:()=>null}));
vi.mock('./client',()=>({RemoteExecutionClient:class{workspace=mocks.open;}}));
import {ManagedWorkspaces,workspaceStartupProblem} from './ManagedWorkspaces';
import {resetWorkspaceLifecycle} from './workspaceLifecycle';
afterEach(()=>{cleanup();resetWorkspaceLifecycle();vi.useRealTimers();vi.clearAllMocks();});
function setup(){vi.useFakeTimers();mocks.canSwitch.mockReturnValue(true);let state='stopped';const w=()=>({id:'ws-test',name:'My workspace',provider:'lightsail',state,cpu_max:2,memory_max_mib:8192,operation:{phase:'preparing-workspace'}});mocks.invoke.mockImplementation(async(command,args)=>{if(command!=='canopy_account_request')return;if(args.route==='/api/workspaces')return {workspaces:[w()]};if(args.body.action==='resume'){state='starting';return {};}if(args.body.action==='connect')return {connection:{workspaceId:'ws-test',workspaceName:'My workspace',endpoint:'https://ws-test.workspaces.canopyide.dev',token:'synthetic'}};return {};});return {ready:()=>{state='ready';}};}
it('shows real startup stage and connects automatically only after readiness',async()=>{const control=setup();render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});expect(screen.getByText('Starting services').getAttribute('aria-current')).toBe('step');expect(mocks.switchMode).not.toHaveBeenCalled();control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(mocks.open).toHaveBeenCalledWith('ws-test','/open',{resume:true});expect(mocks.switchMode).toHaveBeenCalledWith('remote');});
it('names the IDE connection on the first connect, as a member connect requires',async()=>{const control=setup();render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});const connect=mocks.invoke.mock.calls.find(([,args])=>args?.body?.action==='connect');expect(connect?.[1].body.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);});
it('Connect later cancels automatic handoff while server setup continues',async()=>{const control=setup();render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Connect later'}));control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(mocks.switchMode).not.toHaveBeenCalled();expect(mocks.invoke.mock.calls.some(([,args])=>args?.body?.action==='hibernate')).toBe(false);});
it('preserves edits made while the machine was starting',async()=>{const control=setup();render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});mocks.canSwitch.mockReturnValue(false);control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(mocks.switchMode).not.toHaveBeenCalled();expect(screen.getByText(/Save or close unsaved files, then choose Open/)).toBeTruthy();});

it('keeps startup focused on one workspace with an elapsed timer',async()=>{
 setup();render(<ManagedWorkspaces/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 expect(screen.getAllByText('My workspace')).toHaveLength(1);
 expect(screen.queryByRole('button',{name:'＋ Create workspace'})).toBeNull();
 await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
 expect(screen.getByText('0m 6s elapsed')).toBeTruthy();
 expect(screen.getByText(/First-time setup can take/)).toBeTruthy();
});

it('stops a running workspace only after explaining interruption',async()=>{
 const control=setup();control.ready();render(<ManagedWorkspaces/>);await act(async()=>{});
 fireEvent.click(screen.getByLabelText('More actions for My workspace'));
 fireEvent.click(screen.getByRole('button',{name:/Stop workspace/}));
 expect(mocks.invoke.mock.calls.some(([,a])=>a?.body?.action==='hibernate')).toBe(false);
 expect(screen.getByText(/All running agents, terminals and jobs/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Confirm stop'}));await act(async()=>{});
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({workspaceId:'ws-test',action:'hibernate',confirmInterrupt:true})}));
});
it('keeps readiness and automatic handoff running when the workspace panel is collapsed',async()=>{
 const control=setup(),minimize=vi.fn(),progress=vi.fn();
 const view=render(<ManagedWorkspaces onMinimize={minimize} onProgress={progress}/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Continue working'}));expect(minimize).toHaveBeenCalledOnce();
 view.container.hidden=true;
 control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(mocks.switchMode).toHaveBeenCalledWith('remote');expect(progress).toHaveBeenLastCalledWith(null);
 view.container.hidden=false;
 expect(screen.queryByLabelText('Workspace startup')).toBeNull();expect(screen.getByRole('button',{name:'Open workspace'})).toBeTruthy();
});
it('can stop preparation without a late readiness response reconnecting it',async()=>{
 const control=setup();render(<ManagedWorkspaces/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Stop workspace'}));
 expect(screen.getByRole('button',{name:'Confirm stop'})).not.toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Confirm stop'}));await act(async()=>{});
 control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'hibernate',workspaceId:'ws-test'})}));
 expect(mocks.switchMode).not.toHaveBeenCalled();
});
it('requires the exact name before deleting and clears the saved connection only after acceptance',async()=>{
 setup();const original=mocks.invoke.getMockImplementation()!;
 mocks.invoke.mockImplementation(async(command,args)=>{const result=await original(command,args);return args?.route==='/api/workspaces'?{workspaces:result.workspaces.map((w:object)=>({...w,canDelete:true,access:{owner:true,canConnect:true,canStop:true}}))}:result;});
 const deleted=vi.fn();render(<ManagedWorkspaces onDeleted={deleted}/>);await act(async()=>{});
 fireEvent.click(screen.getByLabelText('More actions for My workspace'));
 fireEvent.click(screen.getByRole('button',{name:/Delete workspace/}));
 expect(screen.getByText(/Permanently remove this workspace/)).toBeTruthy();
 const confirm=screen.getByRole('button',{name:'Confirm delete'});expect(confirm).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Type the workspace name to confirm'),{target:{value:'My workspace'}});
 fireEvent.click(confirm);await act(async()=>{});
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'delete',confirmName:'My workspace',confirmInterrupt:true})}));
 expect(mocks.invoke).toHaveBeenCalledWith('execution_remote_forget',{id:'https://ws-test.workspaces.canopyide.dev/ws-test'});expect(deleted).toHaveBeenCalledWith('ws-test');
});
it('does not offer Stop or Delete to a member without permission',async()=>{
 const control=setup();control.ready();const original=mocks.invoke.getMockImplementation()!;
 mocks.invoke.mockImplementation(async(command,args)=>{const result=await original(command,args);return args?.route==='/api/workspaces'?{workspaces:result.workspaces.map((w:object)=>({...w,canDelete:false,access:{owner:false,canConnect:true,canStop:false}}))}:result;});
 render(<ManagedWorkspaces/>);await act(async()=>{});
 expect(screen.queryByRole('button',{name:'Delete workspace'})).toBeNull();expect(screen.queryByRole('button',{name:'Stop workspace'})).toBeNull();
});
it('retries the interrupted operation rather than creating a competing resume',async()=>{
 setup();const original=mocks.invoke.getMockImplementation()!;let retried=false;
 mocks.invoke.mockImplementation(async(command,args)=>{
  if(args?.body?.action==='retry')retried=true;
  const result=await original(command,args);return args?.route==='/api/workspaces'?{workspaces:result.workspaces.map((w:object)=>({...w,state:retried?'starting':'error',operation:{phase:'preparing-workspace',status:retried?'running':'failed'}}))}:result;
 });
 render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Retry preparation'}));await act(async()=>{});
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'retry'})}));expect(mocks.invoke.mock.calls.some(([,args])=>args?.body?.action==='resume')).toBe(false);
});
it('shared developers can explicitly resume owner-funded resources while background polling never wakes them',async()=>{
 const control=setup(),original=mocks.invoke.getMockImplementation()!;mocks.invoke.mockImplementation(async(command,args)=>{const result=await original(command,args);return args?.route==='/api/workspaces'?{workspaces:result.workspaces.map((w:{state:string})=>({...w,canDelete:false,canStop:false,access:{owner:false,canManageAccess:false,canConnect:w.state==='ready',canResume:true,canStop:false}}))}:result;});
 render(<ManagedWorkspaces/>);await act(async()=>{});await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(mocks.invoke.mock.calls.some(([,args])=>['resume','advance','retry'].includes(args?.body?.action))).toBe(false);expect(screen.getByText('Running time is billed to the workspace owner.')).toBeTruthy();const button=screen.getByRole('button',{name:'Resume workspace'});expect(button).toBeEnabled();fireEvent.click(button);await act(async()=>{});expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'resume',workspaceId:'ws-test'})}));expect(screen.queryByRole('button',{name:'Stop workspace'})).toBeNull();expect(screen.queryByRole('button',{name:'Delete workspace'})).toBeNull();control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(mocks.switchMode).toHaveBeenCalledWith('remote');
});
it('an image-stage failure offers a fresh-machine restart and sends the existing retry action',async()=>{
 setup();const original=mocks.invoke.getMockImplementation()!;let failed=false;
 mocks.invoke.mockImplementation(async(command,args)=>{if(args?.body?.action==='advance')failed=true;const result=await original(command,args);return args?.route==='/api/workspaces'&&failed?{workspaces:result.workspaces.map((w:object)=>({...w,state:'error',canDelete:true,operation:{phase:'preparing-workspace',status:'failed',action:'resume',last_error:'Workspace startup failed during image. Saved files are retained.',bootstrap_report:{stage:'image',status:'failed'},retry_replaces_host:true}}))}:result;});
 render(<ManagedWorkspaces/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 expect(screen.getByRole('alert')).toHaveTextContent('Preparing the workspace image failed. Your saved files are retained. Restart on a fresh machine, or stop the workspace to keep compute off.');
 fireEvent.click(screen.getByRole('button',{name:'Restart on a fresh machine'}));await act(async()=>{});
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'retry',workspaceId:'ws-test'})}));
});
it('a bootstrap failure immediately replaces cached starting details and stops automatic handoff',async()=>{
 setup();const original=mocks.invoke.getMockImplementation()!;let failed=false;
 mocks.invoke.mockImplementation(async(command,args)=>{if(args?.body?.action==='advance')failed=true;const result=await original(command,args);return args?.route==='/api/workspaces'&&failed?{workspaces:result.workspaces.map((w:object)=>({...w,state:'error',canDelete:true,operation:{phase:'preparing-workspace',status:'failed',last_error:'Workspace startup failed during artifact. Saved files are retained.',bootstrap_report:{stage:'artifact',status:'failed'}}}))}:result;});
 const list=vi.fn(),progress=vi.fn();render(<ManagedWorkspaces onList={list} onProgress={progress}/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 expect(screen.getByRole('alert')).toHaveTextContent('Downloading the workspace runtime failed.');expect(screen.getByRole('button',{name:'Retry preparation'})).toBeEnabled();expect(screen.queryByLabelText('Workspace startup')).toBeNull();expect(progress).toHaveBeenLastCalledWith(null);expect(list).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({state:'error'})]));
 const calls=mocks.invoke.mock.calls.filter(([,args])=>args?.body?.action==='advance').length;await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(mocks.invoke.mock.calls.filter(([,args])=>args?.body?.action==='advance')).toHaveLength(calls);expect(mocks.switchMode).not.toHaveBeenCalled();expect(mocks.open).not.toHaveBeenCalled();
 cleanup();render(<ManagedWorkspaces/>);expect(screen.getByRole('alert')).toHaveTextContent('Downloading the workspace runtime failed.');expect(screen.queryByLabelText('Workspace startup')).toBeNull();await act(async()=>{});
});
it('shows an actionable preflight failure with no bootstrap report',async()=>{
 setup();const original=mocks.invoke.getMockImplementation()!;mocks.invoke.mockImplementation(async(command,args)=>{const result=await original(command,args);return args?.route==='/api/workspaces'?{workspaces:result.workspaces.map((w:object)=>({...w,state:'error',operation:{phase:'creating-compute',status:'failed',last_error:'The runtime archive is unavailable to managed compute. Use an authorized release archive.'}}))}:result;});render(<ManagedWorkspaces/>);await act(async()=>{});expect(screen.getByRole('alert')).toHaveTextContent('Use an authorized release archive.');expect(screen.getByRole('button',{name:'Retry preparation'})).toBeEnabled();expect(mocks.switchMode).not.toHaveBeenCalled();
});
it('publishes authoritative failure metadata even when advance returns an infrastructure 403',async()=>{
 setup();const original=mocks.invoke.getMockImplementation()!;let failed=false;mocks.invoke.mockImplementation(async(command,args)=>{if(args?.body?.action==='advance'){failed=true;throw Error('Infrastructure archive request returned 403');}const result=await original(command,args);return args?.route==='/api/workspaces'&&failed?{workspaces:result.workspaces.map((w:object)=>({...w,state:'error',operation:{phase:'creating-compute',status:'failed',last_error:'The runtime archive is unavailable to managed compute. Use an authorized release archive.'}}))}:result;});render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});expect(screen.getByRole('alert')).toHaveTextContent('Use an authorized release archive.');expect(screen.getByRole('button',{name:'Retry preparation'})).toBeEnabled();expect(screen.queryByLabelText('Workspace startup')).toBeNull();expect(mocks.open).not.toHaveBeenCalled();
});
it('a selected prebuilt host shows verification rather than a cold install claim',async()=>{
 setup();const original=mocks.invoke.getMockImplementation()!;mocks.invoke.mockImplementation(async(command,args)=>{const result=await original(command,args);return args?.route==='/api/workspaces'?{workspaces:result.workspaces.map((w:object)=>({...w,state:'error',operation:{phase:'preparing-workspace',status:'failed',bootstrap_mode:'prebuilt',bootstrap_report:{stage:'packages',status:'failed'}}}))}:result;});render(<ManagedWorkspaces/>);await act(async()=>{});expect(screen.getByRole('alert')).toHaveTextContent('Verifying prebuilt host tools failed.');expect(screen.queryByText(/Installing host tools failed/)).toBeNull();
});
it('shows a step that keeps failing instead of an unchanged starting state',async()=>{
 vi.useFakeTimers();let state='stopped';const w=()=>({id:'ws-test',name:'My workspace',provider:'lightsail',state,cpu_max:2,memory_max_mib:8192,operation:state==='stopped'?undefined:{phase:'queued',status:'running',last_error:'Workspace operation will retry'}});
 mocks.invoke.mockImplementation(async(command,args)=>{if(command!=='canopy_account_request')return;if(args.route==='/api/workspaces')return {workspaces:[w()]};if(args.body.action==='resume'){state='starting';return {};}return {};});
 render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 expect(screen.getByText('The last setup step failed (Workspace operation will retry). Retrying automatically…')).toBeTruthy();expect(mocks.switchMode).not.toHaveBeenCalled();
});

it('shows copied and total gigabytes while a retained disk moves to snapshot storage',async()=>{
 vi.useFakeTimers();mocks.canSwitch.mockReturnValue(true);let state='stopped',report:{stage:string;status:string;copiedBytes?:number;totalBytes?:number}|undefined;
 const w=()=>({id:'ws-test',name:'My workspace',provider:'lightsail',state,cpu_max:2,memory_max_mib:8192,operation:{phase:'preparing-workspace',status:'running',bootstrap_report:report}});
 mocks.invoke.mockImplementation(async(command,args)=>{if(command!=='canopy_account_request')return;if(args.route==='/api/workspaces')return {workspaces:[w()]};if(args.body.action==='resume'){state='starting';return {};}return {};});
 render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 report={stage:'migrating-files',status:'progress'};await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(screen.getByText(/Moving your files…/)).toBeTruthy();
 report={stage:'migrating-files',status:'progress',copiedBytes:12_345_000_000,totalBytes:40_000_000_000};await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(screen.getByText(/Moving your files… 12\.3 \/ 40\.0 GB/)).toBeTruthy();
});

it('checks every second once the host is starting its services, and connects within that second of readiness',async()=>{
 vi.useFakeTimers();mocks.canSwitch.mockReturnValue(true);let state='stopped',report:{stage:string;status:string}|undefined;
 const w=()=>({id:'ws-test',name:'My workspace',provider:'lightsail',state,cpu_max:2,memory_max_mib:8192,operation:{phase:'preparing-workspace',status:'running',bootstrap_report:report}});
 mocks.invoke.mockImplementation(async(command,args)=>{if(command!=='canopy_account_request')return;if(args.route==='/api/workspaces')return {workspaces:[w()]};if(args.body.action==='resume'){state='starting';return {};}if(args.body.action==='connect')return {connection:{workspaceId:'ws-test',workspaceName:'My workspace',endpoint:'https://ws-test.workspaces.canopyide.dev',token:'synthetic'}};return {};});
 const advances=()=>mocks.invoke.mock.calls.filter(([,args])=>args?.body?.action==='advance').length;
 render(<ManagedWorkspaces/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 const early=advances();await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(advances()).toBe(early);
 report={stage:'host-services',status:'progress'};await act(async()=>{await vi.advanceTimersByTimeAsync(4000);});
 const later=advances();await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(advances()).toBe(later+1);
 state='ready';await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(mocks.open).toHaveBeenCalledWith('ws-test','/open',{resume:true});expect(mocks.switchMode).toHaveBeenCalledWith('remote');
});

it('shows the specific disk-full startup failure instead of a generic image-stage message',()=>{
 const message='Workspace disk is full: 3.2 GB free, 17.2 GB needed for the workspace image. Old workspace images were already removed and your saved files are retained. The workspace disk needs more space before it can start; contact support.';
 const w={id:'ws-test',name:'My workspace',state:'error',memory_max_mib:8192,cpu_max:2,operation:{phase:'preparing-workspace',status:'failed',last_error:message,bootstrap_report:{stage:'image',status:'failed',reason:'disk-full' as const,freeGB:3.2,neededGB:17.2}}};
 expect(workspaceStartupProblem(w)).toBe(message);
 expect(workspaceStartupProblem({...w,operation:{...w.operation,last_error:'Workspace startup failed during image. Saved files are retained.'}})).toBe('Preparing the workspace image failed. Your saved files are retained. Retry preparation, or stop the workspace to keep compute off.');
});
it('a credit refusal shows the balance and how to get credit instead of a generic error',async()=>{
 setup();vi.useRealTimers();
 const refusal=JSON.stringify({error:'Your Canopy balance is −$64.48. Workspaces pause at −$10.00, so this workspace can’t start until credit is added. Your files are kept.',code:'credit_exhausted',balanceUsd:'-64.480000',cutoffUsd:'-10',shared:false,status:402});
 const base=mocks.invoke.getMockImplementation()!;
 mocks.invoke.mockImplementation(async(command,args)=>{if(args?.body?.action==='resume'){expect(args.detailedErrors).toBe(true);throw refusal;}if(args?.route==='/api/credits')return {requested:true};return base(command,args);});
 render(<ManagedWorkspaces/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 expect(screen.getByText('Workspace paused: out of credit')).toBeTruthy();
 expect(screen.getByText(/Your balance is −\$64\.48\. Workspaces can’t start at or below −\$10\.00/)).toBeTruthy();
 expect(screen.queryByText(/credit_exhausted|\{"error"/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Request more credit'}));await act(async()=>{});
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',{route:'/api/credits',body:{action:'request-credit'}});
 expect(screen.getByText(/Request sent/)).toBeTruthy();
});
it('other detailed resume errors still show their plain message',async()=>{
 setup();vi.useRealTimers();const base=mocks.invoke.getMockImplementation()!;
 mocks.invoke.mockImplementation(async(command,args)=>{if(args?.body?.action==='resume')throw JSON.stringify({error:'A workspace operation is already in progress',status:409});return base(command,args);});
 render(<ManagedWorkspaces/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 expect(screen.getByText('A workspace operation is already in progress')).toBeTruthy();expect(screen.queryByText(/out of credit/)).toBeNull();
});
// A teammate resuming or opening a shared workspace: the owner's machine is
// up, but the server only issues member credentials once the host has proven
// member isolation for this start. The IDE waits for that instead of failing.
function memberSetup(sharing:{pending:boolean}){
 const control=setup(),original=mocks.invoke.getMockImplementation()!;let ready=false;
 mocks.invoke.mockImplementation(async(command,args)=>{
  if(args?.body?.action==='connect'&&!ready)throw 'Sharing is getting ready after the workspace started. Try again in a minute.';
  const result=await original(command,args);
  return args?.route==='/api/workspaces'?{workspaces:result.workspaces.map((w:{state:string})=>({...w,canDelete:false,canStop:false,access:{owner:false,canManageAccess:false,canStop:false,canResume:true,canConnect:w.state==='ready'&&ready,...(w.state==='ready'&&!ready?{connectionUnavailable:sharing.pending?'Sharing is getting ready after the workspace started. Try again in a minute.':'Sharing isn’t ready on this workspace: The workspace host needs an update to share. The owner can retry from Access.',connectionPending:sharing.pending}:{})}}))}:result;
 });
 return {...control,share:()=>{ready=true;}};
}
it('a member waits for the shared workspace to finish getting ready, then connects by itself',async()=>{
 const control=memberSetup({pending:true});render(<ManagedWorkspaces/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(screen.getByText(/Waiting for it to finish getting ready for teammates/)).toBeTruthy();
 expect(mocks.invoke.mock.calls.some(([,args])=>args?.body?.action==='connect')).toBe(false);
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(mocks.switchMode).not.toHaveBeenCalled();
 control.share();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'connect',workspaceId:'ws-test'})}));
 expect(mocks.switchMode).toHaveBeenCalledWith('remote');
});
it('a member is told why when sharing failed, instead of waiting forever',async()=>{
 const control=memberSetup({pending:false});render(<ManagedWorkspaces/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Resume workspace'}));await act(async()=>{});
 control.ready();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(screen.getByText(/needs an update to share/)).toBeTruthy();
 expect(mocks.invoke.mock.calls.some(([,args])=>args?.body?.action==='connect')).toBe(false);expect(mocks.switchMode).not.toHaveBeenCalled();
});
it('a member opening a running workspace whose sharing is getting ready is not turned away',async()=>{
 const control=memberSetup({pending:true});control.ready();render(<ManagedWorkspaces openRequest={{id:'ws-test',nonce:1}}/>);await act(async()=>{});
 expect(screen.queryByText(/Try again in a minute/)).toBeNull();
 control.share();await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(mocks.switchMode).toHaveBeenCalledWith('remote');
});
