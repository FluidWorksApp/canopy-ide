import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({options:[] as any[],settings:{teamReadReceipts:true} as Record<string,unknown>,
 sendEvent:vi.fn(async(m:{id:string})=>({id:m.id,devices:1,queued:false})),sendReadReceipt:vi.fn(async()=>1),backfill:vi.fn(async()=>true),retryNow:vi.fn(async()=>true),forgetReceivedFiles:vi.fn(async()=>{}),discard:vi.fn(async()=>{}),
 records:new Map<string,Record<string,unknown>>(),forgotten:[] as string[],forgottenEvents:[] as string[]}));
vi.mock('./client',()=>({PeerClient:class{constructor(options:unknown){mocks.options.push(options);}start=vi.fn(async()=>{});stop=vi.fn();send=vi.fn();discard=mocks.discard;sendEvent=mocks.sendEvent;sendReadReceipt=mocks.sendReadReceipt;backfill=mocks.backfill;retryNow=mocks.retryNow;forgetReceivedFiles=mocks.forgetReceivedFiles;usersBelow=()=>['sam'];}}));
vi.mock('./history',()=>({
 loadChatHistory:vi.fn(async()=>[]),saveChatMessage:vi.fn(async()=>{}),forgetChatMessage:vi.fn(async(_a:string,_t:string,id:string)=>{mocks.forgotten.push(id);}),
 loadChatReadState:vi.fn(async()=>({unreadIds:[],receipts:{}})),saveChatReadState:vi.fn(async()=>{}),loadChatEvents:vi.fn(async()=>[]),saveChatEvent:vi.fn(async()=>{}),
 forgetChatEvent:vi.fn(async(_a:string,_t:string,id:string)=>{mocks.forgottenEvents.push(id);}),
 saveChatRecord:vi.fn(async(_a:string,_t:string,kind:string,key:string,value:unknown)=>{const m=mocks.records.get(kind)??{};m[key]=structuredClone(value);mocks.records.set(kind,m);}),
 loadChatRecords:vi.fn(async(_a:string,_t:string,kind:string)=>structuredClone(mocks.records.get(kind)??{})),
 forgetChatRecords:vi.fn(async(_a:string,_t:string,kind:string,keys:string[])=>{const m=mocks.records.get(kind)??{};for(const k of keys)delete m[k];}),
}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({user:{id:'me'}}))}));
vi.mock('../settings',()=>({getSettings:()=>mocks.settings}));
import {teamSession,clearTeamSessions,subscribeTeamMessages,READ_RECEIPT_DELAY_MS,type TeamMessageEvent} from './session';
import {CHAT_VERSION,DELETE_TEXT,editText} from './chatEvents';
import type {ChatMessage,Device} from './client';
import {countUnread,threadRoot,threadSummaries} from './unread';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
let n=0,teamNo=0;const uuid=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
async function open(){
 const session=teamSession(`team-${++teamNo}`,'me');const release=session.retain();await flush();await flush();
 const events=mocks.options.at(-1);events.members([{id:'me',name:'Me'},{id:'ada',name:'Ada'},{id:'sam',name:'Sam'}]);
 return {session,events,release};
}
const message=(over:Partial<ChatMessage>={}):ChatMessage=>({id:uuid(),sender:'ada',recipient:null,text:'hi',created:++n*10,v:CHAT_VERSION,...over});
const edit=(target:ChatMessage,text:string,over:Partial<ChatMessage>={}):ChatMessage=>message({sender:target.sender,recipient:target.recipient,text:editText(text),event:{type:'edit',target:target.id,text},...over});
const del=(target:ChatMessage,over:Partial<ChatMessage>={}):ChatMessage=>message({sender:target.sender,recipient:target.recipient,text:DELETE_TEXT,event:{type:'delete',target:target.id},...over});
const device=(user:string,id='dev-'+user):Device=>({id,user_id:user,public_keys:{} as Device['public_keys']});
beforeEach(()=>{mocks.settings={teamReadReceipts:true};});
afterEach(()=>{clearTeamSessions();vi.useRealTimers();mocks.records.clear();mocks.forgotten.length=0;mocks.forgottenEvents.length=0;for(const fn of [mocks.sendEvent,mocks.sendReadReceipt,mocks.backfill,mocks.retryNow,mocks.forgetReceivedFiles,mocks.discard])fn.mockClear();});

