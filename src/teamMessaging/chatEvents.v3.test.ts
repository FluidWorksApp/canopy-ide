import {describe,expect,it} from 'vitest';
import type {ChatMessage} from './client';
import {CHAT_VERSION,DELETE_TEXT,MAX_MENTIONS,editText,eventOf,parseExtensions,reactionText} from './chatEvents';
import {sameChatMessage,validChatMessage} from './messageSchema';
import {v1Renders,v1SameChatMessage,v1ValidChatMessage,v1ValidateMessage} from './fixtures/v1Schema';

const T='11111111-1111-4111-8111-111111111111';
let n=0;const uuid=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
const base=(over:Partial<ChatMessage>={}):ChatMessage=>({id:uuid(),sender:'me',recipient:null,text:'hello',created:Date.now(),v:CHAT_VERSION,...over});

describe('chat v3 extensions',()=>{
 it('parses edits, deletes, replies and mentions',()=>{
  expect(eventOf(base({text:editText('new'),event:{type:'edit',target:T,text:'new',mentions:['ada']}}))).toEqual({type:'edit',target:T,text:'new',mentions:['ada']});
  expect(eventOf(base({text:DELETE_TEXT,event:{type:'delete',target:T}}))).toEqual({type:'delete',target:T});
  expect(parseExtensions(base({thread:{root:T},mentions:['ada','sam'],mentionsAll:true}))).toEqual({v:CHAT_VERSION,thread:{root:T},mentions:['ada','sam'],mentionsAll:true});
 });
 it('drops malformed or unbounded fields, keeping the message as plain text',()=>{
  const bad:Partial<ChatMessage>[]=[
   {thread:{root:'nope'}},{thread:{root:T,extra:1}},{thread:T},
   {mentions:[]},{mentions:['ada','ada']},{mentions:['a‮b']},{mentions:['a\u0007']},{mentions:Array.from({length:MAX_MENTIONS+1},(_,i)=>`u${i}`)},{mentions:['x'.repeat(257)]},{mentions:'ada'},
   {mentionsAll:'yes'},{mentionsAll:true,recipient:'ada'},
  ];
  for(const over of bad){
   const m=base(over),ext=parseExtensions(m);
   expect(ext.thread??ext.mentions??ext.mentionsAll,JSON.stringify(over)).toBeUndefined();
   expect(validChatMessage(m)).toBe(true);
  }
  for(const event of [{type:'edit',target:T,text:''},{type:'edit',target:T,text:'x'.repeat(16001)},{type:'edit',target:T,text:'x',extra:1},{type:'edit',target:T,text:'x',mentions:['a','a']},{type:'delete',target:T,text:'x'},{type:'delete',target:'x'}])
   expect(eventOf(base({event})),JSON.stringify(event).slice(0,60)).toBeUndefined();
  // An event is never itself a reply or a mention; a message never replies to itself.
  expect(parseExtensions(base({event:{type:'delete',target:T},thread:{root:T},mentions:['ada']}))).toEqual({v:CHAT_VERSION,event:{type:'delete',target:T}});
  const self=base();expect(parseExtensions({...self,thread:{root:self.id}}).thread).toBeUndefined();
 });
 it('keeps an edit fallback inside the message bound',()=>{
  const text=editText('é'.repeat(8000));
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16000);expect(text.startsWith('✎ edited: ')).toBe(true);
 });
 it('every v3 message shape is accepted, saved and shown with text by a v1 client',()=>{
  const now=Date.now(),envelope={created:now,expires:now+300_000};
  const attachment={id:uuid(),name:'plan.pdf',size:10,type:'application/pdf',sha256:'0'.repeat(64)};
  const shapes:ChatMessage[]=[
   base({text:editText('Fixed typo'),event:{type:'edit',target:T,text:'Fixed typo'}}),
   base({recipient:'ada',text:editText('Fixed @Ada'),event:{type:'edit',target:T,text:'Fixed @Ada',mentions:['ada']}}),
   base({text:DELETE_TEXT,event:{type:'delete',target:T}}),
   base({recipient:'ada',text:DELETE_TEXT,event:{type:'delete',target:T}}),
   base({text:'In a thread',thread:{root:T}}),
   base({recipient:'ada',text:'Reply with a file',thread:{root:T},attachments:[attachment]}),
   base({text:'@Ada look',mentions:['ada']}),
   base({text:'@channel heads up',mentionsAll:true,mentions:['ada','sam']}),
   base({text:reactionText('👍','add',{text:'x'}),event:{type:'reaction',target:T,emoji:'👍',op:'add'}}),
  ];
  for(const m of shapes){
   expect(validChatMessage(m)).toBe(true);
   expect(v1ValidChatMessage(m)).toBe(true);
   expect(()=>v1ValidateMessage(m,'me',m.recipient??'ada',envelope)).not.toThrow();
   expect(v1Renders(m)).toBe(true);expect(m.text.trim()).not.toBe('');
   const copy=JSON.parse(JSON.stringify(m));
   expect(v1SameChatMessage(copy,m)).toBe(true);expect(sameChatMessage(copy,m)).toBe(true);
  }
 });
});
