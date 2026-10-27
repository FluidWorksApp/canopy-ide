import {describe,expect,it} from 'vitest';
import {LIVE_LIMITS,LIVE_VERSION,fitState,liveText,parseLiveEvent,type LiveEvent} from './liveEvents';
import {CHAT_VERSION,eventVersion,isLiveEvent,parseExtensions} from './chatEvents';
import {parseCard,cardText} from './cardSchema';
import type {ChatMessage} from './client';

const room='0f8fad5b-d9cb-469f-a165-70867728950e',req='7c9e6679-7425-40de-944b-e07fc1f90ae7';
const turn={id:'p:1',at:1,kind:'prompt' as const,text:'Fix the login bug',files:['src/login.ts']};

describe('live session events',()=>{
 it('parses each op into a fresh object with only known fields',()=>{
  for(const e of [{type:'live',target:room,op:'join'},{type:'live',target:room,op:'leave'},{type:'live',target:room,op:'say',request:req,text:'Use the v2 API'},
   {type:'live',target:room,op:'state',title:'Login',agent:'claude',direct:false,viewers:['ana'],turns:[turn],terminal:{workspace:'alice',publication:req}},
   {type:'live',target:room,op:'turn',turn},{type:'live',target:room,op:'answer',request:req,outcome:'sent',text:'edited'},{type:'live',target:room,op:'bye',reason:'removed'}]){
   const parsed=parseLiveEvent(e);expect(parsed).toEqual(e);expect(parsed).not.toBe(e);
  }
 });
 it('drops anything malformed, unknown or unbounded',()=>{
  const bad=[
   {type:'live',target:'not-a-room',op:'join'},{type:'live',target:room,op:'join',extra:1},{type:'live',target:room,op:'dance'},
   {type:'live',target:room,op:'say',request:req,text:'   '},{type:'live',target:room,op:'say',request:'x',text:'hi'},
   {type:'live',target:room,op:'say',request:req,text:'x'.repeat(LIVE_LIMITS.sayBytes+1)},{type:'live',target:room,op:'say',request:req,text:'evil‮text'},
   {type:'live',target:room,op:'state',title:'T',agent:'a',direct:'yes',viewers:[]},{type:'live',target:room,op:'state',title:'T',agent:'a',direct:false,viewers:['a','a']},
   {type:'live',target:room,op:'state',title:'T',agent:'a',direct:false,viewers:[],terminal:{workspace:'../x',publication:req}},
   {type:'live',target:room,op:'turn',turn:{...turn,kind:'tool'}},{type:'live',target:room,op:'turn',turn:{...turn,files:new Array(LIVE_LIMITS.files+1).fill('a')}},
   {type:'live',target:room,op:'answer',request:req,outcome:'maybe'},{type:'live',target:room,op:'bye',reason:'bored'},
  ];
  for(const e of bad)expect(parseLiveEvent(e)).toBeUndefined();
 });
 it('rides as a v4 chat event, never as a message extension',()=>{
  const event:LiveEvent={type:'live',target:room,op:'join'};
  const m:ChatMessage={id:req,sender:'ana',recipient:'sam',text:liveText(event),created:1,v:CHAT_VERSION,event,thread:{root:room}};
  const ext=parseExtensions(m);
  expect(isLiveEvent(ext.event)).toBe(true);expect(ext.thread).toBeUndefined();
  expect(CHAT_VERSION).toBe(LIVE_VERSION);expect(eventVersion(event)).toBe(LIVE_VERSION);
  expect(liveText(event)).toMatch(/join your live agent session/);
 });
 it('fits a state event under its bound by dropping the oldest turns',()=>{
  const turns=Array.from({length:LIVE_LIMITS.turns},(_,i)=>({id:`t${i}`,at:i,kind:'reply' as const,text:'é'.repeat(900)}));
  const fitted=fitState({type:'live',target:room,op:'state',title:'T',agent:'a',direct:false,viewers:[],turns});
  expect(fitted.turns!.length).toBeLessThan(turns.length);expect(fitted.turns!.at(-1)!.id).toBe(`t${LIVE_LIMITS.turns-1}`);
  expect(parseLiveEvent(fitted)).toBeDefined();
 });
});

describe('live session cards',()=>{
 it('parses a live-session card and a hand-off card that can be joined',()=>{
  const card={type:'live-session',v:1,room,title:'Fix login',agent:'claude',dir:'web'};
  expect(parseCard(card)).toEqual(card);
  expect(cardText(parseCard(card)!)).toMatch(/^Live agent session: Fix login/);
  expect(parseCard({...card,room:'nope'})).toBeUndefined();expect(parseCard({...card,dir:'a/b'})).toBeUndefined();
  const handoff={type:'handoff',v:1,title:'T',agent:'claude',session:'abc',packet:'## State',room};
  expect(parseCard(handoff)).toEqual(handoff);expect(parseCard({...handoff,room:'x'})).toBeUndefined();
 });
});
