import {test,expect,vi,beforeEach} from 'vitest';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
import {invoke} from '@tauri-apps/api/core';import {sharedAccountRequest} from './sharedAccountsClient';
beforeEach(()=>{vi.clearAllMocks();});
test('provider key goes directly to the fixed workspace route, never the account service',async()=>{
 vi.mocked(invoke).mockResolvedValue({connection:{workspaceId:'workspace',endpoint:'https://host.example',token:'owner-connection'}});
 const fetch=vi.fn().mockResolvedValue(Response.json({imported:true}));vi.stubGlobal('fetch',fetch);
 const body={action:'import',accountId:'shared',credential:{provider:'anthropic',token:'synthetic-key'}};
 expect(await sharedAccountRequest('workspace',body)).toEqual({imported:true});
 expect(invoke).toHaveBeenCalledWith('canopy_account_request',{route:'/api/operations',body:{action:'management-connect',workspaceId:'workspace'}});
 expect(fetch.mock.calls[0][1].redirect).toBe('error');expect(fetch.mock.calls[0][0]).toBe('https://host.example/v1/workspaces/workspace/shared-accounts');expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);vi.unstubAllGlobals();
});
test('mismatched workspace and unsafe endpoint cannot receive a shared key',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 vi.mocked(invoke).mockResolvedValue({connection:{workspaceId:'other',endpoint:'https://host.example',token:'token'}});await expect(sharedAccountRequest('workspace',{credential:'synthetic'})).rejects.toThrow('identity');
 vi.mocked(invoke).mockResolvedValue({connection:{workspaceId:'workspace',endpoint:'https://user:password@host.example',token:'token'}});await expect(sharedAccountRequest('workspace',{credential:'synthetic'})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();
});
