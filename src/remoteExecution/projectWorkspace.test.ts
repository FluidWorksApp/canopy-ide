import {it,expect,vi,afterEach} from 'vitest';
const mock=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mock.invoke}));
vi.mock('./workspace',()=>({activeWorkspace:()=>({setProjectIdle:vi.fn(),connection:{workspaceId:'ws-test',endpoint:'https://ws-test.workspaces.canopyide.dev'},client:{workspace:mock.open}})}));
import {ensureProjectWorkspace} from './projectWorkspace';
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('resumes a stopped workspace and waits for services before opening the project',async()=>{
 vi.useFakeTimers();let state='stopped';
 mock.invoke.mockImplementation(async(_c,a)=>a.route==='/api/workspaces'?{workspaces:[{id:'ws-test',state}]}:{});
 const run=ensureProjectWorkspace();await vi.advanceTimersByTimeAsync(0);
 expect(mock.invoke).toHaveBeenCalledWith('canopy_account_request',expect.objectContaining({body:expect.objectContaining({action:'resume'})}));expect(mock.open).not.toHaveBeenCalled();
 state='ready';await vi.advanceTimersByTimeAsync(5000);await run;expect(mock.open).toHaveBeenCalledWith('ws-test','/open',{resume:true});
});
it('does not start another VM while the previous shutdown is in progress',async()=>{
 vi.useFakeTimers();let state='stopping';mock.invoke.mockImplementation(async(_c,a)=>a.route==='/api/workspaces'?{workspaces:[{id:'ws-test',state}]}:{});
 const run=ensureProjectWorkspace();await vi.advanceTimersByTimeAsync(0);
 expect(mock.invoke.mock.calls.some(([,a])=>a.body?.action==='resume')).toBe(false);
 state='stopped';await vi.advanceTimersByTimeAsync(5000);expect(mock.invoke.mock.calls.some(([,a])=>a.body?.action==='resume')).toBe(true);
 state='ready';await vi.advanceTimersByTimeAsync(5000);await run;
});
