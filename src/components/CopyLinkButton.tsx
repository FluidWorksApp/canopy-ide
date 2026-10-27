import {useEffect,useRef,useState} from 'react';
import {copyReadableLink,type LinkTarget} from '../readableLinks';
import {Button} from './ui';
import {CheckIcon,CopyIcon} from './icons';
import './copyLink.css';
const COPIED_MS=1600;
/** One click puts the thing's readable Canopy link on the clipboard. No
 *  dialog: the link is allocated on first copy and the same URL comes back
 *  every time after. A failure says why in place (signed out, offline). */
export function CopyLinkButton({target,label='Copy link',className}:{target:LinkTarget;label?:string;className?:string}){
 const [state,setState]=useState<'idle'|'copying'|'copied'>('idle'),[error,setError]=useState(''),timer=useRef<number>(undefined);
 useEffect(()=>()=>window.clearTimeout(timer.current),[]);
 const copy=()=>{setState('copying');setError('');void copyReadableLink(target).then(()=>{setState("copied");timer.current=window.setTimeout(()=>setState("idle"),COPIED_MS);}).catch((e:unknown)=>{setState('idle');setError(e instanceof Error?e.message:String(e));});};
 return <span className={`copy-link${className?` ${className}`:''}`}>
  <Button size="sm" variant="ghost" disabled={state==='copying'} aria-label={state==='copied'?'Link copied':label} title={error||'Copy a link teammates can open'} onClick={copy}>{state==='copied'?<><CheckIcon size={12}/>Copied</>:<><CopyIcon size={12}/>{state==='copying'?'Copying…':label}</>}</Button>
  {error&&<small role="alert" className="copy-link-error">{error}</small>}
 </span>;
}
