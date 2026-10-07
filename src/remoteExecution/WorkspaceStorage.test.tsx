import {render,screen,act,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({active:null as null|{connection:{workspaceId:string};client:{workspace:ReturnType<typeof vi.fn>}}}));
vi.mock('./workspace',()=>({activeWorkspace:()=>mocks.active}));
import {WorkspaceStorage} from './WorkspaceStorage';
import {WorkspaceHero} from './WorkspaceHero';
import {WorkspaceHibernateProgress} from './WorkspaceHibernateProgress';
import {apiUsage,savePhaseLabel,storageLabel,storageLevel,warmupLabel,type HostStorage} from './storageStatus';
afterEach(()=>{cleanup();mocks.active=null;vi.useRealTimers();});
const GIB=1024**3;
const live=(percent:number,warmup:HostStorage['warmup']=null):HostStorage=>({mode:'snapshot',storageGiB:100,usage:{usedBytes:percent/100*100*GIB,capacityBytes:100*GIB,percent,level:storageLevel(percent,100)},warmup});

it('labels and levels: N GB storage, warnings from 80% and 95%, warm-up percent, save phases',()=>{
 expect(storageLabel(200)).toBe('200 GB storage');expect(storageLabel(null)).toBeNull();
 expect([storageLevel(79,100),storageLevel(80,100),storageLevel(95,100),storageLevel(1,0)]).toEqual(['ok','warning','critical','unknown']);
 expect(warmupLabel({state:'warming',phase:'background',label:'',percent:63.4,criticalReady:true})).toBe('Warming up files… 63%');
 expect(warmupLabel({state:'done',phase:null,label:'',percent:100,criticalReady:true})).toBeNull();
 expect(savePhaseLabel('saving-snapshot','45%')).toBe('Saving your workspace… storing a copy of your disk (45%)');
 expect(savePhaseLabel('saving-snapshot','<script>')).toBe('Saving your workspace… storing a copy of your disk');
 expect(savePhaseLabel('preparing-workspace')).toBeNull();
 expect(apiUsage({storage_gib:50,storage_used_bytes:'45000000000'})?.level).toBe('warning');expect(apiUsage({storage_gib:50})).toBeNull();
});

it('shows the usage bar with a warning at 80% and an alert at 95%',()=>{
 const w={id:'ws-a',state:'ready',storage_gib:100,storage_mode:'snapshot'};
 const {rerender}=render(<WorkspaceStorage workspace={w} live={live(50)}/>);
 expect(screen.getByRole('meter',{name:'Workspace storage used'})).toHaveAttribute('aria-valuenow','50');expect(screen.queryByRole('alert')).toBeNull();
 rerender(<WorkspaceStorage workspace={w} live={live(85)}/>);expect(screen.getByText(/over 80% full/)).toBeInTheDocument();
 rerender(<WorkspaceStorage workspace={w} live={live(96)}/>);expect(screen.getByRole('alert')).toHaveTextContent(/almost full.*100 GB/);
});

it('falls back to the usage measured at the last stop, and shows warm-up progress while files load',()=>{
 render(<WorkspaceStorage workspace={{id:'ws-a',state:'stopped',storage_gib:50,storage_used_bytes:10e9}}/>);
 expect(screen.getByText(/10\.0 GB of 50 GB used · measured at last stop/)).toBeInTheDocument();
 cleanup();
 render(<WorkspaceStorage workspace={{id:'ws-a',state:'ready',storage_gib:100}} live={live(20,{state:'warming',phase:'recent',label:'',percent:63,criticalReady:true})}/>);
 expect(screen.getByRole('status')).toHaveTextContent('Warming up files… 63%');
});

it('polls the connected host for live storage only while that workspace is active',async()=>{
 vi.useFakeTimers();const workspace=vi.fn(async()=>live(30));mocks.active={connection:{workspaceId:'ws-a'},client:{workspace}};
 render(<WorkspaceStorage workspace={{id:'ws-a',state:'ready',storage_gib:100,storage_mode:'snapshot'}}/>);
 await act(async()=>{});expect(workspace).toHaveBeenCalledWith('ws-a','/storage');expect(screen.getByText(/30\.0 GB|32\.2 GB/)).toBeInTheDocument();
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(workspace).toHaveBeenCalledTimes(2);
 cleanup();workspace.mockClear();
 render(<WorkspaceStorage workspace={{id:'ws-b',state:'ready',storage_gib:100}}/>);await act(async()=>{});expect(workspace).not.toHaveBeenCalled();
});

it('the workspace header shows its storage size and the saving phase while stopping',()=>{
 render(<WorkspaceHero workspace={{id:'ws-a',name:'Machine Works',state:'stopping',cpu_max:2,memory_max_mib:8192,storage_gib:100,storage_mode:'snapshot',operation:{phase:'saving-snapshot',status:'running',save_progress:'40%'}}} onOpen={()=>{}}/>);
 expect(screen.getByText('100 GB storage')).toBeInTheDocument();expect(screen.getByText('Saving')).toBeInTheDocument();
 expect(screen.getByRole('status')).toHaveTextContent('Saving your workspace… storing a copy of your disk (40%)');
});

it('hibernation progress says the workspace is being saved during trim and snapshot',()=>{
 render(<WorkspaceHibernateProgress operation={{workspaceId:'ws-a',name:'Machine Works',startedAt:Date.now(),progress:{phase:'stopping-compute',shutdownAccepted:true,savePhase:'saving-workspace'}}} minimized={false} onMinimize={()=>{}} onExpand={()=>{}} onRetry={()=>{}} onDismiss={()=>{}}/>);
 expect(screen.getAllByText('Saving your workspace… cleaning up and compacting files').length).toBeGreaterThan(0);
});
