import {useEffect,useMemo,useState,type KeyboardEvent,type RefObject} from 'react';
import {parseMentions} from '../teamMessaging/chatEvents';

/** "5m", "2h", "3d": how long ago, for "N replies · 5m". */
export function ago(t:number,now=Date.now()){
 const s=Math.max(0,Math.round((now-t)/1000));
 return s<60?'now':s<3600?`${Math.floor(s/60)}m`:s<86_400?`${Math.floor(s/3600)}h`:`${Math.floor(s/86_400)}d`;
}
/** "Ada", "Ada and Sam", "Ada, Sam and 2 others". */
export function namesList(names:string[],max=3){
 if(names.length<=1)return names.join('');
 if(names.length<=max)return `${names.slice(0,-1).join(', ')} and ${names.at(-1)}`;
 return `${names.slice(0,max-1).join(', ')} and ${names.length-max+1} others`;
}

/** Who a message names: team members written as `@Name`, and `@channel` in a channel. */
export function mentionsFor(text:string,members:Record<string,string>,self:string,peer:string|null){
 const ids=Object.entries(members).filter(([id,name])=>id!==self&&!!name&&(peer===null||id===peer)&&new RegExp(`(^|\\s)@${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|[\\s.,!?:;])`).test(text)).map(([id])=>id);
 return {mentions:parseMentions(ids.slice(0,50)),mentionsAll:peer===null&&/(^|\s)@(channel|everyone)(?=$|[\s.,!?:;])/.test(text)};
}
export type Suggestion={id:string;label:string;insert:string};
/** @ autocomplete for a composer: suggestions for the `@word` before the caret. */
export function useMentionSuggestions(draft:string,setDraft:(value:string)=>void,input:RefObject<HTMLTextAreaElement|null>,members:Record<string,string>,self:string,peer:string|null){
 const [caret,setCaret]=useState(0),[active,setActive]=useState(0),[closed,setClosed]=useState('');
 const token=useMemo(()=>/(?:^|\s)@([^\s@]{0,30})$/.exec(draft.slice(0,caret))?.[1],[draft,caret]);
 const suggestions=useMemo<Suggestion[]>(()=>{
  if(token===undefined||closed===`${caret}:${token}`)return [];
  const q=token.toLowerCase();
  const people=Object.entries(members).filter(([id,name])=>id!==self&&!!name&&(peer===null||id===peer)&&name.toLowerCase().includes(q)).map(([id,name])=>({id,label:name,insert:`@${name} `}));
  const all=peer===null&&'channel'.startsWith(q)?[{id:'#channel',label:'channel · everyone here',insert:'@channel '}]:[];
  return [...people,...all].slice(0,8);
 },[token,members,self,peer,closed,caret]);
 useEffect(()=>setActive(0),[token]);
 const track=()=>setCaret(input.current?.selectionStart??draft.length);
 const pick=(s:Suggestion)=>{
  const at=draft.slice(0,caret).lastIndexOf('@');if(at<0)return;
  const next=draft.slice(0,at)+s.insert+draft.slice(caret);setDraft(next);
  const pos=at+s.insert.length;setCaret(pos);
  requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(pos,pos);});
 };
 /** Handles the key when the list is open; true when it did. */
 const onKeyDown=(e:KeyboardEvent<HTMLTextAreaElement>)=>{
  if(!suggestions.length)return false;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setActive(a=>(a+(e.key==='ArrowDown'?1:suggestions.length-1))%suggestions.length);return true;}
  if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();pick(suggestions[active]);return true;}
  if(e.key==='Escape'){e.preventDefault();setClosed(`${caret}:${token}`);return true;}
  return false;
 };
 return {suggestions,active,pick,track,onKeyDown};
}
