import {expect,it,vi} from 'vitest';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
import {startTeamMessageNotifications,teamMessageAttention} from './notifications';
import type {TeamMessageEvent} from './session';
import {followLink,formatDeepLink,parseDeepLink,type DeepLink} from '../deepLinks';
import {shouldReachOS,type AttentionInput} from '../attention';

const dm:TeamMessageEvent={team:'core',user:'me',senderName:'Ada',message:{id:'m1',sender:'ada',recipient:'me',text:'Can you review?\nDetails below',created:1}};
const channel:TeamMessageEvent={team:'core',user:'me',senderName:'Sam',message:{id:'m2',sender:'sam',recipient:null,text:'Deploying now',created:2}};
function harness(over:{focused?:boolean;shown?:boolean;notify?:boolean;previews?:boolean}={}){
 let listener:(event:TeamMessageEvent)=>void=()=>{};const post=vi.fn<(input:AttentionInput)=>void>();
 const stop=startTeamMessageNotifications({
  subscribe:fn=>{listener=fn;return()=>{listener=()=>{};};},
  focused:()=>over.focused??false,shown:()=>over.shown??false,
  settings:()=>({teamMessageNotifications:over.notify??true,teamMessagePreviews:over.previews??true}),
  post,teamName:()=>'Core',
 });
 return {post,stop,arrive:(event:TeamMessageEvent)=>listener(event)};
}
const ctx={terminals:[],detachedPtys:[],members:[]};

it('notifies with "Name: first line" when the window is not focused',()=>{
 const {post,arrive}=harness({focused:false,shown:true});
 arrive(dm);arrive(channel);
 expect(post.mock.calls.map(([input])=>input.title)).toEqual(['Ada: Can you review?','Sam in #Core: Deploying now']);
 expect(post.mock.calls[0][0]).toMatchObject({kind:'fyi',source:'team',where:{kind:'chat',peer:'ada',team:'core',account:'me',name:'Ada'}});
});

it('notifies when focused only if that conversation is not on screen',()=>{
 const onScreen=harness({focused:true,shown:true});onScreen.arrive(dm);
 expect(onScreen.post).not.toHaveBeenCalled();
 const elsewhere=harness({focused:true,shown:false});elsewhere.arrive(dm);
 expect(elsewhere.post).toHaveBeenCalledTimes(1);
});

it('respects the Team messages toggle and hides previews when asked',()=>{
 const off=harness({notify:false});off.arrive(dm);expect(off.post).not.toHaveBeenCalled();
 const hidden=harness({previews:false});hidden.arrive(dm);hidden.arrive(channel);
 expect(hidden.post.mock.calls.map(([input])=>input.title)).toEqual(['Ada sent you a message','Sam posted in #Core']);
 expect(JSON.stringify(hidden.post.mock.calls)).not.toContain('review');
});

it('stops listening when disposed',()=>{
 const {post,stop,arrive}=harness();stop();arrive(dm);expect(post).not.toHaveBeenCalled();
});

it('opens that conversation when the notification is clicked',()=>{
 for(const [event,conversation] of [[dm,{teamId:'core',userId:'me',peer:'ada',name:'Ada'}],[channel,{teamId:'core',userId:'me',peer:null,name:'Core'}]] as const){
  const link=teamMessageAttention(event,{previews:true,teamName:'Core'}).where as DeepLink;
  // Through the OS and back as a canopy:// string.
  const parsed=parseDeepLink(formatDeepLink(link));
  expect(parsed).not.toBeNull();
  expect(followLink(parsed!,ctx)).toEqual({do:'account-chat',conversation});
 }
});

it('leaves relay chat links unchanged',()=>{
 expect(followLink(parseDeepLink('canopy://chat')!,ctx)).toEqual({do:'chat',peer:null,name:'Team'});
});

it('routes unread team messages to system notifications while working elsewhere in Canopy',()=>{
 const {post,arrive}=harness({focused:true,shown:false});
 arrive(dm);arrive(channel);
 expect(post).toHaveBeenCalledTimes(2);
 for(const [input] of post.mock.calls){
  expect(shouldReachOS({...input,id:'notification',ts:Date.now()},true)).toBe(true);
 }
});
