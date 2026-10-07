import {render,screen,fireEvent,act,within} from '@testing-library/react';
import {beforeEach,it,expect,vi} from 'vitest';
import {TeamHub} from './TeamHub';
import {avatarTone,displayName,initials,secondaryEmail,AVATAR_TONES} from './teamHubPeople';
const chat=vi.hoisted(()=>({send:vi.fn(async()=>({id:'message',partial:false}))}));
vi.mock('../teamMessaging/client',()=>({PeerClient:class{start=vi.fn(async()=>{});stop=vi.fn();send=chat.send;}}));
const invoke=vi.hoisted(()=>vi.fn());vi.mock('@tauri-apps/api/core',()=>({invoke}));vi.mock('./AccountSettings',()=>({AccountSettings:()=>null}));
type Body={action?:string;teamId?:string}|null;
const directory={selfId:'me',teams:[{id:'team',name:'Engineering',role:'owner'}],invitations:[]};
const detail={members:[{id:'me',name:'Me',role:'owner'},{id:'ada',name:'Ada',role:'member'}],invitations:[]};
const respond=(body:Body)=>{if(!body)return directory;if(body.action==='detail')return detail;if(body.action==='messages')return {messages:[]};return {};};
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(a=>{resolve=a;});return {promise,resolve};};
// Every test starts signed in to a fresh account, so the in-memory cache from
// the previous test cannot leak in.
beforeEach(()=>{window.dispatchEvent(new Event('canopy:account-changed'));invoke.mockReset();invoke.mockImplementation(async(_name,{body})=>respond(body));});

it('opens an existing IDE conversation workflow from the people directory',async()=>{const open=vi.fn();render(<TeamHub onOpenChat={open}/>);fireEvent.click(await screen.findByRole('button',{name:'Ada'}));expect(open).toHaveBeenCalledWith({teamId:'team',userId:'me',peer:'ada',name:'Ada'});expect(screen.queryByRole('textbox',{name:'Message'})).toBeNull();expect(screen.queryByRole('button',{name:'Me'})).toBeNull();});
it('opens the team channel without fetching plaintext messages',async()=>{const open=vi.fn();render(<TeamHub onOpenChat={open}/>);fireEvent.click(await screen.findByRole('button',{name:/Engineering.*Everyone/}));expect(open).toHaveBeenCalledWith({teamId:'team',userId:'me',peer:null,name:'Engineering'});expect(invoke.mock.calls.some(([,args])=>['messages','send'].includes(args.body?.action))).toBe(false);});
it('creates teams inside the selected organization instead of detached personal teams',async()=>{
 invoke.mockImplementation(async(_name,{body})=>!body?{selfId:'me',teams:[],invitations:[]}:body.action==='organization-list'?{organizations:[{id:'org',name:'Default organization',role:'owner'},{id:'member-org',name:'Read-only organization',role:'member'}]}:{});
 render(<TeamHub/>);await screen.findByRole('option',{name:'Default organization'});expect(screen.queryByRole('option',{name:'Read-only organization'})).toBeNull();fireEvent.change(screen.getByRole('textbox',{name:'Team name'}),{target:{value:'Engineering'}});fireEvent.click(screen.getByRole('button',{name:'Create team'}));
 await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('canopy_account_request',{route:'/api/teams',body:{action:'organization-team-create',organizationId:'org',name:'Engineering'}}));expect(invoke.mock.calls.some(([,args])=>args.body?.action==='create')).toBe(false);
});

it('shows skeleton rows, not a blank panel or the create-team form, on first load',async()=>{
 const list=deferred<unknown>();invoke.mockImplementation((_name,{body})=>!body?list.promise:Promise.resolve(respond(body)));
 const {container}=render(<TeamHub onOpenChat={vi.fn()}/>);
 expect(screen.getByRole('status')).toHaveTextContent('Loading teams');
 expect(container.querySelectorAll('.team-row-skeleton').length).toBeGreaterThan(0);
 expect(screen.queryByRole('textbox',{name:'Team name'})).toBeNull();
 expect(screen.queryByRole('alert')).toBeNull();
 await act(async()=>list.resolve(directory));
 expect(await screen.findByRole('button',{name:'Ada'})).toBeInTheDocument();
 expect(screen.queryByText('Loading teams…')).toBeNull();
 expect(container.querySelectorAll('.team-row-skeleton')).toHaveLength(0);
});

it('keeps last-known people on screen when the panel remounts and refreshes',async()=>{
 const first=render(<TeamHub onOpenChat={vi.fn()}/>);await screen.findByRole('button',{name:'Ada'});first.unmount();
 const never=new Promise(()=>{});invoke.mockImplementation(()=>never);
 const {container}=render(<TeamHub onOpenChat={vi.fn()}/>);
 // Synchronously, before any request settles: cached rows, no skeleton.
 expect(screen.getByRole('button',{name:'Ada'})).toBeInTheDocument();
 expect(screen.getByRole('combobox',{name:'Team'})).toHaveValue('team');
 expect(container.querySelectorAll('.team-row-skeleton')).toHaveLength(0);
 expect(screen.getByRole('status',{name:'Refreshing'})).toBeInTheDocument();
});

