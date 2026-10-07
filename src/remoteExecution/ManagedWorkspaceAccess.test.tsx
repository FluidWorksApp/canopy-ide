import {render,screen} from '@testing-library/react';import {it,expect,vi} from 'vitest';
import {ManagedWorkspaces} from './ManagedWorkspaces';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({workspaces:[{id:'shared',name:'Engineering',provider:'lightsail',state:'ready',cpu_max:2,memory_max_mib:8192,access:{owner:false,canConnect:false,canStop:false,canManageAccess:false}}]}))}));
vi.mock('../components/AccountSettings',()=>({AccountSettings:()=>null}));
vi.mock('./workspace',()=>({activeWorkspace:()=>null}));
vi.mock('../executionMode',()=>({canSwitchExecutionMode:()=>true,setExecutionMode:vi.fn()}));
it('shows shared workspace without exposing owner-only lifecycle controls',async()=>{render(<ManagedWorkspaces/>);expect(await screen.findByRole('button',{name:'Can’t connect yet'})).toBeDisabled();expect(screen.queryByRole('button',{name:'Stop workspace'})).toBeNull();expect(screen.getByText('Shared with you')).toBeInTheDocument();});
it('tells a member why they cannot connect, using the account service reason',async()=>{
 const {invoke}=await import('@tauri-apps/api/core');
 vi.mocked(invoke).mockResolvedValue({workspaces:[{id:'off',name:'Design',provider:'lightsail',state:'ready',cpu_max:2,memory_max_mib:8192,access:{owner:false,canConnect:false,canStop:false,canManageAccess:false,connectionUnavailable:'Sharing isn’t turned on for this workspace yet. Ask the owner to turn it on.'}}]});
 render(<ManagedWorkspaces/>);await screen.findByText('Design');const button=screen.getByRole('button',{name:'Can’t connect yet'});
 expect(button).toBeDisabled();expect(button).toHaveAttribute('title','Sharing isn’t turned on for this workspace yet. Ask the owner to turn it on.');expect(screen.getByText(/Ask the owner to turn it on/)).toHaveClass('workspace-hero-unavailable');
});