describe('read receipts',()=>{
 it('accepts a watermark only for an own message, from someone in its conversation',async()=>{
  const {session,events}=await open();
  const mine=message({sender:'me',recipient:null}),dm=message({sender:'me',recipient:'ada'}),theirs=message({sender:'ada'});
  for(const m of [mine,dm,theirs])events.message(m);
  events.read(theirs.id,'sam');          // not an own message
  events.read(mine.id,'mallory');        // not a member of the team
  events.read(dm.id,'sam');              // not in that direct conversation
  events.read(uuid(),'ada');             // not on this device
  expect(session.getSnapshot().reads).toEqual({});
  events.read(mine.id,'sam');events.read(dm.id,'ada');
  expect(session.readers(mine.id)).toEqual(['sam']);expect(session.readers(dm.id)).toEqual(['ada']);
  // A watermark covers earlier messages and never moves back.
  const later=message({sender:'me',recipient:null});events.message(later);
  expect(session.readers(later.id)).toEqual([]);
  events.read(later.id,'sam');expect(session.readers(mine.id)).toEqual(['sam']);
  events.read(mine.id,'sam');expect(session.readers(later.id)).toEqual(['sam']);
 });
 it('sends one receipt per author for the newest message read, after reading settles',async()=>{
  const {session,events}=await open();
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const a1=message({sender:'ada'}),a2=message({sender:'ada'}),s1=message({sender:'sam'}),dm=message({sender:'ada',recipient:'me'});
  for(const m of [a1,a2,s1,dm])events.message(m);
  session.markRead(null);
  expect(mocks.sendReadReceipt).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(READ_RECEIPT_DELAY_MS);
  expect(mocks.sendReadReceipt.mock.calls.map(c=>[...c].slice(0,2)).sort()).toEqual([[a2.id,'ada'],[s1.id,'sam']].sort());
  // Re-sent to a device of that author when it comes online.
  mocks.sendReadReceipt.mockClear();
  events.online(device('ada'));
  expect(mocks.sendReadReceipt.mock.calls).toEqual([[a2.id,'ada','dev-ada']]);
 });
 it('is reciprocal: off neither sends nor shows them',async()=>{
  mocks.settings={teamReadReceipts:false};
  const {session,events}=await open();
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const theirs=message({sender:'ada'}),mine=message({sender:'me'});events.message(theirs);events.message(mine);
  session.markRead(null);await vi.advanceTimersByTimeAsync(READ_RECEIPT_DELAY_MS*2);
  expect(mocks.sendReadReceipt).not.toHaveBeenCalled();
  events.read(mine.id,'ada');expect(session.readers(mine.id)).toEqual([]);expect(session.getSnapshot().reads).toEqual({});
 });
});

