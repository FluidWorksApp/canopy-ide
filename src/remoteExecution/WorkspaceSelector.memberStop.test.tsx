import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),switchMode:vi.fn(),post:vi.fn(),active:null as null|{connection:Record<string,unknown>;connectionClientId:string;client:{workspace:ReturnType<typeof vi.fn>};setProjectIdle:ReturnType<typeof vi.fn>}}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../executionMode',()=>({canSwitchExecutionMode:()=>true,setExecutionMode:mocks.switchMode}));
vi.mock('./workspace',()=>({activeWorkspace:()=>mocks.active}));
vi.mock('../links',()=>({openLink:vi.fn()}));
vi.mock('../attention',()=>({postAttention:mocks.post}));
vi.mock('./RemoteDesktop',()=>({RemoteDesktop:()=>null}));
vi.mock('./LocalProjectImport',()=>({LocalProjectImport:()=>null}));
vi.mock('../components/AccountSettings',()=>({AccountSettings:()=>null}));
vi.mock('../components/WorkspaceSharing',()=>({WorkspaceSharing:()=>null}));

vi.mock('./WorkspaceOwnerTools',()=>({WorkspaceOwnerTools:()=>null}));
import {WorkspaceSelector} from './WorkspaceSelector';
import {HibernateCancelled} from './hibernateWorkspace';

const sharedId='ws-11111111-1111-1111-1111-111111111111';
function connect(connection:Record<string,unknown>){mocks.active={connection:{token:'opaque',...connection},connectionClientId:'client-1',client:{workspace:vi.fn().mockResolvedValue({result:null})},setProjectIdle:vi.fn()};}
type Args={route?:string;body?:{action?:string;requestKey?:string;confirmOthers?:boolean;clientId?:string;workspaceId?:string};detailedErrors?:boolean};
let operations:(args:Args)=>unknown;
const operationCalls=()=>mocks.invoke.mock.calls.filter(([command,args])=>command==='canopy_account_request'&&(args as Args).route==='/api/operations').map(([,args])=>args as Args);
const othersConnected=(others:number)=>JSON.stringify({error:'Other people are connected to this workspace. Hibernating stops their sessions too.',code:'others-connected',others,status:409});
beforeEach(()=>{
 operations=()=>({accepted:true});
 mocks.invoke.mockImplementation(async(command:string,args?:Args)=>{
  if(command==='execution_remote_list')return [];
  if(command!=='canopy_account_request')return null;
  if(args?.route==='/api/workspaces')return {workspaces:[]};
  if(args?.route==='/api/operations')return operations(args);
  return {};
 });
});
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.active=null;try{localStorage.clear();}catch{/* Optional. */}});
function openPanel(){fireEvent.click(screen.getByRole('button',{name:/Shared|Legacy/}));fireEvent.click(screen.getByRole('menuitem',{name:/Manage workspaces/}));}

it('a member sees Stop my session, sends member-stop and never hibernate, then leaves for the local workspace',async()=>{
 connect({workspaceId:sharedId,workspaceName:'Shared',endpoint:`https://${sharedId}.workspaces.canopyide.dev`,scope:'drive'});
 operations=()=>({accepted:true,stopped:'member-runtime',suspendsWithinSeconds:30});
 const hibernate=vi.fn();
 render(<WorkspaceSelector onHibernateWorkspace={hibernate}/>);await act(async()=>{});
 expect(screen.queryByRole('button',{name:'Hibernate workspace'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Stop my session'}));
 const dialog=screen.getByRole('dialog');
 expect(within(dialog).getByText(/keeps running for its owner/)).toBeInTheDocument();
 await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Stop my session'}));});
 expect(operationCalls()).toEqual([expect.objectContaining({body:{workspaceId:sharedId,action:'member-stop',clientId:'client-1'}})]);
 expect(operationCalls().some(args=>args.body?.action==='hibernate')).toBe(false);
 expect(hibernate).not.toHaveBeenCalled();
 expect(mocks.switchMode).toHaveBeenCalledWith('local');
 expect(JSON.parse(localStorage.getItem('canopy:workspace-member-stop:v1')!)).toEqual(expect.objectContaining({name:'Shared'}));
});

it('a member is recognised from the account list too, and the panel offers only Stop my session',async()=>{
 connect({workspaceId:sharedId,workspaceName:'Shared',endpoint:`https://${sharedId}.workspaces.canopyide.dev`});
 mocks.invoke.mockImplementation(async(command:string,args?:Args)=>{
  if(command==='execution_remote_list')return [];
  if(args?.route==='/api/workspaces')return {workspaces:[{id:sharedId,name:'Shared',provider:'lightsail',state:'ready',cpu_max:2,memory_max_mib:8192,access:{owner:false,canManageAccess:false,canStop:false,canConnect:true}}]};
  if(args?.route==='/api/operations')return {accepted:true};
  return {};
 });
 render(<WorkspaceSelector onHibernateWorkspace={vi.fn()}/>);await act(async()=>{});
 openPanel();await act(async()=>{});
 expect(screen.queryByRole('button',{name:'Hibernate workspace'})).toBeNull();
 expect(screen.getAllByRole('button',{name:'Stop my session'}).length).toBeGreaterThan(0);
});

it('an old server refusing member-stop shows its error and keeps the member connected',async()=>{
 connect({workspaceId:sharedId,workspaceName:'Shared',endpoint:`https://${sharedId}.workspaces.canopyide.dev`,scope:'drive'});
 operations=()=>{throw 'Workspace not found';};
 render(<WorkspaceSelector onHibernateWorkspace={vi.fn()}/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Stop my session'}));
 const dialog=screen.getByRole('dialog');
 await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'Stop my session'}));});
 expect(within(dialog).getByRole('alert')).toHaveTextContent('Workspace not found');
 expect(mocks.switchMode).not.toHaveBeenCalled();
 expect(localStorage.getItem('canopy:workspace-member-stop:v1')).toBeNull();
});

