import {postAttention,type AttentionInput} from '../attention';
import {getSettings} from '../settings';
import {subscribeTeamMessages,type TeamMessageEvent} from './session';
import {CHANNEL,conversationKey,conversationShown,teamName} from './unread';

type Dependencies={
 subscribe:(listener:(event:TeamMessageEvent)=>void)=>()=>void;
 /** The window is in front and not hidden. */
 focused:()=>boolean;
 shown:(team:string,user:string,peer:string|null)=>boolean;
 settings:()=>{teamMessageNotifications:boolean;teamMessagePreviews:boolean};
 post:(input:AttentionInput)=>unknown;
 teamName:(team:string)=>string|undefined;
};

const firstLine=(text:string)=>{const line=text.split(/\r?\n/).map(l=>l.trim()).find(Boolean)??'';return line.length>120?`${line.slice(0,119)}…`:line;};

/** What a teammate's message posts to the attention queue (the bell, the corner
 * card and the system banner, even while working elsewhere in Canopy). */
export function teamMessageAttention(event:TeamMessageEvent,options:{previews:boolean;teamName?:string}):AttentionInput{
 const {team,user,message}=event,key=conversationKey(message,user),peer=key===CHANNEL?null:key;
 const sender=event.senderName?.trim()||'A teammate';
 const channel=options.teamName?`#${options.teamName}`:'the team channel';
 const preview=options.previews?firstLine(message.text):'';
 const title=preview?(peer?`${sender}: ${preview}`:`${sender} in ${channel}: ${preview}`):(peer?`${sender} sent you a message`:`${sender} posted in ${channel}`);
 return {
  kind:'fyi',tone:'info',source:'team',title,
  where:{kind:'chat',peer,team,account:user,name:peer?sender:(options.teamName??'Team')},
  dedupeKey:`team-message:${user}:${team}:${message.id}`,
 };
}

/** Announces messages that arrive while their conversation is not in front of
 * the user. A conversation on screen in a focused window is read, not missed. */
export function startTeamMessageNotifications(dependencies:Dependencies={
 subscribe:subscribeTeamMessages,
 focused:()=>document.visibilityState==='visible'&&document.hasFocus(),
 shown:conversationShown,
 settings:getSettings,
 post:postAttention,
 teamName,
}){
 return dependencies.subscribe(event=>{
  const key=conversationKey(event.message,event.user),peer=key===CHANNEL?null:key;
  if(dependencies.focused()&&dependencies.shown(event.team,event.user,peer))return;
  const settings=dependencies.settings();
  if(settings.teamMessageNotifications===false)return;
  dependencies.post(teamMessageAttention(event,{previews:settings.teamMessagePreviews!==false,teamName:dependencies.teamName(event.team)}));
 });
}
