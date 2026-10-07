import {afterEach,it,expect,vi} from 'vitest';import {render,screen,fireEvent,waitFor,cleanup,act} from '@testing-library/react';import {SharedSessionsPanel} from './SharedSessionsPanel';
const state=vi.hoisted(()=>({host:null as null|{connection:{workspaceId:string};client:{workspace:ReturnType<typeof vi.fn>}}}));
vi.mock('../remoteExecution/workspace',()=>({activeWorkspace:()=>state.host}));
vi.mock('../remoteExecution/RemoteTerminal',()=>({RemoteTerminal:({sharedSessionId,writable}:{sharedSessionId:string;writable:boolean})=><div data-testid="shared-terminal">{sharedSessionId}:{writable?'interactive':'read-only'}</div>}));
afterEach(()=>{cleanup();state.host=null;});
it('does not wake or request a connection for an inactive workspace',()=>{render(<SharedSessionsPanel workspaceId="ws" owner/>);expect(screen.getByText(/Opening this panel does not start the workspace/)).toBeInTheDocument();});
it('owner publication requires explicit transcript disclosure while collaboration is project scoped',async()=>{
 const request=vi.fn(async(_id,route)=>route==='/projects'?{projects:[{id:'app',name:'Product'}]}:route==='/sessions'?[{id:7,title:'Owner shell',exitCode:null}]:{sessions:[]});state.host={connection:{workspaceId:'ws'},client:{workspace:request}};
 render(<SharedSessionsPanel workspaceId="ws" owner/>);fireEvent.click(screen.getByText('Shared sessions'));await screen.findByRole('option',{name:'Product'});fireEvent.change(screen.getByRole('combobox',{name:'Project'}),{target:{value:'app'}});fireEvent.change(screen.getByRole('textbox',{name:'Session name'}),{target:{value:'Pair'}});fireEvent.change(screen.getByRole('combobox',{name:'Your terminal'}),{target:{value:'7'}});
 expect(screen.getByRole('button',{name:'Share view-only'})).toBeDisabled();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Share view-only'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'publish',sessionId:7,projectId:'app',title:'Pair',mode:'view',acknowledged:true}));
 fireEvent.click(screen.getByRole('button',{name:'Start shared shell'}));await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'create',projectId:'app',title:'Pair'}));
});
it('members see only published sessions and account changes close terminal output',async()=>{
 const request=vi.fn(async(_id,route)=>route==='/projects'?{projects:[{id:'app',name:'Product'}]}:{sessions:[{id:'publication',projectId:'app',title:'Build',mode:'view',expiresAt:Date.now()+10000}]});state.host={connection:{workspaceId:'ws'},client:{workspace:request}};
 render(<SharedSessionsPanel workspaceId="ws" owner={false}/>);fireEvent.click(screen.getByText('Shared sessions'));fireEvent.click(await screen.findByRole('button',{name:'Build'}));expect(screen.getByTestId('shared-terminal')).toHaveTextContent('publication:read-only');expect(request.mock.calls.some(([,route])=>route==='/sessions')).toBe(false);expect(screen.queryByRole('button',{name:'Start shared shell'})).toBeNull();
 act(()=>window.dispatchEvent(new Event('canopy:account-changed')));expect(screen.queryByTestId('shared-terminal')).toBeNull();expect(screen.queryByRole('button',{name:'Build'})).toBeNull();
});
