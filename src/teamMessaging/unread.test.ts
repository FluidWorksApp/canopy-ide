import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({options:[] as any[],store:new Map<string,unknown>(),history:new Map<string,unknown[]>(),events:new Map<string,unknown[]>(),sendEvent:vi.fn(async(m:{id:string})=>({id:m.id,devices:1,queued:false}))}));
vi.mock('./client',()=>({PeerClient:class{constructor(options:unknown){mocks.options.push(options);}start=vi.fn(async()=>{});stop=vi.fn();send=vi.fn();discard=vi.fn(async()=>{});sendEvent=mocks.sendEvent;}}));
// An in-memory stand-in for the encrypted IndexedDB store, so a "restart"
// (dropping every session and opening again) reads back what was saved.
vi.mock('./history',()=>({
 loadChatHistory:vi.fn(async(account:string,team:string)=>structuredClone(mocks.history.get(`${account}:${team}`)??[])),
 saveChatMessage:vi.fn(async(account:string,team:string,message:{id:string})=>{const key=`${account}:${team}`,rows=mocks.history.get(key)??[];if(!rows.some((m:any)=>m.id===message.id))mocks.history.set(key,[...rows,structuredClone(message)]);}),
 forgetChatMessage:vi.fn(async()=>{}),
 loadChatReadState:vi.fn(async(account:string,team:string)=>structuredClone(mocks.store.get(`${account}:${team}`)??{unreadIds:[],receipts:{}})),
 saveChatReadState:vi.fn(async(account:string,team:string,state:unknown)=>{mocks.store.set(`${account}:${team}`,structuredClone(state));}),
 loadChatEvents:vi.fn(async(account:string,team:string)=>structuredClone(mocks.events.get(`${account}:${team}`)??[])),
 saveChatEvent:vi.fn(async(account:string,team:string,message:{id:string})=>{const key=`${account}:${team}`,rows=mocks.events.get(key)??[];if(!rows.some((m:any)=>m.id===message.id))mocks.events.set(key,[...rows,structuredClone(message)]);}),
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
afterEach(()=>{clearTeamSessions();mocks.store.clear();mocks.history.clear();mocks.events.clear();mocks.sendEvent.mockClear();me.id='me';});

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

const T1='11111111-1111-4111-8111-111111111111',T2='22222222-2222-4222-8222-222222222222';
const reactionEvent=(target:string,sender:string,recipient:string|null,emoji='👍',op:'add'|'remove'='add',created=++n)=>({id:crypto.randomUUID(),sender,recipient,text:`${emoji} reacted to "hi"`,created,v:2,event:{type:'reaction',target,emoji,op}});

it('folds a teammate\'s reaction onto its message without an unread count, a notification or a new message',async()=>{
 const {session,events}=await open('reactions');const heard=vi.fn();const stop=subscribeTeamMessages(heard);
 events.message({...msg(T1,'me',null),id:T1});
 events.message({...msg(T2,'ada','me'),id:T2});session.markRead('ada');heard.mockClear();
 const before=session.unread();
 events.message(reactionEvent(T1,'ada',null,'🎉'));events.message(reactionEvent(T2,'ada','me','👀'));
 expect(session.getSnapshot().messages.map(m=>m.id)).toEqual([T1,T2]);
 expect(session.unread()).toEqual(before);expect(session.getSnapshot().unreadIds).toEqual([]);expect(getTeamUnread()).toBe(0);
 expect(heard).not.toHaveBeenCalled();
 expect(Object.keys(session.getSnapshot().reactions)).toEqual([T1,T2]);
 stop();
});

it('toggles your own reaction, sends it to the conversation and restores it after a restart',async()=>{
 const first=await open('flip');
 first.events.message({...msg(T1,'ada','me'),id:T1});
 await first.session.react(T1,'👍');
 const sent=mocks.sendEvent.mock.calls[0][0] as any;
 // A direct message's reaction goes to the other person, as a v2 event message.
 expect(sent).toMatchObject({sender:'me',recipient:'ada',v:3,event:{type:'reaction',target:T1,emoji:'👍',op:'add'}});
 expect(sent.text).toContain('👍');
 expect(first.session.getSnapshot().reactions[T1]).toBeDefined();
 await first.session.react(T1,'👍');
 expect((mocks.sendEvent.mock.calls[1][0] as any).event.op).toBe('remove');
 await first.session.react(T1,'🎉');
 expect(first.session.getSnapshot().messages).toHaveLength(1);
 await expect(first.session.react(T1,'not emoji')).rejects.toThrow('single emoji');
 await expect(first.session.react(T2,'👍')).rejects.toThrow('not in the conversation');
 // The transport saves the target message before handing it over; then restart.
 await first.events.persist({...msg(T1,'ada','me'),id:T1});
 clearTeamSessions();
 const second=await open('flip');await flush();
 const r=second.session.getSnapshot().reactions[T1];
 expect(Object.values(r).filter(e=>e.on).map(e=>e.emoji)).toEqual(['🎉']);
});

it('applies a reaction that arrives before its message once the message lands',async()=>{
 const {session,events}=await open('early');
 events.message(reactionEvent(T1,'ada',null,'✅'));
 expect(session.getSnapshot().reactions).toEqual({});
 events.message({...msg(T1,'ada',null),id:T1});
 expect(Object.values(session.getSnapshot().reactions[T1]).map(e=>e.emoji)).toEqual(['✅']);
 // Unread counts the message, never the reaction.
 expect(session.unread().channel).toBe(1);
});

it('marks your reaction not delivered when no device in the conversation speaks v2, until it reaches someone',async()=>{
 const {session,events}=await open('undelivered');
 events.message({...msg(T1,'ada',null),id:T1});
 mocks.sendEvent.mockImplementationOnce(async(m:{id:string})=>({id:m.id,devices:0,queued:false}));
 await session.react(T1,'👍');
 expect(session.getSnapshot().undeliveredReactions).toEqual({[T1]:['👍']});
 // Still shown as yours: only its delivery is in question.
 expect(Object.values(session.getSnapshot().reactions[T1]).filter(e=>e.on).map(e=>e.emoji)).toEqual(['👍']);
 mocks.sendEvent.mockImplementationOnce(async(m:{id:string})=>({id:m.id,devices:0,queued:false}));
 await session.react(T1,'🎉');
 expect(session.getSnapshot().undeliveredReactions).toEqual({[T1]:['👍','🎉']});
 // Removing it clears the warning, and a delivered one never shows it.
 await session.react(T1,'👍');
 expect(session.getSnapshot().undeliveredReactions).toEqual({[T1]:['🎉']});
 await session.react(T1,'✅');
 expect(session.getSnapshot().undeliveredReactions).toEqual({[T1]:['🎉']});
});
