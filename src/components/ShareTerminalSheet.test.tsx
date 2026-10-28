import {afterEach,beforeEach,expect,it,vi} from 'vitest';import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
const state=vi.hoisted(()=>({host:null as null|{connection:{workspaceId:string;endpoint:string;token:string;workspaceName:string};client:{workspace:ReturnType<typeof vi.fn>}},copy:vi.fn()}));
vi.mock('../remoteExecution/workspace',()=>({activeWorkspace:()=>state.host}));
vi.mock('../remoteExecution/workspaceListCache',()=>({peekWorkspaceList:()=>({workspaces:[{id:'ws',name:'API',state:'ready',access:{owner:true}}],at:0})}));
vi.mock('../readableLinks',async importOriginal=>({...(await importOriginal<typeof import('../readableLinks')>()),copyReadableLink:state.copy}));
import {ShareTerminalHost} from './ShareTerminalSheet';
import {publishShareableTerminals,shareTerminal,terminalLabel,SHARED_SESSIONS_CHANGED} from './shareTerminal';
type Body={action:string;sessionId?:number;projectId?:string;title?:string};
let projects:{id:string;name:string;canPair?:boolean}[]=[],failure:Error|null=null;
let published:{id:string;projectId:string;title:string;mode:string;expiresAt:number;sessionId?:number;collaborative?:boolean}[]=[];
const request=vi.fn(async(_id:string,route:string,body?:Body)=>{
 if(route==='/projects')return {projects};
 if(failure&&body)throw failure;
 if(route==='/sessions')return [{id:7,title:"cd '/workspace/projects/app' && exec claude",exitCode:null},{id:9,title:'npm run dev',exitCode:null},{id:11,title:'Finished build',exitCode:0},{id:12,title:'bash',exitCode:null},{id:203,title:'orphan',exitCode:null}];
 if(body?.action==='publish')published=[...published,{id:'pub-'+body.sessionId,projectId:body.projectId!,title:body.title!,mode:'view',expiresAt:1,sessionId:body.sessionId}];
 if(body?.action==='create')published=[...published,{id:'shell-1',projectId:body.projectId!,title:body.title!,mode:'interact',expiresAt:2,collaborative:true}];
 return {sessions:published};
});
beforeEach(()=>{published=[];projects=[{id:'app',name:'Product'}];failure=null;request.mockClear();state.copy.mockReset();state.copy.mockResolvedValue('https://canopyide.dev/acme/api/s/x-1');state.host={connection:{workspaceId:'ws',endpoint:'https://ws.workspaces.canopyide.dev',token:'owner.token',workspaceName:'API'},client:{workspace:request}};});
afterEach(()=>{cleanup();state.host=null;for(const id of ['p-app','p-suprflow','p-local'])publishShareableTerminals(id,[]);});
const open=(...args:Parameters<typeof shareTerminal>)=>act(()=>shareTerminal(...args));
const claude={sessionId:7,title:'claude',projectId:'app',projectName:'Product',branch:'main',workspaceId:'ws'};
const share=()=>screen.getByRole('button',{name:/Share — they can watch/});
const tabs=()=>{
 publishShareableTerminals('p-app',[claude,{sessionId:9,title:'Dev server',projectId:'app',projectName:'Product',branch:'feat/login',workspaceId:'ws'},{sessionId:11,title:'Finished build',projectId:'app',projectName:'Product',workspaceId:'ws'}]);
 publishShareableTerminals('p-suprflow',[{sessionId:12,title:'',projectId:'notes',projectName:'Notes',workspaceId:'ws'}]);
 publishShareableTerminals('p-local',[{sessionId:9,title:'local shell',projectId:'x',projectName:'Elsewhere'}]);
};
it('names a terminal the way its tab does, never by command or number',()=>{
 expect(terminalLabel(claude)).toBe('claude · Product · main');
 expect(terminalLabel({sessionId:3,title:'',projectName:'SuprFlow',branch:'main'})).toBe('SuprFlow terminal · main');
 expect(terminalLabel({sessionId:3,title:'  '})).toBe('Terminal');
 expect(terminalLabel({sessionId:3,title:'Product',projectName:'Product'})).toBe('Product');
});
it('Share on a terminal opens on that terminal: no picker, no project, no radios',async()=>{
 render(<ShareTerminalHost/>);open(claude);
 const sheet=screen.getByRole('dialog',{name:'Share “claude · Product · main”'});
 expect(within(sheet).queryByRole('group',{name:'Terminal'})).toBeNull();
 expect(within(sheet).queryByRole('combobox')).toBeNull();expect(within(sheet).queryByRole('radio')).toBeNull();expect(within(sheet).queryByRole('checkbox')).toBeNull();
 expect(sheet.textContent).not.toMatch(/Who sees it|Access tab|Terminal 7/);
 expect(within(sheet).getByText('Your team sees it under Team → Live now.')).toBeInTheDocument();
 await waitFor(()=>expect(share()).toBeEnabled());
 expect(within(sheet).getByText("They also see what's already on screen.")).toBeInTheDocument();
 expect(within(sheet).getByRole('button',{name:'Pair in a fresh shell'})).toBeEnabled();
});
it('Share — they can watch publishes the terminal for viewing and copies its link',async()=>{
 const changed=vi.fn();window.addEventListener(SHARED_SESSIONS_CHANGED,changed);
 render(<ShareTerminalHost/>);open(claude);
 await waitFor(()=>expect(share()).toBeEnabled());fireEvent.click(share());
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'publish',sessionId:7,projectId:'app',title:'claude · Product · main',mode:'view',acknowledged:true}));
 await waitFor(()=>expect(state.copy).toHaveBeenCalledWith({kind:'session',workspaceId:'ws',projectId:'app',publicationId:'pub-7',title:'claude · Product · main'}));
 expect(await screen.findByRole('status')).toHaveTextContent('Link copied');
 expect(changed).toHaveBeenCalled();window.removeEventListener(SHARED_SESSIONS_CHANGED,changed);
});
it('Pair in a fresh shell starts a clean shell in the terminal’s project and copies its link',async()=>{
 render(<ShareTerminalHost/>);open(claude);
 const pair=await screen.findByRole('button',{name:'Pair in a fresh shell'});await waitFor(()=>expect(pair).toBeEnabled());fireEvent.click(pair);
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'create',projectId:'app',title:'Pair on Product'}));
 expect(request.mock.calls.some(([,,body])=>(body as Body|undefined)?.action==='publish')).toBe(false);
 await waitFor(()=>expect(state.copy).toHaveBeenCalledWith({kind:'session',workspaceId:'ws',projectId:'app',publicationId:'shell-1',title:'Pair on Product'}));
});
it('from the Team panel it lists open terminal tabs by name; an unshared project is greyed with a reason',async()=>{
 tabs();render(<ShareTerminalHost/>);open();
 const sheet=screen.getByRole('dialog',{name:'Share a terminal'});
 const picker=await within(sheet).findByRole('group',{name:'Terminal'});
 await waitFor(()=>expect(within(picker).getByRole('button',{name:/Notes terminal/})).toBeDisabled());
 const cards=within(picker).getAllByRole('button');
 // Running tabs in this workspace only: no exited build, no other window's local shell, no session without a tab.
 expect(cards.map(c=>c.textContent)).toEqual(['claude · Product · main','Dev server · Product · feat/login','Notes terminal'+'Not shared with your team']);
 expect(sheet.textContent).not.toMatch(/Terminal \d|cd '|npm run dev|orphan/);
 expect(within(sheet).queryByRole('combobox')).toBeNull();
 expect(share()).toBeDisabled();expect(within(sheet).queryByRole('button',{name:'Pair in a fresh shell'})).toBeNull();
 fireEvent.click(within(picker).getByRole('button',{name:/Dev server/}));expect(within(picker).getByRole('button',{name:/Dev server/})).toHaveAttribute('aria-pressed','true');
 await waitFor(()=>expect(share()).toBeEnabled());fireEvent.click(share());
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'publish',sessionId:9,projectId:'app',title:'Dev server · Product · feat/login',mode:'view',acknowledged:true}));
});
it('a terminal in the owner’s own project can be watched; Pair is not offered',async()=>{
 projects=[{id:'app',name:'Product',canPair:true},{id:'suprflow',name:'SuprFlow',canPair:false}];
 render(<ShareTerminalHost/>);open({sessionId:7,title:'claude',projectId:'suprflow',projectName:'SuprFlow',branch:'main'});
 const sheet=screen.getByRole('dialog',{name:'Share “claude · SuprFlow · main”'});
 await waitFor(()=>expect(share()).toBeEnabled());
 expect(within(sheet).queryByRole('button',{name:'Pair in a fresh shell'})).toBeNull();
 fireEvent.click(share());
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'publish',sessionId:7,projectId:'suprflow',title:'claude · SuprFlow · main',mode:'view',acknowledged:true}));
 expect(request.mock.calls.some(([,,body])=>(body as Body|undefined)?.action==='create')).toBe(false);
 expect(await screen.findByRole('status')).toHaveTextContent('Link copied');
});
it('a terminal whose project is not shared says so and offers nothing to press',async()=>{
 render(<ShareTerminalHost/>);open({sessionId:7,title:'claude',projectId:'scratch',projectName:'Scratch'});
 const sheet=screen.getByRole('dialog');
 expect(await within(sheet).findByText(/Not shared with your team/)).toBeInTheDocument();
 expect(share()).toBeDisabled();expect(within(sheet).queryByRole('button',{name:'Pair in a fresh shell'})).toBeNull();
});
it('a project mount is found from the terminal’s cwd',async()=>{
 render(<ShareTerminalHost/>);open({sessionId:7,title:'zsh',cwd:'/workspace/projects/app/web'});
 await waitFor(()=>expect(share()).toBeEnabled());fireEvent.click(share());
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',expect.objectContaining({action:'publish',projectId:'app',title:'zsh'})));
});
it('turns a raw host refusal into plain words',async()=>{
 failure=Error('Invalid session publication');
 render(<ShareTerminalHost/>);open(claude);
 await waitFor(()=>expect(share()).toBeEnabled());fireEvent.click(share());
 const alert=await screen.findByRole('alert');
 expect(alert).toHaveTextContent("This project's terminals can't be shared from this workspace yet.");expect(alert.textContent).not.toMatch(/Invalid/);
});
it('says why when this window cannot share',()=>{
 state.host=null;render(<ShareTerminalHost/>);open({sessionId:7,title:'Owner shell'});
 expect(screen.getByRole('dialog')).toHaveTextContent('Terminals on this computer stay private');expect(screen.queryByRole('button',{name:/they can watch/})).toBeNull();
});
