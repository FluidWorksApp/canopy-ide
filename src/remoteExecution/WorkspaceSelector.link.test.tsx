import {act,cleanup,render,screen} from '@testing-library/react';import {afterEach,expect,it,vi} from 'vitest';
// A readable workspace link that arrives before this window has listed any
// workspaces (a cold start from the browser's "Open in Canopy").
const mocks=vi.hoisted(()=>({refresh:vi.fn(),requests:[] as unknown[],selected:[] as unknown[]}));
vi.mock('./workspace',()=>({activeWorkspace:()=>null}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>[])}));
vi.mock('./workspaceListCache',()=>({peekWorkspaceList:()=>null,refreshWorkspaceList:mocks.refresh,subscribeWorkspaceList:()=>()=>{},restoreWorkspaceList:async()=>null}));
vi.mock('./ManagedWorkspaces',()=>({ManagedWorkspaces:({openRequest,workspaceId}:{openRequest?:unknown;workspaceId?:string})=>{mocks.requests.push(openRequest);mocks.selected.push(workspaceId);return null;}}));
vi.mock('./LocalProjectImport',()=>({LocalProjectImport:()=>null}));
import {WorkspaceSelector} from './WorkspaceSelector';
import {SHOW_WORKSPACE_EVENT} from '../readableLinks';
afterEach(()=>{cleanup();mocks.refresh.mockReset();mocks.requests.length=0;mocks.selected.length=0;});
const open=(workspaceId:string)=>act(async()=>{window.dispatchEvent(new CustomEvent(SHOW_WORKSPACE_EVENT,{detail:{workspaceId,connect:true}}));});

it('asks to connect even before the workspace list has loaded',async()=>{
 mocks.refresh.mockResolvedValue({workspaces:[{id:'ws-team',name:'API',provider:'lightsail',state:'ready'}]});
 render(<WorkspaceSelector/>);await act(async()=>{});
 await open('ws-team');
 expect(mocks.requests.at(-1)).toMatchObject({id:'ws-team'});
 // Listed after all: it connects in the background, no details panel.
 expect(mocks.selected).not.toContain('ws-team');
});
it('says so when the account does not list the workspace',async()=>{
 mocks.refresh.mockResolvedValue({workspaces:[]});
 render(<WorkspaceSelector/>);await act(async()=>{});
 await open('ws-gone');
 expect(mocks.requests.at(-1)).toMatchObject({id:'ws-gone'});
 expect(await screen.findByText(/Your account doesn’t list this workspace/)).toBeInTheDocument();
});
