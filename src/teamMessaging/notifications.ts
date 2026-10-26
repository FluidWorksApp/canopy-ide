import {postAttention,type AttentionInput} from '../attention';
import {getSettings,updateSettings} from '../settings';
import {subscribeTeamMessages,type TeamMessageEvent} from './session';
import {CHANNEL,conversationKey,conversationShown,mentionsUser,teamName} from './unread';

type NotificationSettings={teamMessageNotifications:boolean;teamMessagePreviews:boolean;teamMentionNotifications?:boolean;teamMutedConversations?:readonly string[]};
type Dependencies={
 subscribe:(listener:(event:TeamMessageEvent)=>void)=>()=>void;
 /** The window is in front and not hidden. */
 focused:()=>boolean;
 shown:(team:string,user:string,peer:string|null)=>boolean;
 settings:()=>NotificationSettings;
 post:(input:AttentionInput)=>unknown;
 teamName:(team:string)=>string|undefined;
};

/** Settings key of a muted conversation: `${team}:${peer}`, or `${team}:#` for the channel. */
export const muteKey=(team:string,peer:string|null)=>`${team}:${peer??CHANNEL}`;
export const isMuted=(team:string,peer:string|null,settings:Pick<NotificationSettings,'teamMutedConversations'>=getSettings())=>!!settings.teamMutedConversations?.includes(muteKey(team,peer));
/** Mutes or unmutes one conversation on this device. */
export function setMuted(team:string,peer:string|null,muted:boolean){
 const key=muteKey(team,peer),current=getSettings().teamMutedConversations??[];
 if(current.includes(key)===muted)return;
 updateSettings({teamMutedConversations:muted?[...current,key].slice(-500):current.filter(k=>k!==key)});
}

const firstLine=(text:string)=>{const line=text.split(/\r?\n/).map(l=>l.trim()).find(Boolean)??'';return line.length>120?`${line.slice(0,119)}…`:line;};
/** A review request card naming this account among its reviewers. Cards are
 * defined elsewhere (and may be absent or malformed), so this only reads. */
export function reviewRequestFor(message:unknown,user:string){
 const card=(message as {card?:unknown})?.card as {type?:unknown;reviewers?:unknown}|undefined;
 return !!card&&typeof card==='object'&&card.type==='review-request'&&Array.isArray(card.reviewers)&&card.reviewers.some(r=>r===user||(typeof r==='object'&&r!==null&&(r as {id?:unknown}).id===user));
}
/** Why a message is for this account personally, if it is: those still notify
 * in a muted conversation and, with Mention notifications on, when team
 * message notifications are off. @channel is not personal. */
export function personalReason(event:TeamMessageEvent):'mention'|'review'|'reply'|undefined{
 if(mentionsUser(event.message,event.user))return 'mention';
 if(reviewRequestFor(event.message,event.user))return 'review';
 if(event.replyToOwn)return 'reply';
 return undefined;
}

/** What a teammate's message posts to the attention queue (the bell, the corner
 * card and the system banner, even while working elsewhere in Canopy). */
export function teamMessageAttention(event:TeamMessageEvent,options:{previews:boolean;teamName?:string}):AttentionInput{
 const {team,user,message}=event,key=conversationKey(message,user),peer=key===CHANNEL?null:key;
 const sender=event.senderName?.trim()||'A teammate';
 const channel=options.teamName?`#${options.teamName}`:'the team channel';
 const preview=options.previews?firstLine(message.text):'';
 const reason=personalReason(event);
 const where={kind:'chat' as const,peer,team,account:user,name:peer?sender:(options.teamName??'Team')};
 if(event.backfill&&event.backfill>1){
  const place=peer?'':` in ${channel}`;
  return {kind:'fyi',tone:'info',source:'team',title:`${event.backfill} messages from ${sender}${place} while you were away`,where,dedupeKey:`team-message:${user}:${team}:${message.id}`};
 }
 const lead=reason==='mention'?(peer?`${sender} mentioned you`:`${sender} mentioned you in ${channel}`):reason==='review'?`${sender} asked you for a review`:reason==='reply'?`${sender} replied to your message`:'';
 const title=lead?(preview?`${lead}: ${preview}`:lead):preview?(peer?`${sender}: ${preview}`:`${sender} in ${channel}: ${preview}`):(peer?`${sender} sent you a message`:`${sender} posted in ${channel}`);
 return {kind:'fyi',tone:'info',source:'team',title,where,dedupeKey:`team-message:${user}:${team}:${message.id}`};
}

/** Announces messages that arrive while their conversation is not in front of
 * the user. A conversation on screen in a focused window is read, not missed.
 * A muted conversation, or notifications switched off, stay quiet except for
 * personal messages (a mention of you, a review request to you, a reply to
 * your message) while Mention notifications are on. */
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
  const personal=settings.teamMentionNotifications!==false&&!!personalReason(event);
  if(!personal&&(settings.teamMessageNotifications===false||isMuted(event.team,peer,settings)))return;
  dependencies.post(teamMessageAttention(event,{previews:settings.teamMessagePreviews!==false,teamName:dependencies.teamName(event.team)}));
 });
}
