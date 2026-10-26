import {expect,it,vi} from 'vitest';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
import {muteKey,personalReason,startTeamMessageNotifications,teamMessageAttention} from './notifications';
import type {TeamMessageEvent} from './session';
import type {AttentionInput} from '../attention';

type Over={notify?:boolean;mentions?:boolean;muted?:string[]};
function harness(over:Over={}){
 let listener:(event:TeamMessageEvent)=>void=()=>{};const post=vi.fn<(input:AttentionInput)=>void>();
 startTeamMessageNotifications({
  subscribe:fn=>{listener=fn;return()=>{listener=()=>{};};},focused:()=>false,shown:()=>false,
  settings:()=>({teamMessageNotifications:over.notify??true,teamMessagePreviews:true,teamMentionNotifications:over.mentions??true,teamMutedConversations:over.muted??[]}),
  post,teamName:()=>'Core',
 });
 return {post,arrive:(event:TeamMessageEvent)=>listener(event)};
}
const channel=(over:Partial<TeamMessageEvent['message']>={},extra:Partial<TeamMessageEvent>={}):TeamMessageEvent=>({team:'core',user:'me',senderName:'Ada',message:{id:crypto.randomUUID(),sender:'ada',recipient:null,text:'Deploying now',created:1,...over},...extra});
const MUTED=[muteKey('core',null)];

it('keeps a muted conversation quiet, except for a personal mention, a review request or a reply to you',()=>{
 const {post,arrive}=harness({muted:MUTED});
 arrive(channel());
 arrive(channel({mentionsAll:true}));
 expect(post).not.toHaveBeenCalled();
 arrive(channel({mentions:['me']}));
 arrive(channel({card:{type:'review-request'},mentions:['me']} as never));
 arrive(channel({},{replyToOwn:true}));
 expect(post.mock.calls.map(([i])=>i.title)).toEqual(['Ada mentioned you in #Core: Deploying now','Ada asked you for a review: Deploying now','Ada replied to your message: Deploying now']);
 // Someone else's mention, or a malformed card, is not personal.
 arrive(channel({mentions:['sam']}));arrive(channel({card:{type:'review-request',reviewers:'me'}} as never));arrive(channel({card:{type:'review-request',reviewers:['sam']}} as never));
 expect(post).toHaveBeenCalledTimes(3);
});

it('lets mention notifications override notifications switched off, unless that is off too',()=>{
 const on=harness({notify:false});on.arrive(channel());on.arrive(channel({mentions:['me']}));
 expect(on.post).toHaveBeenCalledTimes(1);
 const off=harness({notify:false,mentions:false});off.arrive(channel({mentions:['me']}));
 expect(off.post).not.toHaveBeenCalled();
 const mutedOnly=harness({mentions:false,muted:MUTED});mutedOnly.arrive(channel({mentions:['me']}));
 expect(mutedOnly.post).not.toHaveBeenCalled();
});

it('summarizes messages that arrived late in one notification',()=>{
 expect(teamMessageAttention(channel({},{backfill:4}),{previews:true,teamName:'Core'}).title).toBe('4 messages from Ada in #Core while you were away');
 expect(teamMessageAttention({...channel({recipient:'me'}),backfill:2},{previews:true}).title).toBe('2 messages from Ada while you were away');
 expect(personalReason(channel({mentionsAll:true}))).toBeUndefined();
});
