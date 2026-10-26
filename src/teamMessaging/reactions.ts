import type {ChatMessage} from './client';
import {eventOf,sameConversation} from './chatEvents';
export {validEmoji} from './chatEvents';

/** One person's latest word on one emoji of one message. `on:false` is kept
 * (a tombstone) so an older add arriving later cannot bring it back. */
export type ReactionEntry={sender:string;emoji:string;on:boolean;created:number;id:string};
/** Reactions by target message id, then by `reactionKey(sender, emoji)`. */
export type ReactionState=Record<string,Record<string,ReactionEntry>>;
/** An event whose target message is not loaded yet, and when it arrived here. */
export type PendingEvent={message:ChatMessage;at:number};
/** The current text of an edited message: the latest edit by (created, id). */
export type EditEntry={text:string;mentions?:string[];created:number;id:string};
/** A deleted message: the delete event that removed it. Final; nothing undoes it. */
export type DeleteEntry={created:number;id:string};
/** Everything chat events change about the conversation, laid over its messages. */
export type EventOverlay={reactions:ReactionState;edits:Record<string,EditEntry>;deleted:Record<string,DeleteEntry>;pending:PendingEvent[]};
export type ReactionChip={emoji:string;count:number;users:string[];mine:boolean};

export const EMPTY_OVERLAY:EventOverlay=Object.freeze({reactions:Object.freeze({}) as ReactionState,edits:Object.freeze({}) as Record<string,EditEntry>,deleted:Object.freeze({}) as Record<string,DeleteEntry>,pending:Object.freeze([]) as unknown as PendingEvent[]});
/** One-click set under every message. */
export const QUICK_REACTIONS=['👍','❤️','😂','🎉','👀','✅'] as const;
/** Distinct (sender, emoji) entries kept per message. */
export const MAX_REACTION_ENTRIES=256;
/** Events waiting for their message: at most this many, for at most this long
 * (a person envelope lives five minutes, so a later target is not coming). */
export const MAX_PENDING_EVENTS=200,PENDING_MS=10*60_000;

export const reactionKey=(sender:string,emoji:string)=>JSON.stringify([sender,emoji]);
/** Last write wins, ordered by (created, event id) so every device agrees. */
export const newer=(next:{created:number;id:string},prior?:{created:number;id:string})=>!prior||next.created>prior.created||(next.created===prior.created&&next.id>prior.id);

/** Folds one event into the overlay given its loaded target. */
function reduce(overlay:EventOverlay,event:ChatMessage,target:ChatMessage):EventOverlay{
 const e=eventOf(event);
 // The event must belong to its target's conversation, so nobody can mark a
 // direct conversation they are not part of by naming one of its message ids.
 if(!e||e.target!==target.id||!sameConversation(event,target))return overlay;
 if(e.type==='reaction'){const reactions=reduceReaction(overlay.reactions,event,target);return reactions===overlay.reactions?overlay:{...overlay,reactions};}
 // Only a message's author edits or deletes it. `sender` was bound to the
 // envelope's authenticated signing account on receipt, never taken on trust.
 if(event.sender!==target.sender)return overlay;
 if(e.type==='delete'){
  if(overlay.deleted[target.id])return overlay;
  // The deleted text goes with it: an edit kept around would still show it.
  const {[target.id]:_edit,...edits}=overlay.edits;
  return {...overlay,edits:_edit?edits:overlay.edits,deleted:{...overlay.deleted,[target.id]:{created:event.created,id:event.id}}};
 }
 if(overlay.deleted[target.id])return overlay;
 const entry:EditEntry={text:e.text,...(e.mentions?{mentions:e.mentions}:{}),created:event.created,id:event.id};
 if(!newer(entry,overlay.edits[target.id]))return overlay;
 return {...overlay,edits:{...overlay.edits,[target.id]:entry}};
}
function reduceReaction(reactions:ReactionState,event:ChatMessage,target:ChatMessage):ReactionState{
 const e=eventOf(event);
 if(!e||e.type!=='reaction')return reactions;
 // `sender` was authenticated against the envelope's signing device on receipt.
 const entry:ReactionEntry={sender:event.sender,emoji:e.emoji,on:e.op==='add',created:event.created,id:event.id};
 const key=reactionKey(entry.sender,entry.emoji),current=reactions[target.id]??{},prior=current[key];
 if(!newer(entry,prior))return reactions;
 if(!prior&&Object.keys(current).length>=MAX_REACTION_ENTRIES){
  const [oldestKey,oldest]=Object.entries(current).sort(([,a],[,b])=>a.created-b.created)[0];
  if(oldest.created>entry.created)return reactions;
  const {[oldestKey]:_dropped,...rest}=current;return {...reactions,[target.id]:{...rest,[key]:entry}};
 }
 return {...reactions,[target.id]:{...current,[key]:entry}};
}
/** Folds one event message into the overlay, returning `overlay` itself when
 * nothing changed. `find` looks up loaded messages by id; an event whose target
 * is not loaded waits in `pending`. */