async function legacyStop(){
 connect({workspaceId:'shoaib-work',workspaceName:'Legacy',endpoint:'https://legacy.example'});
 render(<WorkspaceSelector/>);await act(async()=>{});
 openPanel();
 fireEvent.click(screen.getByRole('button',{name:'Stop workspace'}));
 await act(async()=>{fireEvent.click(within(screen.getByRole('dialog',{name:'Stop Legacy?'})).getByRole('button',{name:'Stop workspace'}));});
}
it('an owner stop refused because others are connected asks, then resends with confirmOthers and a new request key',async()=>{
 let shutdowns=0;operations=args=>{if(args.body?.action==='hibernate'&&++shutdowns===1)throw othersConnected(2);return {accepted:true};};
 await legacyStop();
 const prompt=screen.getByRole('dialog',{name:'Other people are connected'});
 expect(within(prompt).getByText('2 other people are connected. Hibernating stops their sessions too.')).toBeInTheDocument();
 expect(mocks.switchMode).not.toHaveBeenCalled();
 await act(async()=>{fireEvent.click(within(prompt).getByRole('button',{name:'Hibernate anyway'}));});
 const calls=operationCalls();expect(calls).toHaveLength(2);
 expect(calls[0].body).toEqual(expect.objectContaining({action:'hibernate',clientId:'client-1'}));expect(calls[0].body).not.toHaveProperty('confirmOthers');
 expect(calls[1].body).toEqual(expect.objectContaining({action:'hibernate',confirmInterrupt:true,confirmOthers:true,clientId:'client-1'}));
 expect(calls[1].body!.requestKey).not.toBe(calls[0].body!.requestKey);
 expect(mocks.switchMode).toHaveBeenCalledWith('local');
});
it('cancelling the others prompt sends nothing more and stays connected',async()=>{
 operations=args=>{if(args.body?.action==='hibernate')throw othersConnected(1);return {accepted:true};};
 await legacyStop();
 expect(within(screen.getByRole('dialog',{name:'Other people are connected'})).getByText('1 other person is connected. Hibernating stops their sessions too.')).toBeInTheDocument();
 await act(async()=>{fireEvent.click(within(screen.getByRole('dialog',{name:'Other people are connected'})).getByRole('button',{name:'Cancel'}));});
 expect(screen.queryByRole('dialog',{name:'Other people are connected'})).toBeNull();
 expect(operationCalls()).toHaveLength(1);
 expect(mocks.switchMode).not.toHaveBeenCalled();
});
it('without a 409 an owner stop is unchanged: one hibernate request, no prompt',async()=>{
 await legacyStop();
 const calls=operationCalls();expect(calls).toHaveLength(1);expect(calls[0].body).not.toHaveProperty('confirmOthers');
 expect(screen.queryByText(/other (people are|person is) connected/)).toBeNull();
 expect(mocks.switchMode).toHaveBeenCalledWith('local');
});

it('owner hibernation answers the others prompt for the project workflow, and cancel clears progress',async()=>{
 connect({workspaceId:sharedId,workspaceName:'Shared',endpoint:`https://${sharedId}.workspaces.canopyide.dev`});
 const answers:boolean[]=[];
 const hibernate=vi.fn(async(_progress?:unknown,confirm?:(others:number)=>Promise<boolean>)=>{const ok=await confirm!(3);answers.push(ok);if(!ok)throw new HibernateCancelled();});
 render(<WorkspaceSelector onHibernateWorkspace={hibernate}/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Hibernate workspace'}));
 await act(async()=>{fireEvent.click(screen.getAllByRole('button',{name:/Hibernate workspace/}).at(-1)!);});
 expect(screen.getByText('3 other people are connected. Hibernating stops their sessions too.')).toBeInTheDocument();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Cancel'}));});
 expect(answers).toEqual([false]);
 expect(screen.queryByText('3 other people are connected. Hibernating stops their sessions too.')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Hibernate workspace'}));
 await act(async()=>{fireEvent.click(screen.getAllByRole('button',{name:/Hibernate workspace/}).at(-1)!);});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Hibernate anyway'}));});
 expect(answers).toEqual([false,true]);
});

it('after the reload, the local workspace says the member session stopped once',async()=>{
 localStorage.setItem('canopy:workspace-member-stop:v1',JSON.stringify({name:'Shared',at:Date.now()}));
 render(<WorkspaceSelector/>);await act(async()=>{});
 expect(mocks.post).toHaveBeenCalledOnce();
 expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({kind:'fyi',tone:'success',title:'Your session stopped. Shared keeps running for its owner.'}));
 expect(localStorage.getItem('canopy:workspace-member-stop:v1')).toBeNull();
});
