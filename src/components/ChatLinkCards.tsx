import {useEffect,useMemo,useState} from 'react';
import * as ipc from '../ipc';
import {openInOsBrowser,openLink} from '../links';
import {getSnapshot as prWatchSnapshot,watchedPaths} from '../prWatchStore';
import {cachedCard,cardLabel,cardRef,cardRepo,cardTargets,checksLabel,compactCard,fetchCard,kindLabel,reviewLabel,STATE_LABEL,type CardLookups,type CardTarget,type LinkCard} from '../chatLinkCards';
import {CommitIcon,GlobeIcon} from './icons';
import './chatLinkCards.css';

/** The app's own gh/git integration, as chatLinkCards asks for it. */
const ipcCardLookups:CardLookups={
 watchedRows:()=>prWatchSnapshot().rows,
 repos:()=>watchedPaths(),
 remoteUrl:repo=>ipc.gitRemoteUrl(repo),
 prs:repo=>ipc.ghPrList(repo),
 prState:(repo,number)=>ipc.ghPrState(repo,number),
 issues:repo=>ipc.ghIssueList(repo),
 issueDetail:(repo,number)=>ipc.ghIssueDetail(repo,number),
 commit:(repo,hash)=>ipc.gitCommitDetail(repo,hash),
};

function PrGlyph(){
 return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="12.5" r="1.75"/><path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5"/><path d="M9 3l-1.5 1.5L9 6"/></svg>;
}

function KindIcon({card}:{card:LinkCard}){
 if(card.link.kind==='commit')return <CommitIcon size={13}/>;
 if(card.link.kind==='issue')return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/></svg>;
 return <PrGlyph/>;
}

/** One card: the whole body opens it natively (the same route as clicking the
 *  link), a second button leaves for the browser. Both are real buttons, so
 *  Tab/Enter/Space work without anything extra. */
export function ChatLinkCard({target,lookups=ipcCardLookups}:{target:CardTarget;lookups?:CardLookups}){
 const [card,setCard]=useState<LinkCard>(()=>cachedCard(target.href)??compactCard(target));
 const [loading,setLoading]=useState(()=>!cachedCard(target.href));
 useEffect(()=>{
  let live=true;
  void fetchCard(target,lookups).then(next=>{if(live){setCard(next);setLoading(false);}});
  return()=>{live=false;};
 },[target,lookups]);
 const checks=checksLabel(card.checks),review=reviewLabel(card.review),label=cardLabel(card);
 const meta=[card.author,checks,review].filter(Boolean);
 return <div className="chat-link-card" data-kind={card.link.kind} data-state={card.state??'unknown'} aria-busy={loading||undefined}>
  <button type="button" className="chat-link-card-main" aria-label={`Open ${label}`} title={card.href} onClick={()=>openLink(card.href,false,{anyProject:true})}>
   <span className="chat-link-card-icon"><KindIcon card={card}/></span>
   <span className="chat-link-card-body">
    <span className="chat-link-card-head">
     <span className="chat-link-card-ref">{cardRepo(card)} {cardRef(card)}</span>
     {card.state&&<span className={`chat-link-card-state is-${card.state}`}>{STATE_LABEL[card.state]}</span>}
    </span>
    <span className="chat-link-card-title">{card.title??kindLabel(card)}</span>
    {meta.length>0&&<span className="chat-link-card-meta">{card.author&&<span>{card.author}</span>}{checks&&<span className={`chat-link-card-checks is-${(card.checks??'').toLowerCase()}`} title={card.checksSummary||undefined}>{checks}</span>}{review&&<span>{review}</span>}</span>}
   </span>
  </button>
  <button type="button" className="chat-link-card-browser" aria-label={`Open ${kindLabel(card).toLowerCase()} ${cardRef(card)} in browser`} title="Open in browser" onClick={()=>openInOsBrowser(card.href)}><GlobeIcon size={12}/></button>
 </div>;
}

/** Cards for the PR, issue and commit links in one message — at most three,
 *  derived from the text, nothing sent or stored. */
export function ChatLinkCards({text,lookups}:{text:string;lookups?:CardLookups}){
 const targets=useMemo(()=>cardTargets(text),[text]);
 if(!targets.length)return null;
 return <div className="chat-link-cards" role="group" aria-label="Linked pull requests, issues and commits">
  {targets.map(t=><ChatLinkCard key={t.href} target={t} lookups={lookups}/>)}
 </div>;
}
