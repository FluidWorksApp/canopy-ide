import {afterEach,beforeEach,expect,it,vi} from 'vitest';import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
const state=vi.hoisted(()=>({host:null as null|{connection:{workspaceId:string;endpoint:string;token:string;workspaceName:string};client:{workspace:ReturnType<typeof vi.fn>}},copy:vi.fn()}));
vi.mock('../remoteExecution/workspace',()=>({activeWorkspace:()=>state.host}));
vi.mock('../remoteExecution/workspaceListCache',()=>({peekWorkspaceList:()=>({workspaces:[{id:'ws',name:'API',state:'ready',access:{owner:true}}],at:0})}));
vi.mock('./TeamHub',()=>({knownTeams:()=>({teams:[{id:'t1',name:'Engineering'},{id:'t2',name:'Design'}],selected:'t1'})}));
vi.mock('../readableLinks',async importOriginal=>({...(await importOriginal<typeof import('../readableLinks')>()),copyReadableLink:state.copy}));
import {ShareTerminalHost} from './ShareTerminalSheet';
import {shareTerminal,SHARED_SESSIONS_CHANGED} from './shareTerminal';
type Body={action:string;sessionId?:number;projectId?:string;title?:string};
let published:{id:string;projectId:string;title:string;mode:string;expiresAt:number;sessionId?:number;collaborative?:boolean}[]=[];
const request=vi.fn(async(_id:string,route:string,body?:Body)=>{
 if(route==='/projects')return {projects:[{id:'app',name:'Product'}]};
 if(route==='/sessions')return [{id:7,title:'Owner shell',exitCode:null},{id:9,title:'Dev server',exitCode:null},{id:11,title:'Finished build',exitCode:0}];
 if(body?.action==='publish')published=[...published,{id:'pub-'+body.sessionId,projectId:body.projectId!,title:body.title!,mode:'view',expiresAt:1,sessionId:body.sessionId}];
 if(body?.action==='create')published=[...published,{id:'shell-1',projectId:body.projectId!,title:body.title!,mode:'interact',expiresAt:2,collaborative:true}];
 return {sessions:published};
});
beforeEach(()=>{published=[];request.mockClear();state.copy.mockReset();state.copy.mockResolvedValue('https://canopyide.dev/acme/api/s/x-1');state.host={connection:{workspaceId:'ws',endpoint:'https://ws.workspaces.canopyide.dev',token:'owner.token',workspaceName:'API'},client:{workspace:request}};});
afterEach(()=>{cleanup();state.host=null;});
const open=(...args:Parameters<typeof shareTerminal>)=>act(()=>shareTerminal(...args));
it('Share on a terminal opens the sheet on that terminal, with no terminal picker',async()=>{
 render(<ShareTerminalHost/>);open({sessionId:7,title:'Owner shell',projectId:'app',projectName:'Product'});
 const sheet=screen.getByRole('dialog',{name:'Share “Owner shell”'});
 expect(within(sheet).queryByRole('group',{name:'Terminal'})).toBeNull();
 expect(within(sheet).getByRole('combobox',{name:'Team'})).toHaveValue('t1');
 expect(within(sheet).getByRole('radio',{name:/Watch only/})).toBeChecked();
 expect(within(sheet).getByText('Viewers see earlier output too.')).toBeInTheDocument();
 // No "nothing private on screen" gate: the primary button is the acknowledgement.
 expect(within(sheet).queryByRole('checkbox')).toBeNull();
 await waitFor(()=>expect(within(sheet).getByRole('button',{name:/Share \+ copy link/})).toBeEnabled());
 // The project comes from the terminal; nothing asks for one.
 expect(within(sheet).queryByRole('combobox',{name:'Project'})).toBeNull();
});
it('Watch only publishes the terminal for viewing and copies its link',async()=>{
 const changed=vi.fn();window.addEventListener(SHARED_SESSIONS_CHANGED,changed);
 render(<ShareTerminalHost/>);open({sessionId:7,title:'Owner shell',projectId:'app',projectName:'Product'});
 const share=screen.getByRole('button',{name:/Share \+ copy link/});await waitFor(()=>expect(share).toBeEnabled());fireEvent.click(share);
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'publish',sessionId:7,projectId:'app',title:'Owner shell',mode:'view',acknowledged:true}));
 await waitFor(()=>expect(state.copy).toHaveBeenCalledWith({kind:'session',workspaceId:'ws',projectId:'app',publicationId:'pub-7',title:'Owner shell'}));
 expect(await screen.findByRole('status')).toHaveTextContent('Link copied');
 expect(changed).toHaveBeenCalled();window.removeEventListener(SHARED_SESSIONS_CHANGED,changed);
});
it('Pair starts a clean shell in the terminal’s project and copies its link',async()=>{
 render(<ShareTerminalHost/>);open({sessionId:7,title:'Owner shell',projectId:'app',projectName:'Product'});
 fireEvent.click(screen.getByRole('radio',{name:/Pair \(can type\)/}));
 const clean=screen.getByRole('checkbox',{name:/Start a clean shell instead/});expect(clean).toBeChecked();expect(clean).toBeDisabled();
 expect(screen.getByText(/Typing in an existing terminal isn't available/)).toBeInTheDocument();
 const start=screen.getByRole('button',{name:/Share \+ copy link/});await waitFor(()=>expect(start).toBeEnabled());fireEvent.click(start);
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'create',projectId:'app',title:'Owner shell'}));
 expect(request.mock.calls.some(([,,body])=>(body as Body|undefined)?.action==='publish')).toBe(false);
 await waitFor(()=>expect(state.copy).toHaveBeenCalledWith({kind:'session',workspaceId:'ws',projectId:'app',publicationId:'shell-1',title:'Owner shell'}));
});
it('from the Team panel the sheet lists running terminals to pick from',async()=>{
 render(<ShareTerminalHost/>);open();
 const sheet=screen.getByRole('dialog',{name:'Share a terminal'});
 const picker=await within(sheet).findByRole('group',{name:'Terminal'});
 const cards=await within(picker).findAllByRole('button');expect(cards.map(c=>c.textContent)).toEqual(['Owner shellTerminal 7','Dev serverTerminal 9']);
 expect(within(sheet).getByRole('button',{name:/Share \+ copy link/})).toBeDisabled();
 fireEvent.click(within(picker).getByRole('button',{name:/Dev server/}));expect(within(picker).getByRole('button',{name:/Dev server/})).toHaveAttribute('aria-pressed','true');
 const share=within(sheet).getByRole('button',{name:/Share \+ copy link/});await waitFor(()=>expect(share).toBeEnabled());fireEvent.click(share);
 await waitFor(()=>expect(request).toHaveBeenCalledWith('ws','/shared-sessions',{action:'publish',sessionId:9,projectId:'app',title:'Dev server',mode:'view',acknowledged:true}));
});
it('says why when this window cannot share',()=>{
 state.host=null;render(<ShareTerminalHost/>);open({sessionId:7,title:'Owner shell'});
 expect(screen.getByRole('dialog')).toHaveTextContent('Terminals on this computer stay private');expect(screen.queryByRole('button',{name:/copy link/})).toBeNull();
});
