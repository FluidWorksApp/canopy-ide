import {afterEach,beforeEach,expect,it,vi} from 'vitest';import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
type Pub={id:string;projectId:string;title:string;mode:'view'|'interact';expiresAt:number;sessionId?:number;collaborative?:boolean};
const state=vi.hoisted(()=>({host:null as null|{connection:{workspaceId:string;endpoint:string;token:string;workspaceName:string};client:{workspace:ReturnType<typeof vi.fn>}},connect:vi.fn(),copy:vi.fn()}));
vi.mock('../remoteExecution/workspace',()=>({activeWorkspace:()=>state.host}));
vi.mock('../remoteExecution/workspaceListCache',()=>({peekWorkspaceList:()=>({workspaces:[{id:'ws',name:'API',state:'ready',access:{owner:true}},{id:'team-ws',name:'Ada’s workspace',state:'ready',access:{owner:false}},{id:'cold',name:'Stopped',state:'stopped',access:{owner:false}}],at:0}),refreshWorkspaceList:()=>Promise.resolve({workspaces:[],at:0}),subscribeWorkspaceList:()=>()=>{}}));
vi.mock('../remoteExecution/sharedSessionClient',()=>({sharedSessionClient:state.connect}));
vi.mock('../remoteExecution/RemoteTerminal',()=>({RemoteTerminal:({sharedSessionId,writable}:{sharedSessionId:string;writable:boolean})=><div data-testid="shared-terminal">{sharedSessionId}:{writable?'interactive':'read-only'}</div>}));
vi.mock('../readableLinks',async importOriginal=>({...(await importOriginal<typeof import('../readableLinks')>()),copyReadableLink:state.copy}));
import {LiveSessions} from './LiveSessions';
import {SHARE_TERMINAL_EVENT} from './shareTerminal';
let mine:Pub[]=[];
const own=vi.fn(async(_id:string,route:string,body?:{action:string;id:string})=>{if(route!=='/shared-sessions')throw Error('unexpected '+route);if(body?.action==='revoke')mine=mine.filter(p=>p.id!==body.id);return {sessions:mine};});
const theirs=vi.fn(async()=>({sessions:[{id:'pub-ada',projectId:'web',title:'Fix login',mode:'view',expiresAt:1},{id:'pair-ada',projectId:'web',title:'Pair on web',mode:'interact',expiresAt:1}] as Pub[]}));
beforeEach(()=>{mine=[{id:'pub-7',projectId:'app',title:'Owner shell',mode:'view',expiresAt:1,sessionId:7,collaborative:false}];own.mockClear();theirs.mockClear();state.copy.mockReset();state.copy.mockResolvedValue('https://canopyide.dev/acme/api/s/owner-1');state.connect.mockReset();state.connect.mockResolvedValue({workspace:theirs});state.host={connection:{workspaceId:'ws',endpoint:'https://ws.workspaces.canopyide.dev',token:'owner.token',workspaceName:'API'},client:{workspace:own}};});
afterEach(()=>{cleanup();state.host=null;});
const row=(title:string)=>screen.getByText(title).closest('li') as HTMLElement;
it('lists every session shared with this account, with who shares it and the access',async()=>{
 render(<LiveSessions/>);
 await screen.findByText('Fix login');
 expect(within(row('Owner shell')).getByText('You · View only')).toBeInTheDocument();
 expect(within(row('Fix login')).getByText('Ada’s workspace · View only')).toBeInTheDocument();
 expect(within(row('Pair on web')).getByText('Ada’s workspace · Can type')).toBeInTheDocument();
 // Someone else's: Watch or Join, and a link, but never Stop.
 expect(within(row('Fix login')).getByRole('button',{name:'Watch'})).toBeInTheDocument();
 expect(within(row('Pair on web')).getByRole('button',{name:'Join'})).toBeInTheDocument();
 expect(within(row('Fix login')).queryByRole('button',{name:'Stop'})).toBeNull();
 // Your own: a link and Stop.
 expect(within(row('Owner shell')).getByRole('button',{name:'Copy link'})).toBeInTheDocument();
 expect(within(row('Owner shell')).getByRole('button',{name:'Stop'})).toBeInTheDocument();
 // A stopped workspace is not asked.
 expect(state.connect).toHaveBeenCalledTimes(1);expect(state.connect.mock.calls[0][0]).toBe('team-ws');
});
it('Stop revokes your own share',async()=>{
 render(<LiveSessions/>);
 fireEvent.click(within(await waitFor(()=>row('Owner shell'))).getByRole('button',{name:'Stop'}));
 await waitFor(()=>expect(own).toHaveBeenCalledWith('ws','/shared-sessions',{action:'revoke',id:'pub-7'}));
 await waitFor(()=>expect(screen.queryByText('Owner shell')).toBeNull());
});
it('Watch opens a read-only viewer and Join a shell you can type in',async()=>{
 render(<LiveSessions/>);
 fireEvent.click(within(await waitFor(()=>row('Fix login'))).getByRole('button',{name:'Watch'}));
 expect(await screen.findByTestId('shared-terminal')).toHaveTextContent('pub-ada:read-only');
 fireEvent.click(screen.getByRole('button',{name:/Close/}));
 fireEvent.click(within(row('Pair on web')).getByRole('button',{name:'Join'}));
 await waitFor(()=>expect(screen.getByTestId('shared-terminal')).toHaveTextContent('pair-ada:interactive'));
});
it('Copy link copies the session’s readable link',async()=>{
 render(<LiveSessions/>);
 fireEvent.click(within(await waitFor(()=>row('Owner shell'))).getByRole('button',{name:'Copy link'}));
 await waitFor(()=>expect(state.copy).toHaveBeenCalledWith({kind:'session',workspaceId:'ws',projectId:'app',publicationId:'pub-7',title:'Owner shell'}));
});
it('Share a terminal opens the Share sheet with a picker',async()=>{
 const opened=vi.fn((e:Event)=>(e as CustomEvent).detail);window.addEventListener(SHARE_TERMINAL_EVENT,opened);
 render(<LiveSessions/>);fireEvent.click(screen.getByRole('button',{name:'Share a terminal'}));
 expect(opened).toHaveReturnedWith(null);window.removeEventListener(SHARE_TERMINAL_EVENT,opened);
});
it('a member of the workspace cannot share from it',async()=>{
 state.host!.connection.workspaceId='team-ws';state.host!.connection.endpoint='https://team-ws.workspaces.canopyide.dev';
 render(<LiveSessions/>);
 expect(screen.getByRole('button',{name:'Share a terminal'})).toBeDisabled();expect(screen.getByText('Only the workspace owner can share its terminals.')).toBeInTheDocument();
 await act(async()=>{});
});
it('a shared session link opens its viewer under Team, or says it has ended',async()=>{
 const {openReadableLink}=await import('../readableLinks');
 const link=(publicationId:string)=>openReadableLink('https://canopyide.dev/acme/ada/s/fix-login-27',{follow:vi.fn(),dispatch:vi.fn(),resolve:async()=>({url:'https://canopyide.dev/acme/ada/s/fix-login-27',kind:'session',target:{workspaceId:'team-ws',workspaceName:'Ada',projectId:'web',publicationId,title:'Fix login'}})});
 await act(()=>link('pub-ada'));
 render(<LiveSessions/>);
 expect(await screen.findByTestId('shared-terminal')).toHaveTextContent('pub-ada:read-only');
 cleanup();
 await act(()=>link('gone'));
 render(<LiveSessions/>);
 expect(await screen.findByRole('alert')).toHaveTextContent("ended, or it isn't shared with you");
});
