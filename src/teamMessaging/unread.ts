import type {ChatMessage} from './client';

/** Conversation key for the team-wide channel; any other key is a peer's user id. */
export const CHANNEL='#';
export type ConversationUnread={channel:number;peers:Record<string,number>;total:number};
export const NO_UNREAD:ConversationUnread=Object.freeze({channel:0,peers:Object.freeze({}) as Record<string,number>,total:0});

/** Which conversation a message belongs to, seen from `user`'s side. */
export const conversationKey=(message:Pick<ChatMessage,'sender'|'recipient'>,user:string)=>message.recipient===null?CHANNEL:message.sender===user?message.recipient:message.sender;

/** Per-conversation counts of unread messages. Only messages someone else sent
 * to this account (or to the channel) can count, whatever the unread list says. */
export function countUnread(messages:readonly ChatMessage[],unreadIds:readonly string[],user:string):ConversationUnread{
 if(!unreadIds.length)return NO_UNREAD;
 const unread=new Set(unreadIds),peers:Record<string,number>={};let channel=0,total=0;
 for(const m of messages){
  if(!unread.has(m.id)||m.sender===user)continue;
  if(m.recipient===null)channel++;
  else if(m.recipient===user)peers[m.sender]=(peers[m.sender]??0)+1;
  else continue;
  total++;
 }
 return total?{channel,peers,total}:NO_UNREAD;
}

/** Badge text for a count: small numbers exactly, then "9+". */
export const badgeLabel=(count:number)=>count>9?'9+':String(Math.max(0,count));

// Conversations currently on screen (an active chat tab in the visible project).
// Reference counted: two windows of the same project can show one conversation.
const shown=new Map<string,number>();
const shownKey=(team:string,user:string,peer:string|null)=>JSON.stringify([user,team,peer??CHANNEL]);
export function showConversation(team:string,user:string,peer:string|null){
 const key=shownKey(team,user,peer);shown.set(key,(shown.get(key)??0)+1);
 let done=false;return()=>{if(done)return;done=true;const left=(shown.get(key)??1)-1;if(left>0)shown.set(key,left);else shown.delete(key);};
}
export const conversationShown=(team:string,user:string,peer:string|null)=>shown.has(shownKey(team,user,peer));

// Team names, in memory only, so a channel notification can say "#Core".
const teamNames=new Map<string,string>();
export function rememberTeamName(team:string,name:unknown){if(typeof name==='string'&&name.trim())teamNames.set(team,name.trim().slice(0,80));}
export const teamName=(team:string)=>teamNames.get(team);