describe('edits and deletes',()=>{
 it('applies an edit by the author only, last write wins by (created, id), and an early edit waits for its message',async()=>{
  const {session,events}=await open();
  const target=message({sender:'ada'});
  const first=edit(target,'first',{created:500,id:'00000000-0000-4000-8000-00000000000a'});
  events.message(first);expect(session.getSnapshot().edits).toEqual({});
  events.message(target);expect(session.getSnapshot().edits[target.id]?.text).toBe('first');
  events.message(edit(target,'forged',{sender:'sam',created:900}));
  expect(session.getSnapshot().edits[target.id]?.text).toBe('first');
  // Same `created`: the larger id wins, whatever the arrival order.
  events.message(edit(target,'tie-high',{created:500,id:'00000000-0000-4000-8000-00000000000f'}));
  events.message(edit(target,'tie-low',{created:500,id:'00000000-0000-4000-8000-000000000001'}));
  expect(session.getSnapshot().edits[target.id]?.text).toBe('tie-high');
  events.message(edit(target,'older',{created:100}));expect(session.getSnapshot().edits[target.id]?.text).toBe('tie-high');
  // Edits never join the transcript, unread or notifications.
  expect(session.getSnapshot().messages.map(m=>m.id)).toEqual([target.id]);
 });
 it('deletes by the author only, forgets the message, and keeps it deleted when a copy arrives late',async()=>{
  const {session,events}=await open();
  const heard:TeamMessageEvent[]=[];const stop=subscribeTeamMessages(e=>heard.push(e));
  const target=message({sender:'ada',attachments:[{id:uuid(),name:'a.txt',size:1,type:'text/plain',sha256:'0'.repeat(64)}]});
  events.message(target);events.message(edit(target,'edited'));
  const reply=message({sender:'sam',thread:{root:target.id}});events.message(reply);
  events.message(del(target,{sender:'sam'}));
  expect(session.getSnapshot().deleted[target.id]).toBeUndefined();
  events.message(del(target));
  expect(session.getSnapshot().deleted[target.id]).toBeDefined();
  expect(session.getSnapshot().messages.find(m=>m.id===target.id)?.text).toBe('');
  expect(session.getSnapshot().edits[target.id]).toBeUndefined();
  expect(session.getSnapshot().unreadIds).not.toContain(target.id);
  expect(mocks.forgotten).toContain(target.id);expect(mocks.forgottenEvents.length).toBe(1);
  expect(mocks.forgetReceivedFiles).toHaveBeenCalledWith(target);
  expect(Object.keys(mocks.records.get('tombstone')??{})).toEqual([target.id]);
  // The thread reply stays.
  expect(session.getSnapshot().messages.map(m=>m.id)).toContain(reply.id);
  heard.length=0;stop();
  // After a restart, neither the original nor a backfill of it comes back.
  clearTeamSessions();
  const second=await open();
  second.events.message({...target});second.events.message({...target},{backfill:true});
  expect(second.session.getSnapshot().messages.map(m=>m.id)).toEqual([]);
  expect(second.session.getSnapshot().deleted[target.id]).toBeDefined();
 });
 it('edits and deletes own messages through the event path',async()=>{
  const {session,events}=await open();
  const mine=message({sender:'me',recipient:'ada'});events.message(mine);
  await session.edit(mine.id,'Fixed @Ada');
  expect(mocks.sendEvent.mock.calls[0][0]).toMatchObject({sender:'me',recipient:'ada',text:editText('Fixed @Ada'),event:{type:'edit',target:mine.id,text:'Fixed @Ada',mentions:['ada']}});
  expect(session.getSnapshot().edits[mine.id]?.text).toBe('Fixed @Ada');
  const theirs=message({sender:'ada'});events.message(theirs);
  await expect(session.edit(theirs.id,'nope')).rejects.toThrow('own messages');
  await expect(session.remove(theirs.id)).rejects.toThrow('own messages');
  expect(session.olderRecipients('ada')).toEqual(['sam']);
  await session.remove(mine.id);
  expect(mocks.sendEvent.mock.calls[1][0]).toMatchObject({text:DELETE_TEXT,event:{type:'delete',target:mine.id}});
  expect(mocks.discard).toHaveBeenCalledWith(mine.id);
  await expect(session.edit(mine.id,'again')).rejects.toThrow('deleted');
  await session.retryNow(mine.id);expect(mocks.retryNow).toHaveBeenCalledWith(mine.id);
 });
});

