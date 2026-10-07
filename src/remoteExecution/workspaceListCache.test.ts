import {it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {peekWorkspaceList,restoreWorkspaceList,refreshWorkspaceList} from './workspaceListCache';
const items=[{id:'ws-test',name:'Machine Works',state:'ready',provider:'lightsail',cpu_max:4,memory_max_mib:32768}];
beforeEach(()=>{window.dispatchEvent(new Event('canopy:account-changed'));mocks.invoke.mockReset();localStorage.clear();mocks.invoke.mockImplementation(async(command)=>command==='canopy_account_cache_key'?'a'.repeat(64):{workspaces:items});});
it('deduplicates live requests and retains cached details on refresh failure',async()=>{const [a,b]=await Promise.all([refreshWorkspaceList(),refreshWorkspaceList()]);expect(a).toBe(b);expect(mocks.invoke.mock.calls.filter(([name])=>name==='canopy_account_request')).toHaveLength(1);mocks.invoke.mockRejectedValue(Error('Offline'));await expect(refreshWorkspaceList()).rejects.toThrow('Offline');expect(peekWorkspaceList()?.workspaces).toEqual(items);});
it('restores a bounded account-bound display cache without network access',async()=>{localStorage.setItem('canopy:workspace-list:v1:'+'a'.repeat(64),JSON.stringify({workspaces:items,at:Date.now()}));expect((await restoreWorkspaceList())?.workspaces).toEqual(items);expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('canopy_account_cache_key');});
it('account change discards cached details and a late old-account response',async()=>{let resolve!:(r:unknown)=>void;mocks.invoke.mockImplementation(()=>new Promise(r=>{resolve=r;}));const old=refreshWorkspaceList();window.dispatchEvent(new Event('canopy:account-changed'));resolve({workspaces:items});await expect(old).rejects.toThrow('Account changed');expect(peekWorkspaceList()).toBeNull();});
it('never replaces a fresh live response with an older stored snapshot',async()=>{
 const old=[{...items[0],state:'stopped'}];
 await refreshWorkspaceList();
 localStorage.setItem('canopy:workspace-list:v1:'+'a'.repeat(64),JSON.stringify({workspaces:old,at:Date.now()-60000}));
 expect((await restoreWorkspaceList())?.workspaces).toEqual(items);
});
it('discards persisted private display data when access is revoked',async()=>{
 await refreshWorkspaceList();expect(localStorage.length).toBe(1);
 mocks.invoke.mockRejectedValue(Error('Unauthorized'));
 await expect(refreshWorkspaceList()).rejects.toThrow('Unauthorized');
 expect(peekWorkspaceList()).toBeNull();expect(localStorage.length).toBe(0);
});
