import {useEffect,useRef,useState,type ReactNode} from 'react';
import {QUICK_REACTIONS,validEmoji,type ReactionChip} from '../teamMessaging/reactions';

/** "You, Ada and Grace": who is behind one chip. */
function reactorNames(users:string[],name:(id:string)=>string){
 const names=users.map(name).sort((a,b)=>Number(b==='You')-Number(a==='You'));
 return names.length<=1?names.join(''):`${names.slice(0,-1).join(', ')} and ${names.at(-1)}`;
}
/** Hover/focus button that opens the picker for one message. */
export function AddReactionButton({open,onToggle,className,controls}:{open:boolean;onToggle:()=>void;className?:string;controls:string}){
 return <button type="button" className={`account-chat-react${className?` ${className}`:''}${open?' is-open':''}`} aria-label="Add reaction" title="Add reaction" aria-expanded={open} aria-controls={open?controls:undefined}
  onMouseDown={e=>e.preventDefault()} onClick={onToggle}>☺︎+</button>;
}
/** The quick set plus a free emoji field. Escape closes it (the caller puts focus
 * back on its button); moving focus out of it dismisses it. */
export function ReactionPicker({id,onPick,onClose,onDismiss}:{id:string;onPick:(emoji:string)=>void;onClose:()=>void;onDismiss?:()=>void}){
 const [custom,setCustom]=useState(''),first=useRef<HTMLButtonElement>(null);
 useEffect(()=>{first.current?.focus({preventScroll:true});},[]);
 const trimmed=custom.trim(),ok=validEmoji(trimmed);
 return <div id={id} className="account-chat-picker" role="dialog" aria-label="Add reaction"
  onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();}}}
  // Focus leaving the picker (a click elsewhere, Tab past its end) dismisses it.
  onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))onDismiss?.();}}>
  <div className="account-chat-picker-quick">
   {QUICK_REACTIONS.map((emoji,i)=><button key={emoji} ref={i===0?first:undefined} type="button" aria-label={`React with ${emoji}`} title={emoji} onMouseDown={e=>e.preventDefault()} onClick={()=>onPick(emoji)}>{emoji}</button>)}
  </div>
  <form className="account-chat-picker-custom" onSubmit={e=>{e.preventDefault();if(ok)onPick(trimmed);}}>
   <input aria-label="Any emoji" value={custom} onChange={e=>setCustom(e.target.value)} placeholder="Any emoji" aria-invalid={!!trimmed&&!ok} maxLength={32} autoComplete="off" spellCheck={false}/>
   <button type="submit" className="account-chat-action" disabled={!ok}>Add</button>
  </form>
 </div>;
}
/** Grouped reactions under a message: one button per emoji, yours highlighted. */
/** Shown on your own reaction when no device in the conversation could receive it. */
const UNDELIVERED_NOTE='Not delivered: teammates need Canopy 0.4.10 or later to see reactions';
export function MessageReactions({chips,name,onToggle,picker,undelivered=[]}:{chips:ReactionChip[];name:(id:string)=>string;onToggle:(emoji:string)=>void;picker?:ReactNode;undelivered?:readonly string[]}){
 if(!chips.length&&!picker)return null;
 return <div className="account-chat-reactions" role="group" aria-label="Reactions">
  {chips.map(chip=>{
   const who=reactorNames(chip.users,name),action=chip.mine?'remove your reaction':'add your reaction';
   const lost=chip.mine&&undelivered.includes(chip.emoji),note=lost?`. ${UNDELIVERED_NOTE}`:'';
   return <button key={chip.emoji} type="button" className={`account-chat-reaction${chip.mine?' is-mine':''}${lost?' is-undelivered':''}`} aria-pressed={chip.mine}
    aria-label={`${chip.emoji} ${chip.count} ${chip.count===1?'reaction':'reactions'} from ${who}; ${action}${note}`} title={`${who} reacted with ${chip.emoji}${note}`}
    onMouseDown={e=>e.preventDefault()} onClick={()=>onToggle(chip.emoji)}>
    <span aria-hidden="true">{chip.emoji}</span><span className="account-chat-reaction-count" aria-hidden="true">{chip.count}</span>
   </button>;
  })}
  {picker}
 </div>;
}
