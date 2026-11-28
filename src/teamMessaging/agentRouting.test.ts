import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {ChatMessage} from './client';
import {AGENT_VERSION,eventVersion,parseAgentTag,parseEvent,parseExtensions} from './chatEvents';
import {AGENT_RUN_LIMIT,agentAddressee,agentBrief,agentDeliveries,agentDeliveryText,agentRunTooLong,conversationAgents,recordAgentDelivery,threadAgentTarget,withoutAgentFooter} from './agentRouting';
import {createAgentInbox,DELIVERY_GAP_MS,QUIET_READY_MS,readyFor} from './agentInbox';
import type {AgentLifeEntry} from '../agentLifeRegistry';
import {agentFooter} from './agentChat';

let n=0;
const id=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
const msg=(over:Partial<ChatMessage>={}):ChatMessage=>({id:id(),sender:'vijay',recipient:'me',text:'hi',created:++n*10,v:5,...over});

describe('agent tag on the wire',()=>{
 it('accepts from, to, or both, and nothing malformed',()=>{
  expect(parseAgentTag({from:'Yarrow 6'})).toEqual({from:'Yarrow 6'});
  expect(parseAgentTag({to:{name:'Niffler 4',owner:'me'}})).toEqual({to:{name:'Niffler 4',owner:'me'}});
  for(const bad of [{},{from:''},{from:' padded '},{from:'x'.repeat(61)},{from:'a\nb'},{to:{name:'N'}},{to:{name:'N',owner:'me',extra:1}},{from:'Y',other:1},'Y'])
   expect(parseAgentTag(bad)).toBeUndefined();
 });
 it('is read from a message and dropped when malformed, keeping the message',()=>{
  expect(parseExtensions(msg({agent:{from:'Yarrow 6'}})).agent).toEqual({from:'Yarrow 6'});
  expect(parseExtensions(msg({agent:{from:1}})).agent).toBeUndefined();
 });
 it('carries delivery status as a v5 event',()=>{
  const e=parseEvent({type:'agent-status',target:id(),agent:'Niffler 4',state:'queued'});
  expect(e).toMatchObject({type:'agent-status',state:'queued'});
  expect(eventVersion(e!)).toBe(AGENT_VERSION);
  expect(parseEvent({type:'agent-status',target:id(),agent:'Niffler 4',state:'running'})).toBeUndefined();
 });
});

describe('agent routing',()=>{
 it('finds the agent of mine a teammate wrote to, in a DM or the channel',()=>{
  expect(agentAddressee(msg({agent:{to:{name:'Niffler 4',owner:'me'}}}),'me')).toBe('Niffler 4');
  expect(agentAddressee(msg({recipient:null,agent:{to:{name:'Niffler 4',owner:'me'}}}),'me')).toBe('Niffler 4');
  // Someone else's agent, my own message, or a DM between two others: not mine to deliver.
  expect(agentAddressee(msg({recipient:null,agent:{to:{name:'Wren',owner:'ana'}}}),'me')).toBeNull();
  expect(agentAddressee(msg({sender:'me',recipient:'vijay',agent:{to:{name:'Niffler 4',owner:'me'}}}),'me')).toBeNull();
  expect(agentAddressee(msg({recipient:'ana',agent:{to:{name:'Niffler 4',owner:'me'}}}),'me')).toBeNull();
  expect(agentAddressee(msg(),'me')).toBeNull();
 });
 it('stops after a run of agent messages in one thread until a person writes',()=>{
  const root=msg({agent:{from:'Yarrow 6'}});
  const line=[root];
  for(let i=1;i<AGENT_RUN_LIMIT;i++)line.push(msg({sender:i%2?'me':'vijay',recipient:i%2?'vijay':'me',thread:{root:root.id},agent:{from:i%2?'Niffler 4':'Yarrow 6'}}));
  expect(agentRunTooLong(line.slice(0,-1),line.at(-2)!)).toBe(false);
  expect(agentRunTooLong(line,line.at(-1)!)).toBe(true);
  const person=msg({sender:'vijay',thread:{root:root.id}}),next=msg({sender:'vijay',thread:{root:root.id},agent:{from:'Yarrow 6'}});
  expect(agentRunTooLong([...line,person,next],next)).toBe(false);
 });
 it('shows an agent message without its footer',()=>{
  expect(withoutAgentFooter(`Done.\n\n${agentFooter('Yarrow 6')}`)).toBe('Done.');
  expect(withoutAgentFooter(`Done.\n\n${agentFooter(null)}`)).toBe('Done.');
  expect(withoutAgentFooter('— sent by a person, not from Canopy')).toBe('— sent by a person, not from Canopy');
 });
 it('replies in a thread to the teammate agent that wrote last, and lists their agents',()=>{
  const root=msg({agent:{from:'Yarrow 6'}});
  const mine=msg({sender:'me',recipient:'vijay',thread:{root:root.id},agent:{from:'Niffler 4'}});
  expect(threadAgentTarget([root,mine],root.id,'me')).toEqual({name:'Yarrow 6',owner:'vijay'});
  expect(threadAgentTarget([msg()],root.id,'me')).toBeNull();
  expect(conversationAgents([root,mine,msg({agent:{from:'Wren'}}),msg({agent:{from:'yarrow 6'}})],'me').map(a=>a.name)).toEqual(['yarrow 6','Wren']);
 });
 it('briefs the agent with who wrote, and the id to answer with',()=>{
  const b=agentBrief({sender:'Vijay',viaAgent:'Yarrow 6',where:'direct message with Vijay',text:`Ship it?\n\n${agentFooter('Yarrow 6')}`,messageId:'abc'});
  expect(b).toContain("Yarrow 6, Vijay's agent, wrote to you");
  expect(b).toContain('Ship it?');
  expect(b).not.toContain('sent by agent');
  expect(b).toContain('canopy_team_send({ replyTo: "abc", text })');
 });
});

