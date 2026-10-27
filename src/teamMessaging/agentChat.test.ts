import {describe,expect,it,vi} from 'vitest';
import {agentFooter,createAgentChat,type ChatSession} from './agentChat';
import {handoffBrief,handoffLabel} from './chatHandoff';

function session(team:string,members:Record<string,string>):ChatSession&{sent:{text:string;peer:string|null}[]}{
 const sent:{text:string;peer:string|null}[]=[];
 return {team,user:'me',sent,members:()=>({me:'Sam',...members}),send:vi.fn(async(text:string,peer:string|null)=>{sent.push({text,peer});return {id:'m1',delivery:{state:'sent'}};})};
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

describe('chat handoff brief',()=>{
 it('says whose words these are and keeps the text',()=>{
  const brief=handoffBrief({sender:'Vijay',where:'#Core',text:'Fix the login bug\nsteps…',files:['log.txt']});
  expect(brief).toMatch(/^Vijay sent this in Canopy Teams chat \(#Core\)/);
  expect(brief).toContain('Fix the login bug\nsteps…');
  expect(brief).toContain('log.txt');
  expect(handoffLabel({sender:'Vijay',where:'#Core',text:'\n  Fix the login bug\nmore'})).toBe('Fix the login bug');
 });
});
