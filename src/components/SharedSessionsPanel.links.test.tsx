import {afterEach,expect,it,vi} from 'vitest';import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
const mocks=vi.hoisted(()=>({connect:vi.fn(),request:vi.fn()}));
vi.mock('../remoteExecution/workspace',()=>({activeWorkspace:()=>null}));
vi.mock('../remoteExecution/RemoteTerminal',()=>({RemoteTerminal:({sharedSessionId}:{sharedSessionId:string})=><div data-testid="shared-terminal">{sharedSessionId}</div>}));
vi.mock('../remoteExecution/sharedSessionClient',()=>({sharedSessionClient:mocks.connect}));
import {SharedSessionsPanel} from './SharedSessionsPanel';
import {openReadableLink} from '../readableLinks';
afterEach(()=>{cleanup();mocks.connect.mockReset();mocks.request.mockReset();});
const sessions={sessions:[{id:'pub-1',projectId:'app',title:'Fix login',mode:'view',expiresAt:Date.now()+60000}]};
it('a shared session link opens the panel, connects by itself and shows that session',async()=>{
 mocks.request.mockImplementation(async(_id:string,route:string)=>route==='/projects'?{projects:[{id:'app',name:'Product'}]}:sessions);
 mocks.connect.mockResolvedValue({workspace:mocks.request});
 render(<SharedSessionsPanel workspaceId="ws-1" owner={false}/>);
 expect(mocks.connect).not.toHaveBeenCalled();
 await act(()=>openReadableLink('https://canopyide.dev/acme/api/s/fix-login-27',{follow:vi.fn(),resolve:async()=>({url:'https://canopyide.dev/acme/api/s/fix-login-27',kind:'session',target:{workspaceId:'ws-1',workspaceName:'API',projectId:'app',publicationId:'pub-1',title:'Fix login'}})}));
 await waitFor(()=>expect(screen.getByTestId('shared-terminal')).toHaveTextContent('pub-1'));
 expect(mocks.connect).toHaveBeenCalledTimes(1);
 expect(screen.getByRole('button',{name:'Copy link'})).toBeInTheDocument();
});
it('says so when the linked session is no longer shared',async()=>{
 mocks.request.mockImplementation(async(_id:string,route:string)=>route==='/projects'?{projects:[]}:{sessions:[]});
 mocks.connect.mockResolvedValue({workspace:mocks.request});
 render(<SharedSessionsPanel workspaceId="ws-1" owner={false}/>);
 await act(()=>openReadableLink('https://canopyide.dev/acme/api/s/gone-11',{follow:vi.fn(),resolve:async()=>({url:'https://canopyide.dev/acme/api/s/gone-11',kind:'session',target:{workspaceId:'ws-1',workspaceName:'API',projectId:'app',publicationId:'pub-gone',title:''}})}));
 expect(await screen.findByRole('alert')).toHaveTextContent("ended, or it isn't shared with you");
});