describe('backfill',()=>{
 it('inserts late messages in order, dedupes, and announces them once per sender',async()=>{
  const {session,events}=await open();
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const heard:TeamMessageEvent[]=[];const stop=subscribeTeamMessages(e=>heard.push(e));
  const now=message({sender:'sam',created:10_000});events.message(now);heard.length=0;
  const b1=message({sender:'ada',created:1000}),b2=message({sender:'ada',created:2000});
  events.message(b2,{backfill:true});events.message(b1,{backfill:true});events.message(b1,{backfill:true});
  expect(session.getSnapshot().messages.map(m=>m.id)).toEqual([b1.id,b2.id,now.id]);
  expect(heard).toEqual([]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(heard.map(e=>[e.message.id,e.backfill])).toEqual([[b2.id,2]]);
  stop();
 });
 it('records expired deliveries and backfills them when the device comes online, until a receipt settles them',async()=>{
  const {session,events}=await open();
  const mine=message({sender:'me',recipient:'ada',created:Date.now()});events.message(mine);
  events.undelivered(mine.id,device('ada'));
  expect(session.getSnapshot().awaiting[mine.id]).toMatchObject({users:['ada']});
  events.online(device('ada'));await flush();await flush();
  expect(mocks.backfill).toHaveBeenCalledWith('dev-ada',mine);
  events.receipt(mine.id,'ada');
  expect(session.getSnapshot().awaiting).toEqual({});
  expect(mocks.records.get('ledger')).toEqual({});
 });
});

describe('threads and unread',()=>{
 it('flattens replies to the root, ignores a root in another conversation, and keeps a missing root',()=>{
  const root=message({sender:'ada'}),reply=message({sender:'sam',thread:{root:root.id}}),nested=message({sender:'me',thread:{root:reply.id}});
  const dm=message({sender:'ada',recipient:'me'}),cross=message({sender:'sam',thread:{root:dm.id}}),missing=message({sender:'sam',thread:{root:uuid()}});
  const all=[root,reply,nested,dm,cross,missing],find=(id:string)=>all.find(m=>m.id===id);
  expect([reply,nested,cross,missing].map(m=>threadRoot(m,find))).toEqual([root.id,root.id,undefined,(missing.thread as {root:string}).root]);
  expect(threadSummaries(all,[reply.id],'me')[root.id]).toMatchObject({replies:2,unread:1});
 });
 it('counts a reply only in a followed thread, and counts personal mentions apart',()=>{
  const theirRoot=message({sender:'ada'}),myRoot=message({sender:'me'});
  const r1=message({sender:'sam',thread:{root:theirRoot.id}}),r2=message({sender:'sam',thread:{root:myRoot.id}});
  const mention=message({sender:'ada',mentions:['me']}),everyone=message({sender:'ada',mentionsAll:true});
  const all=[theirRoot,myRoot,r1,r2,mention,everyone];
  expect(countUnread(all,all.map(m=>m.id),'me')).toEqual({channel:4,peers:{},total:4,mentions:{channel:1,peers:{}}});
 });
 it('marks thread replies read apart from the conversation, and never counts events',async()=>{
  const {session,events}=await open();
  const root=message({sender:'me'});events.message(root);
  const reply=message({sender:'ada',thread:{root:root.id}}),plain=message({sender:'ada'});events.message(reply);events.message(plain);
  events.message(edit(plain,'changed'));
  expect(session.unread().channel).toBe(2);
  session.markRead(null);expect(session.getSnapshot().unreadIds).toEqual([reply.id]);
  session.markThreadRead(root.id);expect(session.getSnapshot().unreadIds).toEqual([]);
 });
 it('sends a reply into the root\'s thread, flattening a reply to a reply',async()=>{
  const {session,events}=await open();
  const root=message({sender:'ada'}),reply=message({sender:'sam',thread:{root:root.id}});events.message(root);events.message(reply);
  void session.send('me too',null,[],{thread:reply.id,mentions:['ada','stranger','me']}).catch(()=>{});
  const sent=session.getSnapshot().messages.at(-1)!;
  expect(sent).toMatchObject({text:'me too',thread:{root:root.id},mentions:['ada']});
  const dm=message({sender:'ada',recipient:'me'});events.message(dm);
  await expect(session.send('x',null,[],{thread:dm.id})).rejects.toThrow('Reply to a message in this conversation');
 });
});
