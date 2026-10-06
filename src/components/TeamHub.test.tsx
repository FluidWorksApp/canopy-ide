import {render,screen,fireEvent} from '@testing-library/react';
import {beforeEach,it,expect,vi} from 'vitest';
import {TeamHub} from './TeamHub';
const chat=vi.hoisted(()=>({send:vi.fn(async()=>({id:'message',partial:false}))}));
vi.mock('../teamMessaging/client',()=>({PeerClient:class{start=vi.fn(async()=>{});stop=vi.fn();send=chat.send;}}));
const invoke=vi.hoisted(()=>vi.fn());vi.mock('@tauri-apps/api/core',()=>({invoke}));vi.mock('./AccountSettings',()=>({AccountSettings:()=>null}));
beforeEach(()=>{invoke.mockReset();invoke.mockImplementation(async(_name,{body})=>{if(!body)return {selfId:'me',teams:[{id:'team',name:'Engineering',role:'owner'}],invitations:[]};if(body.action==='detail')return {members:[{id:'me',name:'Me',role:'owner'},{id:'ada',name:'Ada',role:'member'}],invitations:[]};if(body.action==='messages')return {messages:[]};return {};});});
it('opens an existing IDE conversation workflow from the people directory',async()=>{const open=vi.fn();render(<TeamHub onOpenChat={open}/>);fireEvent.click(await screen.findByRole('button',{name:'Ada'}));expect(open).toHaveBeenCalledWith({teamId:'team',userId:'me',peer:'ada',name:'Ada'});expect(screen.queryByRole('textbox',{name:'Message'})).toBeNull();expect(screen.queryByRole('button',{name:'Me'})).toBeNull();});
it('opens the team channel without fetching plaintext messages',async()=>{const open=vi.fn();render(<TeamHub onOpenChat={open}/>);fireEvent.click(await screen.findByRole('button',{name:/Engineering.*Everyone/}));expect(open).toHaveBeenCalledWith({teamId:'team',userId:'me',peer:null,name:'Engineering'});expect(invoke.mock.calls.some(([,args])=>['messages','send'].includes(args.body?.action))).toBe(false);});
it('creates teams inside the selected organization instead of detached personal teams',async()=>{
 invoke.mockImplementation(async(_name,{body})=>!body?{selfId:'me',teams:[],invitations:[]}:body.action==='organization-list'?{organizations:[{id:'org',name:'Default organization',role:'owner'},{id:'member-org',name:'Read-only organization',role:'member'}]}:{});
 render(<TeamHub/>);await screen.findByRole('option',{name:'Default organization'});expect(screen.queryByRole('option',{name:'Read-only organization'})).toBeNull();fireEvent.change(screen.getByRole('textbox',{name:'Team name'}),{target:{value:'Engineering'}});fireEvent.click(screen.getByRole('button',{name:'Create team'}));
 await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('canopy_account_request',{route:'/api/teams',body:{action:'organization-team-create',organizationId:'org',name:'Engineering'}}));expect(invoke.mock.calls.some(([,args])=>args.body?.action==='create')).toBe(false);
});
