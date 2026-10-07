import {render,screen,fireEvent,within} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({summary:{} as Record<string,{channel:number;peers:Record<string,number>;total:number}>}));
vi.mock('../teamMessaging/session',()=>({subscribeTeamUnread:()=>()=>{},getUnreadSummary:()=>state.summary}));
const invoke=vi.hoisted(()=>vi.fn());vi.mock('@tauri-apps/api/core',()=>({invoke}));vi.mock('./AccountSettings',()=>({AccountSettings:()=>null}));
import {TeamHub} from './TeamHub';
type Body={action?:string;teamId?:string}|null;
const directory={selfId:'me',teams:[{id:'core',name:'Core',role:'owner'},{id:'ops',name:'Ops',role:'member'}],invitations:[]};
const detail={members:[{id:'me',name:'Sam',role:'owner'},{id:'ada',name:'Ada',role:'member'},{id:'vj',name:'Vijay',role:'member'}],invitations:[]};
beforeEach(()=>{window.dispatchEvent(new Event('canopy:account-changed'));invoke.mockReset();invoke.mockImplementation(async(_name,{body}:{body:Body})=>!body?directory:body.action==='detail'?detail:{});});

it('shows unread counts on the channel and each person, bold, never on yourself',async()=>{
 state.summary={'me:core':{channel:12,peers:{ada:2},total:14}};
 const open=vi.fn();render(<TeamHub onOpenChat={open}/>);
 const ada=await screen.findByRole('button',{name:/Ada.*2 unread from Ada/});
 expect(ada).toHaveClass('is-unread');
 const channel=screen.getByRole('button',{name:/Core.*Everyone/});
 expect(within(channel).getByLabelText('12 unread in the channel')).toHaveTextContent('9+');
 expect(channel).toHaveClass('is-unread');
 expect(screen.getByRole('button',{name:'Vijay'})).not.toHaveClass('is-unread');
 expect(screen.getByText('(you)').closest('.team-row')?.querySelector('.team-unread')).toBeNull();
 fireEvent.click(ada);
 expect(open).toHaveBeenCalledWith(expect.objectContaining({teamId:'core',peer:'ada'}));
});

it('marks the team picker when another team has unread messages',async()=>{
 state.summary={'me:ops':{channel:1,peers:{},total:1}};
 render(<TeamHub onOpenChat={vi.fn()}/>);
 expect(await screen.findByRole('img',{name:'1 unread in other teams'})).toBeInTheDocument();
 expect(screen.getByRole('option',{name:'Ops · 1 unread'})).toBeInTheDocument();
 fireEvent.change(screen.getByRole('combobox',{name:'Team'}),{target:{value:'ops'}});
 expect(screen.queryByRole('img',{name:/unread in other teams/})).toBeNull();
});

it('ignores counts that belong to another account',async()=>{
 state.summary={'previous-account:core':{channel:3,peers:{ada:1},total:4}};
 render(<TeamHub onOpenChat={vi.fn()}/>);
 await screen.findByRole('button',{name:'Ada'});
 expect(document.querySelector('.team-unread')).toBeNull();
});
