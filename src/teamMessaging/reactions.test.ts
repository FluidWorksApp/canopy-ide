import {describe,expect,it} from 'vitest';
import type {ChatMessage} from './client';
import {applyEvent,drainPending,hasReacted,nextReactionTime,reactionChips,EMPTY_OVERLAY,MAX_PENDING_EVENTS,MAX_REACTION_ENTRIES,PENDING_MS,type EventOverlay} from './reactions';
import {CHAT_VERSION,eventOf,eventRecipient,parseExtensions,reactionText,sameConversation,unknownExtension,validEmoji} from './chatEvents';
import {sameChatMessage,validChatMessage} from './messageSchema';
import {v1Renders,v1SameChatMessage,v1ValidChatMessage,v1ValidateMessage} from './fixtures/v1Schema';

const T='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
let n=0;const uuid=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
const channelTarget:ChatMessage={id:T,sender:'ada',recipient:null,text:'Ship it?',created:1};
type Over={sender?:string;recipient?:string|null;emoji?:string;op?:'add'|'remove';created?:number;target?:string;id?:string};
/** A reaction event message as a v2 client sends it. */
function reaction({sender='ada',recipient=null,emoji='👍',op='add',created=10,target=T,id=uuid()}:Over={}):ChatMessage{
 return {id,sender,recipient,text:reactionText(emoji,op,channelTarget),created,v:CHAT_VERSION,event:{type:'reaction',target,emoji,op}};
}
const finder=(...messages:ChatMessage[])=>(id:string)=>messages.find(m=>m.id===id);
const fold=(events:ChatMessage[],targets:ChatMessage[]=[channelTarget],start:EventOverlay=EMPTY_OVERLAY)=>events.reduce((o,e)=>applyEvent(o,e,finder(...targets)),start);
const chips=(o:EventOverlay,id=T)=>reactionChips(o.reactions,id,'me');

describe('reaction reducer',()=>{
 it('adds, groups by emoji with counts, and marks your own',()=>{
  const o=fold([reaction(),reaction({sender:'me'}),reaction({sender:'sam',emoji:'🎉',created:11})]);
  expect(chips(o)).toEqual([{emoji:'👍',count:2,users:['ada','me'],mine:true},{emoji:'🎉',count:1,users:['sam'],mine:false}]);
  expect(hasReacted(o.reactions,T,'me','👍')).toBe(true);
 });
 it('removes with a later remove and keeps the tombstone',()=>{
  const o=fold([reaction(),reaction({op:'remove',created:11})]);
  expect(chips(o)).toEqual([]);expect(o.reactions[T]).toBeDefined();
 });
 it('ignores a duplicate event and returns the same overlay',()=>{
  const e=reaction(),once=fold([e]);
  expect(applyEvent(once,e,finder(channelTarget))).toBe(once);
 });
 it('is last-write-wins by (created, id) whatever the arrival order',()=>{
  const add=reaction({created:11}),remove=reaction({op:'remove',created:12});
  expect(chips(fold([remove,add]))).toEqual([]);
  expect(fold([remove,add]).reactions).toEqual(fold([add,remove]).reactions);
  // Same millisecond: the larger event id wins, on every device.
  const a=reaction({created:5,id:'00000000-0000-4000-8000-aaaaaaaaaaaa'}),b=reaction({op:'remove',created:5,id:'00000000-0000-4000-8000-bbbbbbbbbbbb'});
  expect(chips(fold([a,b]))).toEqual([]);expect(chips(fold([b,a]))).toEqual([]);
 });
 it('holds an event for an unknown message until it loads, bounded in count and age',()=>{
  const early=reaction({target:OTHER}),now=1_000_000;
  let o=applyEvent(EMPTY_OVERLAY,early,finder(channelTarget),now);
  expect(o.pending).toHaveLength(1);expect(o.reactions).toEqual({});
  const other:ChatMessage={...channelTarget,id:OTHER};
  o=drainPending(o,finder(channelTarget,other),now+1000);
  expect(o.pending).toEqual([]);expect(chips(o,OTHER)).toHaveLength(1);
  // An event whose message never comes is dropped after PENDING_MS.
  const stale=applyEvent(EMPTY_OVERLAY,reaction({target:OTHER}),finder(),now);
  expect(drainPending(stale,finder(),now+PENDING_MS+1).pending).toEqual([]);
  let many=EMPTY_OVERLAY;for(let i=0;i<MAX_PENDING_EVENTS+20;i++)many=applyEvent(many,reaction({target:OTHER}),finder(),now);
  expect(many.pending).toHaveLength(MAX_PENDING_EVENTS);
 });
 it('drops an event that is not in its target\'s conversation',()=>{
  const dm:ChatMessage={id:T,sender:'ada',recipient:'me',text:'psst',created:1};
  // Sam names a direct message between Ada and me.
  expect(chips(fold([reaction({sender:'sam',recipient:'me'})],[dm]))).toEqual([]);
  // A channel event never decorates a direct message, nor the other way round.
  expect(chips(fold([reaction()],[dm]))).toEqual([]);
  expect(chips(fold([reaction({recipient:'me'})],[channelTarget]))).toEqual([]);
  // Either party of the pair may react.
  expect(chips(fold([reaction({recipient:'me'}),reaction({sender:'me',recipient:'ada',emoji:'🎉'})],[dm]))).toHaveLength(2);
 });
 it('bounds entries per message, keeping the newest',()=>{
  const events=Array.from({length:MAX_REACTION_ENTRIES+5},(_,i)=>reaction({sender:`user-${i}`,created:100+i}));
  const o=fold(events);
  expect(Object.keys(o.reactions[T])).toHaveLength(MAX_REACTION_ENTRIES);
  expect(hasReacted(o.reactions,T,'user-0','👍')).toBe(false);
  expect(hasReacted(o.reactions,T,`user-${MAX_REACTION_ENTRIES+4}`,'👍')).toBe(true);
 });
 it('orders a toggle strictly after the previous change',()=>{
  const o=fold([reaction({sender:'me',created:5000})]);
  expect(nextReactionTime(o.reactions,T,'me','👍',4000)).toBe(5001);
  expect(nextReactionTime(o.reactions,T,'me','👍',9000)).toBe(9000);
 });
});

