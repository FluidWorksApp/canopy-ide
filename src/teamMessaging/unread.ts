import type {ChatMessage} from './client';
import {parseExtensions,sameConversation} from './chatEvents';

/** Conversation key for the team-wide channel; any other key is a peer's user id. */
export const CHANNEL='#';
/** `mentions`: unread messages that name this account personally (or edits
 * aside, @channel never counts here), present only when there are some. */
export type ConversationUnread={channel:number;peers:Record<string,number>;total:number;mentions?:{channel:number;peers:Record<string,number>}};
export const NO_UNREAD:ConversationUnread=Object.freeze({channel:0,peers:Object.freeze({}) as Record<string,number>,total:0});

/** Which conversation a message belongs to, seen from `user`'s side. */
export const conversationKey=(message:Pick<ChatMessage,'sender'|'recipient'>,user:string)=>message.recipient===null?CHANNEL:message.sender===user?message.recipient:message.sender;

/** The thread a message replies in: the id of its root, flattened (a reply to a
 * reply belongs to the first message's thread). Undefined for a message that
 * is not a reply, or whose named root is in another conversation (the thread
 * reference is then ignored and it shows as an ordinary message). A root that
 * is not loaded still names a thread: "a message not on this device". */
export function threadRoot(message:ChatMessage,find:(id:string)=>ChatMessage|undefined):string|undefined{
 const ref=parseExtensions(message).thread;if(!ref)return undefined;
 const root=find(ref.root);
 if(!root)return ref.root;
 if(!sameConversation(root,message))return undefined;
 const parent=parseExtensions(root).thread;
 if(!parent)return root.id;
 // One level of flattening is all a well behaved sender needs; deeper chains
 // (or a loop) resolve to the nearest root in the same conversation.
 const grand=find(parent.root);
 return grand&&sameConversation(grand,message)&&!parseExtensions(grand).thread?grand.id:root.id;
}
const indexOf=(messages:readonly ChatMessage[])=>{const byId=new Map(messages.map(m=>[m.id,m]));return (id:string)=>byId.get(id);};
/** Threads this account follows: it wrote the root or replied in it. */
export function followedThreads(messages:readonly ChatMessage[],user:string,find=indexOf(messages)):Set<string>{
 const followed=new Set<string>();
 for(const m of messages){
  if(m.sender!==user)continue;
  const root=threadRoot(m,find);
  if(root)followed.add(root);else followed.add(m.id);
 }
 return followed;
}
/** Whether a message names this account personally. */
export const mentionsUser=(message:ChatMessage,user:string)=>!!parseExtensions(message).mentions?.includes(user);
/** Per-conversation counts of unread messages. Only messages someone else sent
 * to this account (or to the channel) can count, whatever the unread list says.
 * A thread reply counts only in a thread this account follows; others show as
 * "new replies" on their root instead (see `unreadReplies`). */
export function countUnread(messages:readonly ChatMessage[],unreadIds:readonly string[],user:string):ConversationUnread{
 if(!unreadIds.length)return NO_UNREAD;
 const unread=new Set(unreadIds),peers:Record<string,number>={},mentionPeers:Record<string,number>={};let channel=0,total=0,mentionChannel=0;
 const find=indexOf(messages);let followed:Set<string>|undefined;
 for(const m of messages){
  if(!unread.has(m.id)||m.sender===user)continue;
  if(m.recipient!==null&&m.recipient!==user)continue;
  const root=threadRoot(m,find);
  if(root&&!(followed??=followedThreads(messages,user,find)).has(root))continue;
  const mention=mentionsUser(m,user);
  if(m.recipient===null){channel++;if(mention)mentionChannel++;}
  else{peers[m.sender]=(peers[m.sender]??0)+1;if(mention)mentionPeers[m.sender]=(mentionPeers[m.sender]??0)+1;}
  total++;
 }
 if(!total)return NO_UNREAD;
 return mentionChannel||Object.keys(mentionPeers).length?{channel,peers,total,mentions:{channel:mentionChannel,peers:mentionPeers}}:{channel,peers,total};
}
export type ThreadSummary={root:string;replies:number;last:number;unread:number;users:string[]};
/** Reply counts per thread root, for the "N replies" line under a root. */
export function threadSummaries(messages:readonly ChatMessage[],unreadIds:readonly string[],user:string):Record<string,ThreadSummary>{
 const find=indexOf(messages),unread=new Set(unreadIds),out:Record<string,ThreadSummary>={};
 for(const m of messages){
  const root=threadRoot(m,find);if(!root)continue;
  const s=out[root]??={root,replies:0,last:0,unread:0,users:[]};
  s.replies++;s.last=Math.max(s.last,m.created);if(!s.users.includes(m.sender))s.users.push(m.sender);
  if(unread.has(m.id)&&m.sender!==user)s.unread++;
 }
 return out;
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
