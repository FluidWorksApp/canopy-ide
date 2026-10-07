import {act,fireEvent,render,screen} from '@testing-library/react';import {it,expect,vi} from 'vitest';import {WorkspaceSelector} from './WorkspaceSelector';
const mocks=vi.hoisted(()=>({workspace:vi.fn(),openLink:vi.fn()}));
vi.mock('./workspace',()=>({activeWorkspace:()=>({connection:{workspaceId:'test',workspaceName:'Test',endpoint:'http://127.0.0.1:8787'},client:{workspace:mocks.workspace}})}));vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>[])}));vi.mock('../links',()=>({openLink:mocks.openLink}));vi.mock('./RemoteDesktop',()=>({RemoteDesktop:()=> <div>Remote desktop surface</div>}));vi.mock('./LocalProjectImport',()=>({LocalProjectImport:()=>null}));
it('offers a visible desktop control',async()=>{mocks.workspace.mockResolvedValue({result:null});render(<WorkspaceSelector/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Open remote desktop'}));expect(screen.getByText('Remote desktop surface')).toBeInTheDocument();});
it('retains pending browser requests without polling header metrics',async()=>{
 vi.useFakeTimers();let requests=0;mocks.workspace.mockImplementation(async(_id:string,_route:string,args:{command:string})=>{if(args.command==='workspace_metrics')throw Error('unavailable');requests++;return {result:`https://github.com/login/device?request=${requests}`};});
 try{render(<WorkspaceSelector/>);await act(async()=>{});expect(requests).toBe(1);expect(screen.queryByLabelText('Workspace resource usage')).toBeNull();expect(mocks.workspace.mock.calls.every(call=>call[2].command!=='workspace_metrics')).toBe(true);await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(requests).toBe(1);fireEvent.click(screen.getByRole('button',{name:'Open browser ↗'}));expect(mocks.openLink).toHaveBeenCalledWith('https://github.com/login/device?request=1',true);await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(requests).toBe(2);
 }finally{vi.useRealTimers();}
});
it('separates new workspace setup and scopes controls to the selected workspace tab',async()=>{
 mocks.workspace.mockResolvedValue({result:null});render(<WorkspaceSelector/>);await act(async()=>{});
 fireEvent.click(screen.getByTitle('Test · Connecting…'));
 expect(screen.getByRole('tab',{name:/Test/})).toHaveAttribute('aria-selected','true');
 expect(screen.getByText('Personal accounts')).toBeInTheDocument();
 expect(screen.queryByText('Add remote workspace')).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'Local workspace'}));
 expect(screen.queryByRole('button',{name:'Copy accounts'})).toBeNull();
 expect(screen.getByRole('button',{name:'Use this workspace'})).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'＋ New workspace'}));
 expect(screen.getByText('Cloud workspaces')).toBeInTheDocument();
 expect(screen.getByLabelText('Access token')).toBeInTheDocument();
 expect(screen.queryByRole('tablist',{name:'Workspaces'})).toBeNull();
});
it('offers workspace hibernation with a confirmation and runs the project snapshot workflow',async()=>{
 mocks.workspace.mockResolvedValue({result:null});const hibernate=vi.fn().mockResolvedValue(undefined);
 render(<WorkspaceSelector onHibernateWorkspace={hibernate}/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'Hibernate workspace'}));
 expect(screen.getByText('Hibernate Test?')).toBeInTheDocument();
 expect(screen.getByText(/Save all open projects, then stop/)).toBeInTheDocument();
 expect(hibernate).not.toHaveBeenCalled();
 fireEvent.click(screen.getAllByRole('button',{name:/Hibernate workspace/}).at(-1)!);
 await act(async()=>{});expect(hibernate).toHaveBeenCalledOnce();
});
it('replaces the confirmation with live nonmodal stages and can minimize while shutdown is pending',async()=>{let publish!:(value:any)=>void;let finish!:()=>void;const hibernate=vi.fn((listener?:Function)=>{publish=listener as any;return new Promise<void>(resolve=>{finish=resolve;});});mocks.workspace.mockResolvedValue({result:null});render(<WorkspaceSelector onHibernateWorkspace={hibernate}/>);await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Hibernate workspace'}));fireEvent.click(screen.getAllByRole('button',{name:/Hibernate workspace/}).at(-1)!);expect(screen.queryByText('Hibernate Test?')).toBeNull();expect(screen.getByLabelText('Workspace hibernation progress')).toBeInTheDocument();await act(async()=>publish({phase:'stopping-compute',shutdownAccepted:true}));fireEvent.click(screen.getByRole('button',{name:'Continue working'}));expect(screen.getByRole('status')).toHaveTextContent('Stop compute');expect(screen.queryByRole('button',{name:'Cancel'})).toBeNull();expect(hibernate).toHaveBeenCalledOnce();await act(async()=>finish());expect(screen.getByRole('status')).toHaveTextContent('Compute is stopped');});
