import {render,screen} from '@testing-library/react';import {it,expect,vi} from 'vitest';
import {ManagedWorkspaces} from './ManagedWorkspaces';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({workspaces:[{id:'shared',name:'Engineering',provider:'lightsail',state:'ready',cpu_max:2,memory_max_mib:8192,access:{owner:false,canConnect:false,canStop:false,canManageAccess:false}}]}))}));
vi.mock('../components/AccountSettings',()=>({AccountSettings:()=>null}));
vi.mock('./workspace',()=>({activeWorkspace:()=>null}));
vi.mock('../executionMode',()=>({canSwitchExecutionMode:()=>true,setExecutionMode:vi.fn()}));
it('shows shared workspace without exposing owner-only lifecycle controls',async()=>{render(<ManagedWorkspaces/>);expect(await screen.findByRole('button',{name:'Shared access pending'})).toBeDisabled();expect(screen.queryByRole('button',{name:'Stop workspace'})).toBeNull();expect(screen.getByText('Shared with you')).toBeInTheDocument();});
