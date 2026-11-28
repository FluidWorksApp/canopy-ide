import {describe,expect,it,vi} from 'vitest';
import {agentFooter,createAgentChat,type ChatSession} from './agentChat';
import {handoffBrief,handoffLabel} from './chatHandoff';
import type {ChatMessage} from './client';
import type {MessageExtensions} from './messageSchema';

type Sent={text:string;peer:string|null;ext?:MessageExtensions};
function session(team:string,members:Record<string,string>,messages:ChatMessage[]=[]):ChatSession&{sent:Sent[]}{
 const sent:Sent[]=[];
 return {team,user:'me',sent,members:()=>({me:'Sam',...members}),messages:()=>messages,send:vi.fn(async(text:string,peer:string|null,ext?:MessageExtensions)=>{sent.push({text,peer,ext});return {id:'m1',delivery:{state:'sent'}};})};
}
const names:Record<string,string>={core:'Core',web:'Web'};
const people={core:[{id:'me',name:'Sam',email:'sam@example.com'},{id:'u1',name:'ana.lopez@example.com',email:'ana.lopez@example.com'},{id:'u2',name:'Vijay Kumar',email:'vijay@example.com'}]};
const chat=(sessions:ChatSession[])=>createAgentChat({sessions:()=>sessions,teamName:t=>names[t],people:async t=>people[t as 'core']??null});

describe('agent chat',()=>{
 it('sends a direct message by email, first name or id, marked as agent-written',async()=>{
  const core=session('core',{u1:'ana.lopez@example.com',u2:'Vijay Kumar'}),c=chat([core]);
  for(const to of ['vijay@example.com','vijay','u2','Vijay Kumar'])await c.send({to,text:'Review PR #12',agent:'Wren'});
  expect(core.sent.every(s=>s.peer==='u2'&&s.text===`Review PR #12\n\n${agentFooter('Wren')}`)).toBe(true);
 });
 it('posts to the channel',async()=>{
  const core=session('core',{}),c=chat([core]);
  const r=await c.send({to:'channel',text:'Deploy is green'});
  expect(core.sent[0].peer).toBeNull();expect(r.to).toBe('#Core');
 });
 it('picks the named team and refuses an unknown one',async()=>{
  const core=session('core',{}),web=session('web',{w1:'Ada'}),c=chat([core,web]);
  await c.send({to:'Ada',text:'hi',team:'web'});
  expect(web.sent).toHaveLength(1);
  await expect(c.send({to:'Ada',text:'hi',team:'ops'})).rejects.toThrow(/No team called "ops".*Core, Web/);
 });
 it('names the people when nobody matches, and refuses an ambiguous name',async()=>{
  const web=session('web',{a:'Ada Lovelace',b:'Ada Byron'}),c=createAgentChat({sessions:()=>[web],teamName:t=>names[t],people:async()=>null});
  await expect(c.send({to:'bob',text:'x'})).rejects.toThrow(/Nobody called "bob".*Ada Lovelace/);
  await expect(c.send({to:'ada',text:'x'})).rejects.toThrow(/matches 2 people/);
 });
 it('says to sign in when there is no team session',async()=>{
  await expect(chat([]).send({to:'vijay',text:'x'})).rejects.toThrow(/sign in/i);
  expect((await chat([]).people()).teams).toEqual([]);
 });
 it('lists people without the user themselves',async()=>{
  const {teams}=await chat([session('core',{})]).people();
  expect(teams[0].team).toBe('Core');
  expect(teams[0].people.map(p=>p.id)).toEqual(['u1','u2']);
 });
});

describe('agents talking to agents',()=>{
 const ROOT='00000000-0000-4000-8000-000000000001',REPLY='00000000-0000-4000-8000-000000000002';
 const fromYarrow:ChatMessage={id:ROOT,sender:'u2',recipient:'me',text:'Can you run the audit?',created:1,agent:{from:'Yarrow 6'}};
 it('marks every message with the agent that wrote it',async()=>{
  const core=session('core',{u2:'Vijay Kumar'}),c=chat([core]);
  await c.send({to:'vijay',text:'hi',agent:'Niffler 4'});
  expect(core.sent[0].ext).toEqual({agent:{from:'Niffler 4'}});
 });
 it('addresses one of the teammate\'s agents in their DM, never the channel',async()=>{
  const core=session('core',{u2:'Vijay Kumar'}),c=chat([core]);
  const r=await c.send({to:'vijay',text:'Run the audit',agent:'Niffler 4',toAgent:'Yarrow 6'});
  expect(core.sent[0]).toMatchObject({peer:'u2',ext:{agent:{from:'Niffler 4',to:{name:'Yarrow 6',owner:'u2'}}}});
  expect(r.to).toBe("Yarrow 6 (Vijay Kumar's agent)");
  await expect(c.send({to:'channel',text:'x',toAgent:'Yarrow 6'})).rejects.toThrow(/message that teammate directly/);
 });
 it('answers in the thread of the message it was given, back to the agent that wrote it',async()=>{
  const reply:ChatMessage={id:REPLY,sender:'me',recipient:'u2',text:'on it',created:2,thread:{root:ROOT}};
  const core=session('core',{u2:'Vijay Kumar'},[fromYarrow,reply]),c=chat([core]);
  const r=await c.send({text:'Audit passed',agent:'Niffler 4',replyTo:ROOT});
  expect(core.sent[0]).toMatchObject({peer:'u2',ext:{thread:{root:ROOT},agent:{from:'Niffler 4',to:{name:'Yarrow 6',owner:'u2'}}}});
  expect(r.thread).toBe(ROOT);
  // A reply to a reply joins the first message's thread.
  await c.send({text:'And the tests',agent:'Niffler 4',replyTo:REPLY});
  expect(core.sent[1].ext).toMatchObject({thread:{root:ROOT}});
 });
 it('answers a person plainly, and refuses an id it does not have',async()=>{
  const fromVijay:ChatMessage={...fromYarrow,agent:undefined};
  const core=session('core',{u2:'Vijay Kumar'},[fromVijay]),c=chat([core]);
  await c.send({text:'Done',agent:'Niffler 4',replyTo:ROOT});
  expect(core.sent[0].ext).toEqual({agent:{from:'Niffler 4'},thread:{root:ROOT}});
  await expect(c.send({text:'x',replyTo:'nope'})).rejects.toThrow(/No message nope/);
  await expect(c.send({text:'x'})).rejects.toThrow(/Say who it is for/);
 });
});

describe('chat handoff brief',()=>{
 it('says whose words these are and keeps the text',()=>{
  const brief=handoffBrief({sender:'Vijay',where:'#Core',text:'Fix the login bug\nsteps…',files:['log.txt']});
  expect(brief).toMatch(/^Vijay sent this in Canopy Teams chat \(#Core\)/);
  expect(brief).toContain('Fix the login bug\nsteps…');
  expect(brief).toContain('log.txt');
  expect(handoffLabel({sender:'Vijay',where:'#Core',text:'\n  Fix the login bug\nmore'})).toBe('Fix the login bug');
 });
});
