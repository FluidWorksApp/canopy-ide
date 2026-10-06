import {it,expect,vi,afterEach} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),mode:vi.fn(),guard:vi.fn(()=>true),active:{setProjectIdle:vi.fn(),connection:{workspaceId:'ws-test',endpoint:'https://ws-test.workspaces.canopyide.dev'}}}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('./workspace',()=>({activeWorkspace:()=>mocks.active}));
vi.mock('../executionMode',()=>({canSwitchExecutionMode:mocks.guard,setExecutionMode:mocks.mode}));
import {stopIdleProjectWorkspace} from './projectIdle';
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('does not request shutdown if a project reopens during teardown',async()=>{vi.useFakeTimers();const run=stopIdleProjectWorkspace(()=>false,vi.fn());await vi.advanceTimersByTimeAsync(5000);await run;expect(mocks.invoke).not.toHaveBeenCalled();});
it('keeps project UI available after shutdown is accepted',async()=>{vi.useFakeTimers();mocks.invoke.mockResolvedValue({accepted:true});const run=stopIdleProjectWorkspace(()=>true,vi.fn());await vi.advanceTimersByTimeAsync(5000);await run;expect(mocks.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'hibernate-if-alone',confirmInterrupt:true})}));expect(mocks.mode).not.toHaveBeenCalled();});
it('leaves workspace running when activity cannot be confirmed',async()=>{vi.useFakeTimers();mocks.invoke.mockRejectedValue(Error('offline'));const notify=vi.fn();const run=stopIdleProjectWorkspace(()=>true,notify);await vi.advanceTimersByTimeAsync(5000);await run;expect(mocks.mode).not.toHaveBeenCalled();expect(notify).toHaveBeenCalledWith(expect.stringContaining('still be running'));});
it('does not request owner compute shutdown when a member closes their final project',async()=>{
 const connection=mocks.active.connection as typeof mocks.active.connection & {token?:string};
 connection.token=btoa(JSON.stringify({version:2,scope:'drive'}))+'.signature';
 try{await stopIdleProjectWorkspace(()=>true,vi.fn());expect(mocks.invoke).not.toHaveBeenCalled();expect(mocks.active.setProjectIdle).toHaveBeenCalledWith(true);}finally{delete connection.token;}
});
it('reports protected shared jobs rather than claiming another IDE is connected',async()=>{
 vi.useFakeTimers();mocks.invoke.mockResolvedValue({accepted:false,reason:'Shared jobs or sessions are still active. Use Stop workspace to interrupt them.'});
 const notify=vi.fn(),run=stopIdleProjectWorkspace(()=>true,notify);await vi.advanceTimersByTimeAsync(30000);await run;expect(notify).toHaveBeenCalledWith(expect.stringContaining('Shared jobs'));expect(mocks.mode).not.toHaveBeenCalled();
});
