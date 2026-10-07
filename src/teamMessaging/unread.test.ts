import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({options:[] as any[],store:new Map<string,unknown>(),history:new Map<string,unknown[]>()}));
vi.mock('./client',()=>({PeerClient:class{constructor(options:unknown){mocks.options.push(options);}start=vi.fn(async()=>{});stop=vi.fn();send=vi.fn();discard=vi.fn(async()=>{});}}));
// An in-memory stand-in for the encrypted IndexedDB store, so a "restart"
// (dropping every session and opening again) reads back what was saved.
vi.mock('./history',()=>({
 loadChatHistory:vi.fn(async(account:string,team:string)=>structuredClone(mocks.history.get(`${account}:${team}`)??[])),
 saveChatMessage:vi.fn(async(account:string,team:string,message:{id:string})=>{const key=`${account}:${team}`,rows=mocks.history.get(key)??[];if(!rows.some((m:any)=>m.id===message.id))mocks.history.set(key,[...rows,structuredClone(message)]);}),
 forgetChatMessage:vi.fn(async()=>{}),
 loadChatReadState:vi.fn(async(account:string,team:string)=>structuredClone(mocks.store.get(`${account}:${team}`)??{unreadIds:[],receipts:{}})),
 saveChatReadState:vi.fn(async(account:string,team:string,state:unknown)=>{mocks.store.set(`${account}:${team}`,structuredClone(state));}),
}));
const me=vi.hoisted(()=>({id:'me'}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({user:{id:me.id}}))}));
import {teamSession,clearTeamSessions,getTeamUnread,getUnreadSummary,subscribeTeamMessages} from './session';
import {badgeLabel,countUnread,conversationKey,CHANNEL} from './unread';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
let n=0;
async function open(team:string,user='me'){
 me.id=user;const session=teamSession(team,user);const release=session.retain();await flush();
 return {session,release,events:mocks.options.at(-1)};
}
const msg=(id:string,sender:string,recipient:string|null,text='hi')=>({id,sender,recipient,text,created:++n});
afterEach(()=>{clearTeamSessions();mocks.store.clear();mocks.history.clear();me.id='me';});

it('counts incoming channel messages and DMs per conversation',async()=>{
 const {session,events}=await open('core');
 events.message(msg('c1','ada',null));events.message(msg('c2','sam',null));
 events.message(msg('d1','ada','me'));events.message(msg('d2','ada','me'));events.message(msg('d3','sam','me'));
 expect(session.unread()).toEqual({channel:2,peers:{ada:2,sam:1},total:5});
 expect(getUnreadSummary()).toEqual({'me:core':{channel:2,peers:{ada:2,sam:1},total:5}});
});

it('never counts your own messages, echoes from your other devices, or repeats',async()=>{
 const {session,events}=await open('own');
 await session.send('from this device',null);
 events.message(msg('echo','me',null,'sent from my laptop'));
 events.message(msg('echo-dm','me','ada','to Ada from my laptop'));
 events.message(msg('in','ada','me'));events.message(msg('in','ada','me'));
 expect(session.unread()).toEqual({channel:0,peers:{ada:1},total:1});
 // Even an unread list that names an own message cannot make it count.
 expect(countUnread([msg('x','me',null)],['x'],'me').total).toBe(0);
});

it('clears only the conversation that was read',async()=>{
 const {session,events}=await open('read');
 events.message(msg('c','ada',null));events.message(msg('d','ada','me'));events.message(msg('e','sam','me'));
 session.markRead('ada');
 expect(session.unread()).toEqual({channel:1,peers:{sam:1},total:2});
 session.markRead(null);session.markRead('sam');
 expect(session.unread().total).toBe(0);expect(getUnreadSummary()).toEqual({});
});

it('keeps unread counts across a restart',async()=>{
 const first=await open('restart');
 // The transport saves each message (encrypted) before handing it over.
 for(const m of [msg('a','ada','me'),msg('b','ada',null)]){await first.events.persist(m);first.events.message(m);}
 first.session.markRead(null);await flush();
 clearTeamSessions();expect(getTeamUnread()).toBe(0);
 const second=await open('restart');
 expect(second.session.unread()).toEqual({channel:0,peers:{ada:1},total:1});
 expect(getTeamUnread()).toBe(1);
});

it('sums the rail count across teams, tracked separately per account',async()=>{
 const core=await open('core-sum');core.events.message(msg('1','ada',null));core.events.message(msg('2','ada','me'));
 const ops=await open('ops-sum');ops.events.message(msg('3','sam','me'));
 expect(getTeamUnread()).toBe(3);
 const other=await open('core-sum','someone-else');other.events.message(msg('4','ada','someone-else'));
 expect(getUnreadSummary()['someone-else:core-sum']).toEqual({channel:0,peers:{ada:1},total:1});
 expect(getUnreadSummary()['me:core-sum'].total).toBe(2);
 expect(getTeamUnread()).toBe(4);
});

it('announces only fresh incoming messages, with the sender name',async()=>{
 const {events}=await open('events');const heard=vi.fn();const stop=subscribeTeamMessages(heard);
 events.members([{id:'ada',name:'Ada'}]);
 events.message(msg('in','ada','me','hello'));events.message(msg('in','ada','me','hello'));events.message(msg('own','me',null));
 expect(heard).toHaveBeenCalledTimes(1);
 expect(heard.mock.calls[0][0]).toMatchObject({team:'events',user:'me',senderName:'Ada',message:{id:'in'}});
 stop();
});

it('labels counts with a 9+ cap and keys conversations from your side',()=>{
 expect([0,1,9,10,250].map(badgeLabel)).toEqual(['0','1','9','9+','9+']);
 expect(conversationKey({sender:'ada',recipient:null},'me')).toBe(CHANNEL);
 expect(conversationKey({sender:'ada',recipient:'me'},'me')).toBe('ada');
 expect(conversationKey({sender:'me',recipient:'ada'},'me')).toBe('ada');
});