describe('chat event wire format',()=>{
 it('parses a reaction event and drops malformed or unknown extensions',()=>{
  expect(eventOf(reaction())).toEqual({type:'reaction',target:T,emoji:'👍',op:'add'});
  const base=reaction();
  for(const event of [{...base.event as object,extra:1},{type:'reaction',target:'nope',emoji:'👍',op:'add'},{type:'reaction',target:T,emoji:'hello',op:'add'},{type:'reaction',target:T,emoji:'👍',op:'toggle'},{type:'edit',target:T,text:'x'},null,'reaction',[]]){
   const m={...base,event};
   expect(eventOf(m)).toBeUndefined();
   // Still a valid message: it shows as its text rather than failing.
   expect(validChatMessage(m)).toBe(true);
  }
  expect(unknownExtension({...base,event:{type:'edit'}})).toBe(true);expect(unknownExtension(base)).toBe(false);
  expect(parseExtensions({...base,v:'2' as unknown as number})).toEqual({event:eventOf(base)});
 });
 it('accepts single emoji (including sequences) and refuses text',()=>{
  for(const ok of ['👍','❤️','✅','👍🏽','👨‍👩‍👧','🇳🇿','1️⃣','#️⃣'])expect(validEmoji(ok),ok).toBe(true);
  for(const bad of ['','a','👍 ','<b>','hi👍','\u0000👍','👍'.repeat(9),' '])expect(validEmoji(bad),bad).toBe(false);
 });
 it('treats extension fields as part of a saved message\'s identity',()=>{
  const e=reaction();
  expect(sameChatMessage(e,JSON.parse(JSON.stringify({...e,event:{op:'add',emoji:'👍',target:T,type:'reaction'}})))).toBe(true);
  expect(sameChatMessage(e,{...e,event:{type:'reaction',target:T,emoji:'🎉',op:'add'}})).toBe(false);
  expect(sameChatMessage(e,{...e,v:3})).toBe(false);
 });
 it('scopes an event like its target and quotes it in the fallback text',()=>{
  expect(eventRecipient(channelTarget,'me')).toBeNull();
  expect(eventRecipient({sender:'me',recipient:'ada'},'me')).toBe('ada');
  expect(eventRecipient({sender:'ada',recipient:'me'},'me')).toBe('ada');
  expect(sameConversation({sender:'me',recipient:'ada'},{sender:'ada',recipient:'me'})).toBe(true);
  expect(reactionText('👍','add',{text:'x'.repeat(60)})).toBe(`👍 reacted to "${'x'.repeat(40)}…"`);
  expect(reactionText('👍','add',{text:'',attachments:[{id:T,name:'plan.pdf',size:1,type:'application/pdf',sha256:'0'.repeat(64)}]})).toBe('👍 reacted to "plan.pdf"');
 });
 it('every v2 reaction message is accepted, saved and shown with text by a v1 client',()=>{
  const now=Date.now(),envelope={created:now,expires:now+300_000};
  const targets:ChatMessage[]=[channelTarget,{id:T,sender:'me',recipient:'ada',text:'',created:1,attachments:[{id:OTHER,name:'a.png',size:1,type:'image/png',sha256:'0'.repeat(64)}]},{id:T,sender:'ada',recipient:'me',text:'\n\n  multi\nline',created:1}];
  for(const target of targets)for(const emoji of ['👍','❤️','👨‍👩‍👧','1️⃣'])for(const op of ['add','remove'] as const){
   const m:ChatMessage={id:uuid(),sender:'me',recipient:eventRecipient(target,'me'),text:reactionText(emoji,op,target),created:now,v:CHAT_VERSION,event:{type:'reaction',target:T,emoji,op}};
   // The v1 receiver is the other side; for a direct message, `recipient` is them.
   expect(v1ValidChatMessage(m)).toBe(true);
   expect(()=>v1ValidateMessage(m,'me',m.recipient??'ada',envelope)).not.toThrow();
   expect(v1Renders(m)).toBe(true);expect(m.text.trim()).not.toBe('');
   // A v1 history saves it whole and recognises it again on a repeat.
   expect(v1SameChatMessage(JSON.parse(JSON.stringify(m)),m)).toBe(true);
  }
 });
});
