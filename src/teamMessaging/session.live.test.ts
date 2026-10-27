import {afterEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({options:[] as any[],sendToCapable:vi.fn(async(_min:number,m:{id:string})=>({id:m.id,devices:0,queued:false})),saveChatEvent:vi.fn(async()=>{}),saveChatMessage:vi.fn(async()=>{})}));
vi.mock('./client',()=>({PeerClient:class{constructor(options:unknown){mocks.options.push(options);}start=vi.fn(async()=>{});stop=vi.fn();sendToCapable=mocks.sendToCapable;}}));
vi.mock('./history',()=>({
 loadChatHistory:vi.fn(async()=>[]),saveChatMessage:mocks.saveChatMessage,forgetChatMessage:vi.fn(async()=>{}),
 loadChatReadState:vi.fn(async()=>({unreadIds:[],receipts:{}})),saveChatReadState:vi.fn(async()=>{}),loadChatEvents:vi.fn(async()=>[]),saveChatEvent:mocks.saveChatEvent,
 forgetChatEvent:vi.fn(async()=>{}),saveChatRecord:vi.fn(async()=>{}),loadChatRecords:vi.fn(async()=>({})),forgetChatRecords:vi.fn(async()=>{}),
}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>({user:{id:'me'}}))}));
vi.mock('../settings',()=>({getSettings:()=>({})}));
import {teamSession,clearTeamSessions,subscribeLayerEvents,subscribeLiveEvents,subscribeTeamMessages,type TeamLayerEvent,type TeamLiveEvent} from './session';
import {LAYER_VERSION} from './layerEvents';
import {CHAT_VERSION} from './chatEvents';
import {LIVE_VERSION} from './liveEvents';
import type {ChatMessage} from './client';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const room='0f8fad5b-d9cb-469f-a165-70867728950e';
afterEach(()=>{clearTeamSessions();mocks.sendToCapable.mockClear();mocks.saveChatEvent.mockClear();mocks.saveChatMessage.mockClear();});

describe('live session traffic in a team session',()=>{
 it('goes to live listeners only: never the transcript, unread, notifications or storage',async()=>{
  const session=teamSession('team-live','me');const release=session.retain();await flush();await flush();
  const events=mocks.options.at(-1);events.members([{id:'me',name:'Me'},{id:'ana',name:'Ana'}]);
  const live:TeamLiveEvent[]=[],messages:unknown[]=[];
  const stopLive=subscribeLiveEvents(e=>live.push(e)),stopMessages=subscribeTeamMessages(e=>messages.push(e));
  const m:ChatMessage={id:'7c9e6679-7425-40de-944b-e07fc1f90ae7',sender:'ana',recipient:'me',text:'Wants to join…',created:Date.now(),v:CHAT_VERSION,event:{type:'live',target:room,op:'join'}};
  await events.persist(m);events.message(m);
  expect(live).toEqual([{team:'team-live',user:'me',sender:'ana',senderName:'Ana',event:{type:'live',target:room,op:'join'}}]);
  expect(session.getSnapshot().messages).toEqual([]);expect(session.getSnapshot().unreadIds).toEqual([]);expect(messages).toEqual([]);
  expect(mocks.saveChatEvent).not.toHaveBeenCalled();expect(mocks.saveChatMessage).not.toHaveBeenCalled();
  stopLive();stopMessages();release();
 });
 it('sends to v4 devices, and a first join to every device of the owner when none is known yet',async()=>{
  const session=teamSession('team-live2','me');const release=session.retain();await flush();await flush();
  expect(await session.sendLive('ana',room,{op:'join'},true)).toBe(0);
  expect(mocks.sendToCapable.mock.calls.map(c=>c[0])).toEqual([LIVE_VERSION,1]);
  const first=mocks.sendToCapable.mock.calls[0][1] as unknown as ChatMessage;
  expect(first).toMatchObject({sender:'me',recipient:'ana',v:CHAT_VERSION,event:{type:'live',target:room,op:'join'}});
  expect(first.text).toMatch(/join your live agent session/);
  mocks.sendToCapable.mockClear();
  await session.sendLive('ana',room,{op:'leave'});
  expect(mocks.sendToCapable.mock.calls.map(c=>c[0])).toEqual([LIVE_VERSION]);
  release();
 });
 it('routes layer ownership events to their listeners, saying whether the sender is a team member, and sends them team-wide',async()=>{
  const session=teamSession('team-layer','me');const release=session.retain();await flush();await flush();
  const events=mocks.options.at(-1);events.members([{id:'me',name:'Me'},{id:'sam',name:'Sam'}]);
  const got:TeamLayerEvent[]=[],messages:unknown[]=[];
  const stop=subscribeLayerEvents(e=>got.push(e)),stopMessages=subscribeTeamMessages(e=>messages.push(e));
  const layer={type:'layer',target:room,op:'claim',layer:'data',repo:{host:'github.com',slug:'acme/shop'},owner:'Sam',at:1} as const;
  const m:ChatMessage={id:'7c9e6679-7425-40de-944b-e07fc1f90ae8',sender:'sam',recipient:null,text:'Sam now owns Data',created:Date.now(),v:CHAT_VERSION,event:layer};
  await events.persist(m);events.message(m);
  events.message({...m,id:'7c9e6679-7425-40de-944b-e07fc1f90ae9',sender:'mallory'});
  expect(got.map(e=>[e.sender,e.member,e.senderName])).toEqual([['sam',true,'Sam'],['mallory',false,undefined]]);
  expect(got[0].event).toEqual(layer);
  expect(session.getSnapshot().messages).toEqual([]);expect(messages).toEqual([]);expect(mocks.saveChatMessage).not.toHaveBeenCalled();
  await session.sendLayer({target:room,op:'release',layer:'data',repo:{host:'github.com',slug:'acme/shop'},owner:'Me',at:2});
  expect(mocks.sendToCapable.mock.calls.at(-1)![0]).toBe(LAYER_VERSION);
  expect(mocks.sendToCapable.mock.calls.at(-1)![1]).toMatchObject({recipient:null,event:{type:'layer',op:'release'}});
  stop();stopMessages();release();
 });
});
