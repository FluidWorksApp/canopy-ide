import {useEffect} from 'react';import {beforeEach,expect,it,vi} from 'vitest';import {render,screen,fireEvent,waitFor} from '@testing-library/react';
const state=vi.hoisted(()=>({owner:true,invoke:vi.fn(),mode:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:state.invoke}));vi.mock('../executionMode',()=>({canSwitchExecutionMode:()=>true,setExecutionMode:state.mode}));
vi.mock('./workspace',()=>({activeWorkspace:()=>undefined}));vi.mock('../components/WorkspaceSharing',()=>({WorkspaceSharing:()=>null}));vi.mock('../components/SharedSessionsPanel',()=>({SharedSessionsPanel:()=>null}));vi.mock('./LocalProjectImport',()=>({LocalProjectImport:()=>null}));
vi.mock('./ManagedWorkspaces',()=>({ManagedWorkspaces:({onList}:{onList?:(rows:unknown[])=>void})=>{useEffect(()=>{onList?.([{id:'shoaib-work',name:'Shoaib workspace',state:'unknown',cpu_max:4,memory_max_mib:16384,canDelete:false,canRemoveConnection:true,access:{owner:state.owner,canManageAccess:false,canConnect:true,canStop:false}}]);},[onList]);return null;}}));
import {WorkspaceSelector} from './WorkspaceSelector';
beforeEach(()=>{state.owner=true;state.invoke.mockReset();state.mode.mockReset();state.invoke.mockImplementation(async(command,args)=>{if(command==='execution_remote_list')return [{id:'http://127.0.0.1:8787/shoaib-work',endpoint:'http://127.0.0.1:8787',workspaceName:'Shoaib workspace'}];if(command==='canopy_account_request'&&args.route==='/api/workspaces')return args.body?{removed:true,resourcesRetained:true}:{workspaces:[]};return null;});});
it('owner removal requires exact typed name, uses only connection metadata API and retains the VM',async()=>{
 render(<WorkspaceSelector onboarding/>);fireEvent.click(await screen.findByRole('tab',{name:'Shoaib workspace'}));fireEvent.click(screen.getByRole('button',{name:'Tools & accounts'}));fireEvent.click(screen.getByRole('button',{name:'Remove connection from account'}));
 expect(screen.getByText(/The VM keeps running until you stop it separately/)).toBeTruthy();const remove=screen.getByRole('button',{name:'Remove connection'});expect(remove).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Workspace name confirmation'),{target:{value:'wrong'}});expect(remove).toBeDisabled();fireEvent.change(screen.getByLabelText('Workspace name confirmation'),{target:{value:'Shoaib workspace'}});fireEvent.click(remove);
 await waitFor(()=>expect(state.invoke).toHaveBeenCalledWith('canopy_account_request',{route:'/api/workspaces',body:{action:'remove-connection',id:'shoaib-work',confirmName:'Shoaib workspace'}}));
 expect(state.invoke.mock.calls.some(([command,args])=>command==='canopy_account_request'&&args.route==='/api/operations')).toBe(false);expect(state.mode).not.toHaveBeenCalled();
});
it('a member cannot see the owner account-removal action even if a stale flag says it is available',async()=>{
 state.owner=false;render(<WorkspaceSelector onboarding/>);fireEvent.click(await screen.findByRole('tab',{name:'Shoaib workspace'}));expect(screen.queryByRole('button',{name:'Remove connection from account'})).toBeNull();
});