it('keeps people visible through a failed poll and recovers with Retry',async()=>{
 render(<TeamHub onOpenChat={vi.fn()}/>);await screen.findByRole('button',{name:'Ada'});
 let fail=true;invoke.mockImplementation(async(_name,{body})=>{if(fail&&body?.action==='detail')throw 'network down';return respond(body);});
 const banner=await screen.findByRole('alert',{},{timeout:4500});
 expect(banner).toHaveTextContent('network down');
 expect(screen.getByRole('button',{name:'Ada'})).toBeInTheDocument();
 fail=false;fireEvent.click(within(banner).getByRole('button',{name:'Retry'}));
 await vi.waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
 expect(screen.getByRole('button',{name:'Ada'})).toBeInTheDocument();
},10000);

it('shows a clear error with Retry when the first load fails',async()=>{
 let fail=true;invoke.mockImplementation(async(_name,{body})=>{if(fail&&!body)throw 'Server unavailable';return respond(body);});
 render(<TeamHub onOpenChat={vi.fn()}/>);
 const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent("Couldn't load teams. Server unavailable");
 fail=false;fireEvent.click(within(alert).getByRole('button',{name:'Retry'}));
 expect(await screen.findByRole('button',{name:'Ada'})).toBeInTheDocument();
});

it('asks to sign in instead of showing an empty panel when signed out',async()=>{
 invoke.mockImplementation(async()=>{throw 'Not signed in';});
 render(<TeamHub/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('Sign in to see your teams');
 expect(screen.getByRole('button',{name:'Sign in'})).toBeInTheDocument();
});

it('swaps straight to skeletons on account change and never shows the old account',async()=>{
 const open=vi.fn();const {container}=render(<TeamHub onOpenChat={open}/>);await screen.findByRole('button',{name:'Ada'});
 const list=deferred<unknown>();invoke.mockImplementation((_name,{body})=>!body?list.promise:Promise.resolve(body.action==='detail'?{members:[{id:'me2',name:'New Me',role:'owner'},{id:'bo',name:'Bo',email:'bo@x.io',role:'member'}],invitations:[]}:{}));
 act(()=>{window.dispatchEvent(new Event('canopy:account-changed'));});
 expect(screen.queryByRole('button',{name:'Ada'})).toBeNull();
 expect(screen.queryByRole('alert')).toBeNull();
 expect(container.querySelectorAll('.team-row-skeleton').length).toBeGreaterThan(0);
 await act(async()=>list.resolve({selfId:'me2',teams:[{id:'t2',name:'Design',role:'owner'}],invitations:[]}));
 expect(await screen.findByRole('button',{name:/Bo/})).toBeInTheDocument();
 expect(screen.getByText('(you)')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:/Bo/}));expect(open).toHaveBeenCalledWith({teamId:'t2',userId:'me2',peer:'bo',name:'Bo',email:'bo@x.io'});
});

it('switching teams shows cached people instantly and skeletons only for an unseen team',async()=>{
 invoke.mockImplementation(async(_name,{body})=>!body?{...directory,teams:[...directory.teams,{id:'ops',name:'Ops',role:'member'}]}:respond(body));
 const {container}=render(<TeamHub onOpenChat={vi.fn()}/>);await screen.findByRole('button',{name:'Ada'});
 const opsDetail=deferred<unknown>();invoke.mockImplementation((_name,{body})=>body?.teamId==='ops'?opsDetail.promise:Promise.resolve(respond(body)));
 fireEvent.change(screen.getByRole('combobox',{name:'Team'}),{target:{value:'ops'}});
 expect(screen.queryByRole('button',{name:'Ada'})).toBeNull();
 expect(screen.getByRole('button',{name:/Ops.*Everyone/})).toBeInTheDocument();
 expect(container.querySelectorAll('.team-row-skeleton').length).toBeGreaterThan(0);
 fireEvent.change(screen.getByRole('combobox',{name:'Team'}),{target:{value:'team'}});
 expect(screen.getByRole('button',{name:'Ada'})).toBeInTheDocument();
});

it('labels people by name with email secondary, initials avatars and a stable tone',()=>{
 expect(displayName({id:'1',name:'Ada Lovelace',email:'ada@x.io'})).toBe('Ada Lovelace');
 expect(secondaryEmail({id:'1',name:'Ada Lovelace',email:'ada@x.io'})).toBe('ada@x.io');
 expect(displayName({id:'1',name:'',email:'ada@x.io'})).toBe('ada@x.io');
 expect(secondaryEmail({id:'1',name:'ada@x.io',email:'ada@x.io'})).toBe('');
 expect(initials({id:'1',name:'Ada Lovelace'})).toBe('AL');
 expect(initials({id:'1',email:'grace.hopper@navy.mil'})).toBe('GH');
 expect(initials({id:'1',email:'sam@x.io'})).toBe('S');
 expect(initials({id:'1'})).toBe('?');
 expect(avatarTone({id:'abc'})).toBe(avatarTone({id:'abc'}));
 expect(AVATAR_TONES).toContain(avatarTone({id:'abc'}));
});
