import {beforeEach,describe,expect,it,vi} from 'vitest';
import {LiveRooms,VIEWER_TTL_MS,attributed,shownFile} from './rooms';
import type {LiveOp} from '../teamMessaging/liveEvents';

type Sent={team:string;peer:string;room:string;op:LiveOp};
let sent:Sent[],now:number,rooms:LiveRooms,deliver:ReturnType<typeof vi.fn<(text:string)=>Promise<{delivered:boolean;note:string}>>>;
const members:Record<string,Record<string,string>>={core:{sam:'Sam',ana:'Ana',bo:'Bo'}};
const req=(n:number)=>`7c9e6679-7425-40de-944b-e07fc1f90a${String(n).padStart(2,'0')}`;
beforeEach(()=>{
 sent=[];now=1000;
 rooms=new LiveRooms({send:async(team,peer,room,op)=>{sent.push({team,peer,room,op});return 1;},members:t=>members[t]??null,now:()=>now});
 deliver=vi.fn(async()=>({delivered:true,note:'Sent.'}));
});
const open=()=>rooms.open({sessionId:'s1',title:'Fix login',agent:'claude',turns:[{id:'doc:1',at:1,kind:'prompt',text:'Fix the login bug'}],deliver});
const ev=(sender:string,target:string,op:LiveOp,team='core')=>rooms.handle({team,sender,senderName:members[team]?.[sender],event:{target,...op} as never});
const flush=()=>new Promise(r=>setTimeout(r,0));

