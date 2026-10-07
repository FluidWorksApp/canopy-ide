import {it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({mode:vi.fn(),invoke:vi.fn(),open:vi.fn(),dispose:vi.fn(),install:vi.fn(),render:vi.fn(),log:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke,isTauri:()=>true}));
vi.mock('../executionMode',()=>({savedExecutionMode:mocks.mode}));
vi.mock('../host',()=>({installHost:mocks.install}));
vi.mock('./StartupShell',()=>({renderStartupShell:mocks.render,startupDiagnostic:mocks.log}));
vi.mock('./NativeWorkspaceHost',()=>({NativeWorkspaceHost:class{client={workspace:mocks.open};dispose=mocks.dispose;}}));
import {initializeWorkspace,activeWorkspace} from './workspace';
import {cancelStartupWork} from './startupWork';
beforeEach(()=>{vi.clearAllMocks();mocks.mode.mockResolvedValue('remote');mocks.invoke.mockResolvedValue({workspaceId:'synthetic',endpoint:'https://workspace.example.invalid',token:'synthetic'});mocks.open.mockResolvedValue({connected:true});});
it('does not implicitly resume a stopped remote workspace on renderer initialization',async()=>{
 mocks.open.mockRejectedValue(Error('Stopped'));expect(await initializeWorkspace()).toBe(false);expect(mocks.open).toHaveBeenCalledWith('synthetic','/open',{resume:false});expect(mocks.dispose).toHaveBeenCalledOnce();expect(mocks.install).not.toHaveBeenCalled();expect(mocks.render).toHaveBeenCalledWith(expect.stringContaining('unavailable or stopped'),true,undefined);
});
it('hung remote startup resolves to recovery at ten seconds; a late response cannot install ownership',async()=>{
 vi.useFakeTimers();let finish!:(value:unknown)=>void;mocks.open.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 try{const pending=initializeWorkspace();await vi.advanceTimersByTimeAsync(10000);expect(await pending).toBe(false);finish({connected:true});await vi.advanceTimersByTimeAsync(1);expect(mocks.install).not.toHaveBeenCalled();expect(activeWorkspace()).toBeUndefined();}finally{vi.useRealTimers();}
});
it('native saved-mode and connection getter hangs are bounded without silently changing local mode',async()=>{
 vi.useFakeTimers();try{mocks.mode.mockImplementation(()=>new Promise(()=>{}));const first=initializeWorkspace();const rejected=expect(first).rejects.toThrow('STARTUP_TIMEOUT');await vi.advanceTimersByTimeAsync(10000);await rejected;expect(mocks.install).not.toHaveBeenCalled();mocks.mode.mockResolvedValue('remote');mocks.invoke.mockImplementation(()=>new Promise(()=>{}));const second=initializeWorkspace();const rejectedSecond=expect(second).rejects.toThrow('STARTUP_TIMEOUT');await vi.advanceTimersByTimeAsync(10000);await rejectedSecond;expect(mocks.install).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
});
it('explicit local cancellation fences a late saved-connection read',async()=>{
 let finish!:(value:unknown)=>void;mocks.invoke.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const pending=initializeWorkspace();await Promise.resolve();await Promise.resolve();cancelStartupWork();finish({workspaceId:'synthetic'});expect(await pending).toBe(false);expect(mocks.open).not.toHaveBeenCalled();expect(mocks.install).not.toHaveBeenCalled();
});
