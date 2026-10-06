import {test,expect,vi,afterEach} from 'vitest';vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));import {invoke} from '@tauri-apps/api/core';import {sharedSessionClient} from './sharedSessionClient';
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
test('view connection caches unexpired credentials but account switch blocks every later request',async()=>{
 const id='ws-11111111-1111-4111-8111-111111111111';let current=true;vi.mocked(invoke).mockResolvedValue({connection:{workspaceId:id,endpoint:`https://${id}.workspaces.canopyide.dev`,token:'view-token'},expiresAt:new Date(Date.now()+120000).toISOString()});const fetch=vi.fn().mockImplementation(async()=>Response.json({sessions:[]}));vi.stubGlobal('fetch',fetch);
 const client=await sharedSessionClient(id,()=>current);await client.workspace(id,'/shared-sessions');await client.workspace(id,'/shared-sessions');expect(invoke).toHaveBeenCalledTimes(1);expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({route:'/api/operations',body:{action:'shared-session-connect',workspaceId:id}});expect(fetch.mock.calls.every(([,options])=>options.headers.authorization==='Bearer view-token')).toBe(true);
 current=false;await expect(client.workspace(id,'/shared-sessions')).rejects.toThrow('Account or workspace changed');expect(fetch).toHaveBeenCalledTimes(2);
});
test('changed workspace identity and redirect endpoints never receive view credentials',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);vi.mocked(invoke).mockResolvedValue({connection:{workspaceId:'other',endpoint:'https://evil.example',token:'token'}});await expect(sharedSessionClient('ws',()=>true)).rejects.toThrow('identity');expect(fetch).not.toHaveBeenCalled();
});