export function applyEvent(overlay:EventOverlay,event:ChatMessage,find:(id:string)=>ChatMessage|undefined,now=Date.now()):EventOverlay{
 const e=eventOf(event);if(!e)return overlay;
 const target=find(e.target);
 if(target)return reduce(overlay,event,target);
 if(overlay.pending.some(p=>p.message.id===event.id))return overlay;
 const pending=[...overlay.pending.filter(p=>now-p.at<=PENDING_MS),{message:event,at:now}].slice(-MAX_PENDING_EVENTS);
 return {...overlay,pending};
}
/** Applies waiting events whose target has now loaded, and drops expired ones. */
export function drainPending(overlay:EventOverlay,find:(id:string)=>ChatMessage|undefined,now=Date.now()):EventOverlay{
 if(!overlay.pending.length)return overlay;
 let next:EventOverlay=overlay;const pending:PendingEvent[]=[];
 for(const p of overlay.pending){
  const target=find(eventOf(p.message)?.target??'');
  if(target)next=reduce(next,p.message,target);else if(now-p.at<=PENDING_MS)pending.push(p);
 }
 return next===overlay&&pending.length===overlay.pending.length?overlay:{...next,pending};
}
/** The text a message shows: its latest edit, or its own. */
export const currentText=(overlay:Pick<EventOverlay,'edits'>,message:ChatMessage)=>overlay.edits[message.id]?.text??message.text;
/** Chips for one message, in the order each emoji was first added. */
export function reactionChips(reactions:ReactionState,messageId:string,user:string):ReactionChip[]{
 const entries=reactions[messageId];if(!entries)return [];
 const chips=new Map<string,{chip:ReactionChip;first:number}>();
 for(const e of Object.values(entries)){
  if(!e.on)continue;
  const found=chips.get(e.emoji)??{chip:{emoji:e.emoji,count:0,users:[],mine:false},first:e.created};
  found.chip.count++;found.chip.users.push(e.sender);found.chip.mine||=e.sender===user;found.first=Math.min(found.first,e.created);
  chips.set(e.emoji,found);
 }
 return [...chips.values()].sort((a,b)=>a.first-b.first||a.chip.emoji.localeCompare(b.chip.emoji)).map(({chip})=>chip);
}
/** Whether `user` currently has `emoji` on the message. */
export const hasReacted=(reactions:ReactionState,messageId:string,user:string,emoji:string)=>!!reactions[messageId]?.[reactionKey(user,emoji)]?.on;
/** The `created` for this account's next change to one reaction: strictly after
 * its last one, so a quick toggle never loses to its predecessor. */
export const nextReactionTime=(reactions:ReactionState,messageId:string,user:string,emoji:string,now=Date.now())=>Math.max(now,(reactions[messageId]?.[reactionKey(user,emoji)]?.created??0)+1);