describe('live rooms',()=>{
 it('lets in only the conversation the card went to, and greets a joiner with the recent turns',()=>{
  const r=open();
  ev('ana',r.id,{op:'join'});
  expect(sent.at(-1)?.op).toEqual({op:'bye',reason:'not-allowed'});
  rooms.allow(r.id,{team:'core',peer:'ana'});
  ev('bo',r.id,{op:'join'});expect(sent.at(-1)).toMatchObject({peer:'bo',op:{op:'bye',reason:'not-allowed'}});
  ev('ana',r.id,{op:'join'});
  expect(sent.at(-1)).toMatchObject({peer:'ana',op:{op:'state',title:'Fix login',direct:false,viewers:['ana'],turns:[{id:'doc:1'}]}});
  expect(rooms.room(r.id)!.viewers.map(v=>v.name)).toEqual(['Ana']);
  // A channel card lets in anyone in the team, and existing viewers hear of them.
  rooms.allow(r.id,{team:'core',peer:null});sent=[];
  ev('bo',r.id,{op:'join'});
  expect(sent.find(s=>s.peer==='bo')?.op).toMatchObject({op:'state',viewers:['ana','bo']});
  expect(sent.find(s=>s.peer==='ana')?.op).toMatchObject({op:'state',viewers:['ana','bo']});
  expect((sent.find(s=>s.peer==='ana')!.op as {turns?:unknown}).turns).toBeUndefined();
  // Someone outside the team is refused even on a channel card.
  ev('eve',r.id,{op:'join'});expect(sent.at(-1)).toMatchObject({peer:'eve',op:{op:'bye',reason:'not-allowed'}});
 });
 it('holds a joiner\'s message for the owner, and sends it with their name only on Send',async()=>{
  const r=open();rooms.allow(r.id,{team:'core',peer:null});ev('ana',r.id,{op:'join'});
  ev('ana',r.id,{op:'say',request:req(1),text:'Use the v2\nAPI'});
  expect(deliver).not.toHaveBeenCalled();
  expect(rooms.room(r.id)!.requests).toMatchObject([{name:'Ana',text:'Use the v2\nAPI'}]);
  sent=[];
  expect(await rooms.approve(r.id,req(1))).toBe(true);
  expect(deliver).toHaveBeenCalledWith(attributed('Ana','Use the v2\nAPI'));
  expect(attributed('Ana','a\nb')).toBe('[Ana, watching this session live in Canopy, says:] a b');
  expect(sent).toContainEqual(expect.objectContaining({peer:'ana',op:{op:'answer',request:req(1),outcome:'sent'}}));
  expect(sent).toContainEqual(expect.objectContaining({op:expect.objectContaining({op:'turn',turn:expect.objectContaining({by:'Ana',kind:'prompt'})})}));
  // The agent's own report of the same prompt does not show twice.
  const turns=rooms.room(r.id)!.turns.length;
  rooms.turnStarted('s1',attributed('Ana','Use the v2\nAPI'),now);expect(rooms.room(r.id)!.turns.length).toBe(turns);
  rooms.turnStarted('s1','Something the owner typed',now+1);expect(rooms.room(r.id)!.turns.at(-1)).toMatchObject({kind:'prompt',text:'Something the owner typed'});
  rooms.turnEnded('s1','Done.',['/Users/sam/code/app/src/a.ts','src/b.ts'],now+2);
  expect(rooms.room(r.id)!.turns.at(-1)).toMatchObject({kind:'reply',text:'Done.',files:['a.ts','src/b.ts']});
 });
 it('sends an edited message as edited, and a declined one never',async()=>{
  const r=open();rooms.allow(r.id,{team:'core',peer:null});ev('ana',r.id,{op:'join'});
  ev('ana',r.id,{op:'say',request:req(2),text:'drop the table'});
  rooms.decline(r.id,req(2));
  expect(sent.at(-1)?.op).toEqual({op:'answer',request:req(2),outcome:'declined'});
  ev('ana',r.id,{op:'say',request:req(3),text:'Try v2'});
  await rooms.approve(r.id,req(3),'Try the v2 API');
  expect(deliver).toHaveBeenCalledTimes(1);expect(deliver).toHaveBeenCalledWith(attributed('Ana','Try the v2 API'));
  expect(sent).toContainEqual(expect.objectContaining({op:{op:'answer',request:req(3),outcome:'sent',text:'Try the v2 API'}}));
 });
 it('gives messages straight to the agent when teammates may talk to it directly',async()=>{
  const r=open();rooms.allow(r.id,{team:'core',peer:null});ev('ana',r.id,{op:'join'});
  rooms.setDirect(r.id,true);
  expect(sent.at(-1)?.op).toMatchObject({op:'state',direct:true});
  ev('ana',r.id,{op:'say',request:req(4),text:'Run the tests'});await flush();
  expect(deliver).toHaveBeenCalledWith(attributed('Ana','Run the tests'));
  expect(rooms.room(r.id)!.requests).toEqual([]);
 });
 it('refuses a message from someone not watching, and caps what one viewer can queue',()=>{
  const r=open();rooms.allow(r.id,{team:'core',peer:null});
  ev('ana',r.id,{op:'say',request:req(5),text:'hi'});expect(sent.at(-1)?.op).toMatchObject({op:'answer',outcome:'declined'});
  ev('ana',r.id,{op:'join'});
  for(let i=10;i<15;i++)ev('ana',r.id,{op:'say',request:req(i),text:`m${i}`});
  expect(rooms.room(r.id)!.requests).toHaveLength(3);
 });
 it('removes a joiner, drops their requests and refuses them after',()=>{
  const r=open();rooms.allow(r.id,{team:'core',peer:null});ev('ana',r.id,{op:'join'});ev('bo',r.id,{op:'join'});
  ev('ana',r.id,{op:'say',request:req(6),text:'hi'});
  rooms.kick(r.id,'core','ana');
  expect(sent).toContainEqual(expect.objectContaining({peer:'ana',op:{op:'bye',reason:'removed'}}));
  expect(rooms.room(r.id)!.viewers.map(v=>v.id)).toEqual(['bo']);expect(rooms.room(r.id)!.requests).toEqual([]);
  ev('ana',r.id,{op:'join'});expect(sent.at(-1)).toMatchObject({peer:'ana',op:{op:'bye',reason:'removed'}});
 });
 it('forgets viewers who stop saying they watch, and ends for everyone on close',()=>{
  const r=open();rooms.allow(r.id,{team:'core',peer:null});ev('ana',r.id,{op:'join'});ev('bo',r.id,{op:'join'});
  now+=VIEWER_TTL_MS/2;ev('bo',r.id,{op:'join'});
  now+=VIEWER_TTL_MS/2+1;rooms.prune();
  expect(rooms.room(r.id)!.viewers.map(v=>v.id)).toEqual(['bo']);
  sent=[];rooms.close(r.id);
  expect(sent).toEqual([{team:'core',peer:'bo',room:r.id,op:{op:'bye',reason:'ended'}}]);
  expect(rooms.room(r.id)).toBeUndefined();
  ev('bo',r.id,{op:'join'});expect(sent.at(-1)?.op).toEqual({op:'bye',reason:'ended'});
 });
 it('opens to a team that sees the shared terminal',()=>{
  const r=open();rooms.setTerminal(r.id,{workspace:'alice',publication:req(7)},'core');
  ev('bo',r.id,{op:'join'});expect(sent.at(-1)?.op).toMatchObject({op:'state',terminal:{workspace:'alice',publication:req(7)}});
  rooms.setTerminal(r.id,undefined);ev('ana',r.id,{op:'join'});expect(sent.at(-1)?.op).toEqual({op:'bye',reason:'not-allowed'});
 });
 it('shows a changed file by its name when it is an absolute path here',()=>{
  expect(shownFile('C:\\Users\\sam\\app\\a.ts')).toBe('a.ts');expect(shownFile('src\\b.ts')).toBe('src/b.ts');expect(shownFile('/home/x/c.ts')).toBe('c.ts');
 });
});
