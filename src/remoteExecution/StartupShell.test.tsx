import {act,fireEvent,render,screen} from '@testing-library/react';
import {beforeEach,it,expect,vi} from 'vitest';
import {useState} from 'react';
const mocks=vi.hoisted(()=>({setMode:vi.fn(),invoke:vi.fn(),throwSelector:false}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../executionMode',()=>({setExecutionMode:mocks.setMode}));
vi.mock('./WorkspaceSelector',()=>({WorkspaceSelector:()=>{const [open,setOpen]=useState(true);if(mocks.throwSelector)throw Error('Synthetic selector failure');return open?<section role="dialog" aria-label="Workspaces"><button onClick={()=>setOpen(false)}>Collapse workspace panel</button></section>:null;}}));
import {StartupShell} from './StartupShell';
beforeEach(()=>{mocks.throwSelector=false;mocks.invoke.mockResolvedValue(undefined);mocks.setMode.mockResolvedValue(undefined);});
it('retains recovery choices after the only workspace panel is collapsed, without selecting local automatically',async()=>{
 render(<StartupShell message="Workspace is stopped" chooseWorkspace/>);await act(async()=>{});expect(screen.queryByRole('dialog',{name:'Workspaces'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Choose workspace'}));fireEvent.click(screen.getByRole('button',{name:'Collapse workspace panel'}));
 expect(screen.queryByRole('dialog',{name:'Workspaces'})).toBeNull();expect(screen.getByRole('status')).toHaveTextContent('Workspace is stopped');expect(screen.getByRole('button',{name:'Choose workspace'})).toBeEnabled();expect(screen.getByRole('button',{name:'Use this Mac'})).toBeEnabled();expect(mocks.setMode).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Choose workspace'}));expect(screen.getByRole('dialog',{name:'Workspaces'})).toBeInTheDocument();
});
it('selector render failure remains inside its boundary and local requires an explicit click',async()=>{
 const consoleError=vi.spyOn(console,'error').mockImplementation(()=>{});mocks.throwSelector=true;
 try{render(<StartupShell message="Connection unavailable" chooseWorkspace/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Choose workspace'}));expect(screen.getByRole('alert')).toHaveTextContent('Workspace selection could not load');expect(screen.getByRole('status')).toHaveTextContent('Connection unavailable');expect(mocks.setMode).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Use this Mac'}));await act(async()=>{});expect(mocks.setMode).toHaveBeenCalledExactlyOnceWith('local');}finally{consoleError.mockRestore();}
});
it('groups the waiting status, progress and workspace action without repeating the status',async()=>{
 const {container}=render(<StartupShell message="Checking your saved workspace connection…"/>);await act(async()=>{});
 const group=container.querySelector('.startup-launcher-wait')!;const status=screen.getByRole('status');
 expect(group).toContainElement(status);expect(status).toHaveTextContent('Checking your saved workspace connection…');expect(status).not.toHaveClass('startup-launcher-status-hidden');
 expect(group.querySelector('.startup-launcher-loader')).not.toBeNull();expect(group).toContainElement(screen.getByRole('button',{name:'Choose workspace'}));
 expect(screen.getAllByText('Checking your saved workspace connection…')).toHaveLength(1);
});
