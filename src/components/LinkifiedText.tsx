import {Fragment,type MouseEvent} from 'react';
import {openLink} from '../links';

// http(s) URLs in plain text; trailing sentence punctuation stays outside the link.
const URL_PATTERN=/https?:\/\/[^\s<>"'`]+/gi;
const TRAILING=/[.,;:!?'")\]}]+$/;

/** Split text into plain runs and http(s) links. */
export function linkParts(text:string):{text:string;href?:string}[]{
 const parts:{text:string;href?:string}[]=[];let last=0;
 for(const match of text.matchAll(URL_PATTERN)){
  const raw=match[0],href=raw.replace(TRAILING,''),start=match.index??0;
  if(!href.replace(/^https?:\/\//i,''))continue;
  if(start>last)parts.push({text:text.slice(last,start)});
  parts.push({text:href,href});last=start+href.length;
 }
 if(last<text.length)parts.push({text:text.slice(last)});
 return parts;
}

/** Message text with clickable links. Clicks go through openLink (http(s)
 *  only); Cmd/Ctrl-click opens the system browser. Text is never HTML. */
export function LinkifiedText({text}:{text:string}){
 const open=(event:MouseEvent<HTMLAnchorElement>,href:string)=>{event.preventDefault();openLink(href,event.metaKey||event.ctrlKey);};
 return <>{linkParts(text).map((part,index)=>part.href?<a key={index} href={part.href} className="linkified-link" rel="noreferrer noopener" onClick={event=>open(event,part.href!)}>{part.text}</a>:<Fragment key={index}>{part.text}</Fragment>)}</>;
}
