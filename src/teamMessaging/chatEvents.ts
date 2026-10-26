import type {ChatMessage} from './client';
import {UUID,hasControl} from './messageSchema';

/** Chat protocol version this client speaks. v2 adds the optional `v` and
 * `event` fields to a chat message; v1 clients (0.4.10 and earlier) ignore
 * both, store the message whole and show its `text`. */
export const CHAT_VERSION=2;
/** A change to an earlier message, carried as an ordinary chat message (so it
 * gets the message path's outbox, retries, receipts and replay protection).
 * Its `text` is the fallback a client that does not know the event shows.
 * Only 'reaction' exists now; 'edit' and 'delete' slot in as further members,
 * each naming its `target` message. */
export type ReactionEvent={type:'reaction';target:string;emoji:string;op:'add'|'remove'};
export type ChatEvent=ReactionEvent;
/** The fields v2 adds to a chat message. */
export type ChatExtensions={v?:number;event?:ChatEvent};

const PICTOGRAPHIC=/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
/** A single short emoji: a modified client cannot turn reactions into free text. */
export function validEmoji(value:unknown):value is string{
 if(typeof value!=='string'||!value||[...value].length>8||new TextEncoder().encode(value).length>32||hasControl(value)||/\s/.test(value))return false;
 return PICTOGRAPHIC.test(value)&&!/[\p{L}\p{P}]/u.test(value.replace(/[0-9#*]️?⃣/gu,''));
}
const exact=(value:object,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
/** A well formed event of a type this client knows, or undefined. */
export function parseEvent(value:unknown):ChatEvent|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const e=value as ReactionEvent;
 if(e.type==='reaction')return typeof e.target==='string'&&UUID.test(e.target)&&validEmoji(e.emoji)&&(e.op==='add'||e.op==='remove')&&exact(e,['type','target','emoji','op'])?{type:'reaction',target:e.target,emoji:e.emoji,op:e.op}:undefined;
 return undefined;
}
/** The extensions of a message that this client understands. Lenient by
 * design: an invalid or unknown extension is dropped (the message then counts
 * as a plain message showing its text), never a reason to refuse the message
 * or to fail loading history. Core fields are checked by validChatMessage. */
export function parseExtensions(m:ChatMessage):ChatExtensions{
 const out:ChatExtensions={};
 if(Number.isSafeInteger(m.v)&&(m.v as number)>0)out.v=m.v;
 const event=m.event===undefined?undefined:parseEvent(m.event);
 if(event)out.event=event;
 return out;
}
export const eventOf=(m:ChatMessage)=>parseExtensions(m).event;
/** Carries an extension the message has but this client does not understand. */
export const unknownExtension=(m:ChatMessage)=>m.event!==undefined&&!eventOf(m);
/** Same conversation: both in the channel, or both between the same two people. */
export function sameConversation(a:Pick<ChatMessage,'sender'|'recipient'>,b:Pick<ChatMessage,'sender'|'recipient'>){
 if(a.recipient===null||b.recipient===null)return a.recipient===b.recipient;
 return [a.sender,a.recipient].sort().join('\u0000')===[b.sender,b.recipient].sort().join('\u0000');
}
/** Where an event about `target` is sent: its channel, or the other person of its direct conversation. */
export const eventRecipient=(target:Pick<ChatMessage,'sender'|'recipient'>,user:string)=>target.recipient===null?null:target.sender===user?target.recipient:target.sender;
const quote=(target:Pick<ChatMessage,'text'|'attachments'>)=>{
 const line=target.text.split(/\r?\n/).map(l=>l.trim()).find(Boolean)??target.attachments?.[0]?.name??'';
 const chars=[...line];return chars.length?`"${chars.length>40?`${chars.slice(0,40).join('')}…`:line}"`:'a message';
};
/** What a client without reactions shows for one: "👍 reacted to "Ship it?"". */
export function reactionText(emoji:string,op:'add'|'remove',target:Pick<ChatMessage,'text'|'attachments'>){
 return op==='add'?`${emoji} reacted to ${quote(target)}`:`Removed ${emoji} reaction from ${quote(target)}`;
}
