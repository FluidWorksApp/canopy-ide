import type {ChatMessage} from './client';
import {UUID,hasControl} from './messageSchema';
import {parseCard,type Card} from './cardSchema';

/** Chat protocol version this client speaks.
 * - v1 (0.4.9 and earlier): plain messages.
 * - v2 (0.4.10): adds `v` and `event`, with reactions as the only event type.
 *   An event type a v2 client does not know shows as its fallback text, as a
 *   new (notifying) message.
 * - v3 (0.4.11): edit and delete events, `thread`, `mentions`/`mentionsAll`,
 *   read receipts and backfill. Edits and deletes go only to v3 devices. */
export const CHAT_VERSION=3;
/** Lowest version that understands reactions. */
export const REACTIONS_VERSION=2;
/** Lowest version that understands edits, deletes, read receipts and backfill. */
export const EDITS_VERSION=3;
/** A change to an earlier message, carried as an ordinary chat message (so it
 * gets the message path's outbox, retries, receipts and replay protection).
 * Its `text` is the fallback a client that does not know the event shows.
 * Each event names its `target` message. */
export type ReactionEvent={type:'reaction';target:string;emoji:string;op:'add'|'remove'};
export type EditEvent={type:'edit';target:string;text:string;mentions?:string[]};
export type DeleteEvent={type:'delete';target:string};
export type ChatEvent=ReactionEvent|EditEvent|DeleteEvent;
/** A reply in a thread: `root` is the first message of the thread. */
export type ThreadRef={root:string};
/** The fields v2 and v3 add to a chat message. */
export type ChatExtensions={v?:number;event?:ChatEvent;thread?:ThreadRef;mentions?:string[];mentionsAll?:true;card?:Card};
/** The lowest chat version a device needs to receive an event of this type. */
export const eventVersion=(event:ChatEvent)=>event.type==='reaction'?REACTIONS_VERSION:EDITS_VERSION;

/** How far back an author may backfill a message, and how far ahead of its
 * envelope a backfilled message may be dated. */
export const BACKFILL_MS=7*86_400_000,BACKFILL_SKEW_MS=30_000;
/** Bounds of the v3 fields. */
export const MAX_MENTIONS=50,MAX_TEXT_BYTES=16000;
/** Bidirectional overrides and isolates (and the marks that steer them): in a
 * user id or a name they can make one person's id render as another's. */
const BIDI=/[؜‎‏‪-‮⁦-⁩]/;
export const hasBidi=(value:string)=>BIDI.test(value);
/** An account id as it may appear in a v3 field: what `validChatMessage`
 * accepts for `sender`, minus control and bidi characters. */
export const validUserId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!hasControl(value)&&!hasBidi(value);
const validText=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&new TextEncoder().encode(value).length<=MAX_TEXT_BYTES;
/** A bounded list of distinct account ids. */
export function parseMentions(value:unknown):string[]|undefined{
 if(!Array.isArray(value)||!value.length||value.length>MAX_MENTIONS||!value.every(validUserId))return undefined;
 return new Set(value).size===value.length?[...value]:undefined;
}

const PICTOGRAPHIC=/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
/** A single short emoji: a modified client cannot turn reactions into free text. */
export function validEmoji(value:unknown):value is string{
 if(typeof value!=='string'||!value||[...value].length>8||new TextEncoder().encode(value).length>32||hasControl(value)||/\s/.test(value))return false;
 return PICTOGRAPHIC.test(value)&&!/[\p{L}\p{P}]/u.test(value.replace(/[0-9#*]️?⃣/gu,''));
}
const exact=(value:object,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validTarget=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);
/** A well formed event of a type this client knows, or undefined. */
export function parseEvent(value:unknown):ChatEvent|undefined{
 if(!plain(value))return undefined;
 const e=value;
 if(e.type==='reaction')return validTarget(e.target)&&validEmoji(e.emoji)&&(e.op==='add'||e.op==='remove')&&exact(e,['type','target','emoji','op'])?{type:'reaction',target:e.target,emoji:e.emoji,op:e.op}:undefined;
 if(e.type==='edit'){
  if(!validTarget(e.target)||!validText(e.text)||!exact(e,['type','target','text','mentions']))return undefined;
  if(e.mentions===undefined)return {type:'edit',target:e.target,text:e.text};
  const mentions=parseMentions(e.mentions);return mentions?{type:'edit',target:e.target,text:e.text,mentions}:undefined;
 }
 if(e.type==='delete')return validTarget(e.target)&&exact(e,['type','target'])?{type:'delete',target:e.target}:undefined;
 return undefined;
}
export function parseThread(value:unknown):ThreadRef|undefined{
 return plain(value)&&validTarget(value.root)&&exact(value,['root'])?{root:value.root}:undefined;
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
 // An event is never itself a reply or a mention: those belong to messages.
 if(m.event!==undefined)return out;
 const thread=m.thread===undefined?undefined:parseThread(m.thread);
 if(thread&&thread.root!==m.id)out.thread=thread;
 const mentions=m.mentions===undefined?undefined:parseMentions(m.mentions);
 if(mentions)out.mentions=mentions;
 if(m.mentionsAll===true&&m.recipient===null)out.mentionsAll=true;
 const card=m.card===undefined?undefined:parseCard(m.card);if(card)out.card=card;
 return out;
}
export const eventOf=(m:ChatMessage)=>parseExtensions(m).event;
export const threadOf=(m:ChatMessage)=>parseExtensions(m).thread;
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
/** Cuts `text` to at most `bytes` UTF-8 bytes on a code point boundary. */
function clip(text:string,bytes:number){
 const encoder=new TextEncoder();if(encoder.encode(text).length<=bytes)return text;
 let out='',size=0;for(const ch of text){const n=encoder.encode(ch).length;if(size+n>bytes-3)break;out+=ch;size+=n;}
 return out+'…';
}
/** Fallback text of an edit: "✎ edited: <new text>", within the message bound. */
export const editText=(text:string)=>clip(`✎ edited: ${text}`,MAX_TEXT_BYTES);
/** Fallback text of a delete. It never quotes the deleted message: the event
 * is kept for weeks, the message itself is not. */
export const DELETE_TEXT='🗑 Deleted a message';