describe('delivery status record',()=>{
 beforeEach(()=>localStorage.clear());
 it('keeps the most informative answer from several devices',()=>{
  const m=id();
  recordAgentDelivery(m,{agent:'Niffler 4',state:'queued',by:'me',at:1});
  recordAgentDelivery(m,{agent:'Niffler 4',state:'missing',by:'me',at:2});
  expect(agentDeliveries()[m].state).toBe('queued');
  recordAgentDelivery(m,{agent:'Niffler 4',state:'delivered',by:'me',at:3});
  expect(agentDeliveries()[m].state).toBe('delivered');
  expect(agentDeliveryText(agentDeliveries()[m],'Vijay')).toBe("Delivered to Vijay's Niffler 4");
  expect(agentDeliveryText({agent:'Niffler 4',state:'missing',by:'me',at:1},null)).toBe("Niffler 4 isn't running on this machine");
 });
});

describe('agent inbox',()=>{
 beforeEach(()=>localStorage.clear());
 const setup=(life:Record<number,AgentLifeEntry>,agents=[{ptyId:7,name:'Niffler 4'}])=>{
  let t=1_000_000;
  const deliver=vi.fn(async(_p:number,_t:string,_m:string)=>'ok'),report=vi.fn(async(_team:string,_user:string,_sender:string,_id:string,_agent:string,_state:string)=>1);
  const inbox=createAgentInbox({agents:async()=>agents,life:p=>life[p],deliver,report,now:()=>t});
  const item=(over:Partial<ChatMessage>={})=>{const message=msg({agent:{to:{name:'Niffler 4',owner:'me'}},...over});return {team:'core',user:'me',message,senderName:'Vijay',where:'direct message with Vijay',messages:[message]};};
  return {inbox,deliver,report,item,advance:(ms:number)=>{t+=ms;},life};
 };
 it('types into an idle agent at once and tells the sender',async()=>{
  const s=setup({7:{state:'idle',quietMs:0}});
  const it1=s.item();await s.inbox.receive(it1);
  expect(s.deliver).toHaveBeenCalledWith(7,expect.stringContaining(`replyTo: "${it1.message.id}"`),it1.message.id);
  expect(s.report).toHaveBeenCalledWith('core','me','vijay',it1.message.id,'Niffler 4','delivered');
 });
 it('holds a message for a working agent until its turn ends',async()=>{
  const s=setup({7:{state:'working',quietMs:0}});
  await s.inbox.receive(s.item());
  expect(s.deliver).not.toHaveBeenCalled();
  expect(s.report.mock.calls.at(-1)?.[5]).toBe('queued');
  await s.inbox.flush();expect(s.deliver).not.toHaveBeenCalled();
  s.life[7]={state:'idle',quietMs:0};
  await s.inbox.flush();
  expect(s.deliver).toHaveBeenCalledTimes(1);expect(s.report.mock.calls.at(-1)?.[5]).toBe('delivered');
 });
 it('gives an agent one message per turn',async()=>{
  const s=setup({7:{state:'idle',quietMs:0}});
  await s.inbox.receive(s.item());await s.inbox.receive(s.item());
  expect(s.deliver).toHaveBeenCalledTimes(1);expect(s.inbox.pending()).toBe(1);
  await s.inbox.flush();expect(s.deliver).toHaveBeenCalledTimes(1);
  s.advance(DELIVERY_GAP_MS);await s.inbox.flush();expect(s.deliver).toHaveBeenCalledTimes(2);
 });
 it('says when the agent is not running, or has gone while a message waited',async()=>{
  const s=setup({},[]);
  await s.inbox.receive(s.item());expect(s.report.mock.calls.at(-1)?.[5]).toBe('missing');
  const agents=[{ptyId:7,name:'Niffler 4'}],t=setup({7:{state:'working',quietMs:0}},agents);
  await t.inbox.receive(t.item());agents.length=0;await t.inbox.flush();
  expect(t.report.mock.calls.at(-1)?.[5]).toBe('missing');expect(t.inbox.pending()).toBe(0);
 });
 it('never delivers one message twice, or a message for someone else',async()=>{
  const s=setup({7:{state:'idle',quietMs:0}});
  const one=s.item();await s.inbox.receive(one);s.advance(DELIVERY_GAP_MS);await s.inbox.receive(one);
  await s.inbox.receive({...s.item(),message:msg()});
  expect(s.deliver).toHaveBeenCalledTimes(1);
 });
 it('counts a quiet hookless agent as idle, but never one waiting on its user',()=>{
  expect(readyFor({state:'unknown',quietMs:QUIET_READY_MS})).toBe(true);
  expect(readyFor({state:'unknown',quietMs:100})).toBe(false);
  expect(readyFor({state:'waiting',quietMs:60_000})).toBe(false);
  expect(readyFor(undefined)).toBe(false);
 });
});
