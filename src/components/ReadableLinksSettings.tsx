import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from './ui';
import {CheckIcon,CopyIcon} from './icons';
import {describeLink,listReadableLinks,revokeReadableLink,type ManagedLink} from '../readableLinks';
import {writeClipboardText} from '../terminalClipboard';
import {notOnServerYet} from '../accountErrors';
import './readableLinksSettings.css';

const shortDate=(iso:string|null|undefined)=>{if(!iso)return '';const at=new Date(iso);return Number.isNaN(at.getTime())?'':at.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});};
const reason=(error:unknown)=>String(error instanceof Error?error.message:error).replace(/^Error:\s*/,'');

/** Settings → Account → Links: every readable link this account manages
 *  (readableLinks.ts), with Copy, Open and Revoke. Revoke is offered only where
 *  the server says this person may: their own links, links on workspaces they
 *  own, and team links when they own or administer the team. */
export function ReadableLinksSettings(){
 const [links,setLinks]=useState<ManagedLink[]|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 // Waiting on canopyide.dev, not broken: said quietly, never as an error.
 const [pending,setPending]=useState(false);
 const [copied,setCopied]=useState<string|null>(null),[confirm,setConfirm]=useState<string|null>(null),[revoking,setRevoking]=useState<string|null>(null);
 const generation=useRef(0),timer=useRef<number>(undefined);
 const load=useCallback(async()=>{
  const current=++generation.current;setError('');setPending(false);
  try{const next=await listReadableLinks();if(current===generation.current)setLinks(next);}
  catch(e){if(current===generation.current&&notOnServerYet(e)){setLinks(previous=>previous??[]);setPending(true);return;}
   if(current===generation.current){setLinks(previous=>previous??[]);setError(/invalid account request|unknown link action/i.test(reason(e))?'Your Canopy account service does not list links yet.':`Links could not load. ${reason(e)}`);}}
 },[]);
 useEffect(()=>{void load();const changed=()=>{setLinks(null);setConfirm(null);void load();};window.addEventListener('canopy:account-changed',changed);return()=>{generation.current++;window.clearTimeout(timer.current);window.removeEventListener('canopy:account-changed',changed);};},[load]);
 async function copy(url:string){
  setError('');
  if(await writeClipboardText(url)){setCopied(url);window.clearTimeout(timer.current);timer.current=window.setTimeout(()=>setCopied(null),1600);}
  else setError(`Couldn't copy. The link is ${url}`);
 }
 function open(url:string){window.dispatchEvent(new CustomEvent('canopy:follow-deep-link',{detail:{url}}));}
 async function revoke(link:ManagedLink){
  const current=generation.current;setRevoking(link.url);setError('');
  try{await revokeReadableLink(link.url);if(current!==generation.current)return;setLinks(items=>items?.filter(item=>item.url!==link.url)??null);setConfirm(null);setNotice(`Revoked ${describeLink(link).name}. Anyone opening it now sees that it was revoked.`);}
  catch(e){if(current===generation.current)setError(`Couldn't revoke. ${reason(e)}`);}
  finally{if(current===generation.current)setRevoking(null);}
 }
 return <section className="readable-links" aria-labelledby="readable-links-title" aria-busy={links===null&&!error}>
  <div className="readable-links-head"><h4 id="readable-links-title">Links</h4><Button size="sm" variant="ghost" onClick={()=>void load()} disabled={links===null}>Refresh</Button></div>
  <p className="set-desc">Readable links to workspaces, shared sessions and team messages that you made, or that you manage as a workspace owner or team admin. A link only opens for people who already have access.</p>
  {links===null&&!error&&<p className="readable-links-empty">Loading links…</p>}
  {pending&&<p className="readable-links-empty" role="status">Links start working once Canopy's server is updated. Nothing to change on your side.</p>}
  {links&&links.length===0&&!error&&!pending&&<p className="readable-links-empty">No links yet. Use <strong>Copy link</strong> on a workspace, a shared session or a chat message to make one.</p>}
  {links&&links.length>0&&<ul className="readable-links-list">{links.map(link=>{
   const {kind,name,detail}=describeLink(link),when=shortDate(link.about?.activityAt??link.createdAt);
   const activity=when?(link.about?.activity==='opened'?`Last opened ${when}`:`Made ${when}`):'';
   return <li key={link.url}>
    <div className="readable-links-what"><span className="readable-links-kind">{kind}</span><strong>{name}</strong>
     <small>{[detail,activity,link.mine?'Made by you':'Team link'].filter(Boolean).join(' · ')}</small>
     <code title={link.url}>{link.url.replace(/^https:\/\//,'')}</code></div>
    {confirm===link.url
     ?<div className="readable-links-actions" role="group" aria-label={`Revoke ${name}?`}><span>Revoke? It stops working for everyone.</span><Button size="sm" variant="danger" disabled={revoking===link.url} onClick={()=>void revoke(link)}>{revoking===link.url?'Revoking…':'Revoke'}</Button><Button size="sm" variant="ghost" disabled={revoking===link.url} onClick={()=>setConfirm(null)}>Keep</Button></div>
     :<div className="readable-links-actions">
      <Button size="sm" variant="ghost" aria-label={copied===link.url?`Copied link to ${name}`:`Copy link to ${name}`} onClick={()=>void copy(link.url)}>{copied===link.url?<><CheckIcon size={12}/>Copied</>:<><CopyIcon size={12}/>Copy</>}</Button>
      <Button size="sm" variant="ghost" aria-label={`Open ${name}`} onClick={()=>open(link.url)}>Open</Button>
      {link.canRevoke&&<Button size="sm" variant="ghost" aria-label={`Revoke link to ${name}`} onClick={()=>{setNotice('');setConfirm(link.url);}}>Revoke</Button>}
     </div>}
   </li>;})}</ul>}
  {error&&<p role="alert" className="readable-links-error">{error}</p>}
  {notice&&<p role="status" aria-live="polite">{notice}</p>}
 </section>;
}
