import {render,screen,act,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
vi.mock('../components/SharedAccountsPanel',()=>({SharedAccountsPanel:({projects}:{projects:{name:string}[]})=><div>Shared accounts {projects.map(p=>p.name).join(', ')}</div>}));
import {WorkspaceOwnerTools} from './WorkspaceOwnerTools';
afterEach(()=>{cleanup();invoke.mockReset();});
it('loads project metadata only after the server confirms owner access without starting compute',async()=>{
 invoke.mockImplementation(async(_command,args)=>args.body.action==='workspace-team-list'?{yourAccess:[{role:'owner'}]}:{projects:[{id:'app',name:'App'}]});
 render(<WorkspaceOwnerTools workspaceId="synthetic"/>);await act(async()=>{});
 expect(screen.getByText('Shared accounts App')).toBeInTheDocument();expect(invoke.mock.calls.map(([,args])=>args.body.action)).toEqual(['workspace-team-list','workspace-project-list']);
});
it('a stale owner flag in the parent cannot expose shared account tools to a member',async()=>{
 invoke.mockResolvedValue({yourAccess:[{role:'member'}]});render(<WorkspaceOwnerTools workspaceId="synthetic"/>);await act(async()=>{});
 expect(screen.queryByText(/Shared accounts/)).toBeNull();expect(invoke).toHaveBeenCalledOnce();
});
it('reloads permission metadata after an account change and discards the old response',async()=>{
 let resolve!:(value:unknown)=>void;invoke.mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue({yourAccess:[{role:'member'}]});render(<WorkspaceOwnerTools workspaceId="synthetic"/>);
 await act(async()=>{window.dispatchEvent(new Event('canopy:account-changed'));resolve({yourAccess:[{role:'owner'}]});});
 expect(screen.queryByText(/Shared accounts/)).toBeNull();expect(screen.queryByText('Loading account settings…')).toBeNull();expect(invoke).toHaveBeenCalledTimes(2);
});
it('keeps shared accounts available with an explicit project error when metadata is unavailable; sharing setup lives in Access',async()=>{
 invoke.mockResolvedValueOnce({yourAccess:[{role:'owner'}]}).mockRejectedValueOnce(Error('VM off'));render(<WorkspaceOwnerTools workspaceId="synthetic"/>);await act(async()=>{});
 expect(screen.queryByText(/Turn on sharing$/)).toBeNull();expect(screen.getByText(/Project details are unavailable/)).toBeInTheDocument();expect(screen.getByText('Shared accounts')).toBeInTheDocument();
});
