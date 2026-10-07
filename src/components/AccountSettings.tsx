import {clearTeamSessions} from '../teamMessaging/session';
import './accountSettings.css';
import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button} from './ui';
import {FilesIcon,TeamIcon} from './icons';
import {IconClock} from '../../shared/icons';
import {openInOsBrowser} from '../links';
type User={email:string;name:string};
// Amounts are US dollars. `balance` (credits, 1 = 1 cent) is only sent by
// servers from before the dollar migration; the app outlives server deploys.
type Credits={balanceUsd?:string;assignedUsd?:string;balance?:string;paymentsEnabled?:boolean};
const dollars=(value:unknown)=>{if(value==null||value==='')return '—';const n=Number(value);return Number.isFinite(n)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n):'—';};
let accountCache:{user:User;credits:Credits|null}|null=null;
let cacheEpoch=0;
window.addEventListener('canopy:account-changed',()=>{accountCache=null;cacheEpoch++;});
const unauthorized=(error:unknown)=>/unauthorized|not signed in|sign in required|\b40[13]\b/i.test(String(error));
const request=<T,>(route:string,body?:unknown)=>invoke<T>('canopy_account_request',{route,body:body??null});
// The last balance seen for an account, so the card shows a value at once and
// refreshes it, instead of an empty box. Display only; never used for charging.
const balanceKey=(email:string)=>`canopy.account-balance:${email}`;
function rememberedBalance(email:string):Credits|null{try{const saved=JSON.parse(localStorage.getItem(balanceKey(email))??'null');return typeof saved?.balanceUsd==='string'?{balanceUsd:saved.balanceUsd,paymentsEnabled:saved.paymentsEnabled}:null;}catch{return null;}}
function rememberBalance(email:string,credits:Credits){const balanceUsd=credits.balanceUsd??(credits.balance==null?undefined:String(Number(credits.balance)/100));if(balanceUsd==null)return;try{localStorage.setItem(balanceKey(email),JSON.stringify({balanceUsd,paymentsEnabled:credits.paymentsEnabled}));}catch{/* Storage is optional. */}}
function base64url(bytes:Uint8Array){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function AccountSettings({onTeams,onWorkspaces}:{onTeams?:()=>void;onWorkspaces?:()=>void}={}){
 const [user,setUser]=useState<User|null>(accountCache?.user??null),[credits,setCredits]=useState<Credits|null>(accountCache?.credits??null);
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[code,setCode]=useState('');
 const generation=useRef(0);
 const [loading,setLoading]=useState(true);
 const [balanceStale,setBalanceStale]=useState(false);
 const [balanceRefreshing,setBalanceRefreshing]=useState(false);
 useEffect(()=>{if(!user)return;let stopped=false;let pending=false;const remembered=rememberedBalance(user.email);setCredits(current=>current??remembered);setBalanceRefreshing(true);const refresh=async()=>{if(pending||document.hidden)return;pending=true;const epoch=cacheEpoch;try{const next=await request<Credits>('/api/credits');if(!stopped&&epoch===cacheEpoch){setCredits(next);rememberBalance(user.email,next);if(accountCache?.user.email===user.email)accountCache={user,credits:next};setBalanceStale(false);}}catch{if(!stopped&&epoch===cacheEpoch)setBalanceStale(true);}finally{pending=false;if(!stopped)setBalanceRefreshing(false);}};void refresh();const timer=setInterval(()=>void refresh(),10000);window.addEventListener('focus',refresh);return()=>{stopped=true;clearInterval(timer);window.removeEventListener('focus',refresh);};},[user?.email]);
 useEffect(()=>{
  let alive=true;
  const refresh=async()=>{
   const current=++generation.current,epoch=cacheEpoch;setLoading(true);
   try{
    const result=await request<{user:User}>('/api/me');
    if(!alive||current!==generation.current||epoch!==cacheEpoch)return;
    const retained=accountCache?.user.email===result.user.email?accountCache.credits:null;
    accountCache={user:result.user,credits:retained};setUser(result.user);setCredits(retained);setMessage('');
   }catch(error){
    if(!alive||current!==generation.current||epoch!==cacheEpoch)return;
    if(unauthorized(error)){accountCache=null;setUser(null);setCredits(null);}
    else setMessage('Account could not refresh. Please try again.');
   }finally{if(alive&&current===generation.current&&epoch===cacheEpoch)setLoading(false);}
  };
  const changed=()=>{setUser(null);setCredits(null);void refresh();};
  void refresh();window.addEventListener('canopy:account-changed',changed);
  return()=>{alive=false;generation.current++;window.removeEventListener('canopy:account-changed',changed);};
 },[]);
 async function signIn(){
  const current=++generation.current;setBusy(true);setMessage('Opening secure sign-in…');
  try{
   const verifier=base64url(crypto.getRandomValues(new Uint8Array(48)));
   const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
   const pairing=await request<{id:string;verificationUrl:string;expiresIn:number}>('/api/device',{action:'start',challenge,deviceName:'Canopy desktop'});
   if(current!==generation.current)return;
   const url=new URL(pairing.verificationUrl);
   if(url.origin!=='https://canopyide.dev'||url.pathname!=='/connect')throw Error('Invalid sign-in destination');
   setCode(pairing.id.slice(0,8).toUpperCase());openInOsBrowser(url.href);setMessage('Finish signing in in your browser. Match the request code before connecting.');
   const deadline=Date.now()+Math.min(pairing.expiresIn,600)*1000;
   while(current===generation.current&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,3000));if(current!==generation.current)return;
    const result=await request<{status:string}>('/api/device',{action:'poll',id:pairing.id,verifier});
    if(current!==generation.current)return;
    if(result.status==='expired')throw Error('Sign-in expired. Please try again.');
    if(result.status==='approved'){
     const account=await request<{user:User}>('/api/me');if(current!==generation.current)return;
     clearTeamSessions();window.dispatchEvent(new Event('canopy:account-changed'));accountCache={user:account.user,credits:null};setUser(account.user);setLoading(false);setBusy(false);setCode('');setMessage('Signed in.');return;
    }
   }
   if(current===generation.current)throw Error('Sign-in expired. Please try again.');
  }catch(error){if(current===generation.current)setMessage(String(error));}
  finally{if(current===generation.current)setBusy(false);}
 }
 if(loading&&!user)return <section className="account-settings" aria-busy="true" aria-label="Loading account"><div className="account-profile"><span className="account-avatar account-shimmer"/><div><div className="account-shimmer account-skeleton-name"/><div className="account-shimmer account-skeleton-email"/></div></div><div className="account-balance"><div className="account-shimmer account-skeleton-label"/><div className="account-shimmer account-skeleton-amount"/></div><p role="status">Loading your account…</p></section>;
 return <section className="account-settings" aria-busy={loading}>
  <header className="account-profile"><span className="account-avatar" aria-hidden="true">{user?(user.name||user.email).slice(0,1).toUpperCase():'⌂'}</span><div><h3>{user?.name||'Your Canopy account'}</h3><p className="set-desc">{user?user.email:'Sign in to access your workspaces and team.'}</p></div>{user&&<nav className="account-header-actions" aria-label="Account actions">
   <Button icon variant="ghost" className="account-header-action" aria-label="Workspaces & plans" title="Workspaces & plans" onClick={()=>onWorkspaces?onWorkspaces():window.dispatchEvent(new Event('canopy:open-workspaces'))}><FilesIcon size={20}/><span className="account-action-tooltip">Workspaces & plans</span></Button>
   <Button icon variant="ghost" className="account-header-action" aria-label="Teams & members" title="Teams & members" onClick={()=>onTeams?onTeams():openInOsBrowser('https://canopyide.dev/teams')}><TeamIcon size={20}/><span className="account-action-tooltip">Teams & members</span></Button>
   <Button icon variant="ghost" className="account-header-action" aria-label="Usage history" title="Usage history" onClick={()=>openInOsBrowser('https://canopyide.dev/workspaces#history')}><IconClock size={20}/><span className="account-action-tooltip">Usage history</span></Button>
   <Button icon variant="ghost" className="account-header-action" aria-label="Sign out" title="Sign out" disabled={busy} onClick={()=>{setBusy(true);void request('/api/device',{action:'revoke'}).then(()=>{clearTeamSessions();window.dispatchEvent(new Event('canopy:account-changed'));setUser(null);setCredits(null);setMessage('Signed out.');}).catch(error=>setMessage(String(error))).finally(()=>setBusy(false));}}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4H4v16h5M14 7l5 5-5 5M8 12h11"/></svg><span className="account-action-tooltip">Sign out</span></Button></nav>}</header>
  {loading&&user&&<p role="status">Refreshing your account…</p>}
  {user?<>
   <div className="account-balance"><span>Available balance <small>USD</small></span><strong>{credits?dollars(credits.balanceUsd??(credits.balance==null?null:Number(credits.balance)/100)):<span className="account-balance-loading" role="status"><span className="account-shimmer account-skeleton-amount"/>Loading balance…</span>}</strong><p>{balanceStale ? "Balance could not refresh. Showing the last available amount." : balanceRefreshing&&credits ? "Updating…" : "Shared across your workspaces. Usage is charged per minute."}</p>{credits?.paymentsEnabled===false&&<small>Adding funds is not available during preview.</small>}</div>

  </>:<div className="set-inline"><Button disabled={busy} onClick={()=>void signIn()}>{busy?'Waiting for sign-in…':'Sign in or create account'}</Button>{busy&&<Button onClick={()=>{generation.current++;setBusy(false);setCode('');setMessage('Sign-in cancelled.');}}>Cancel</Button>}</div>}
  {code&&<p>Request code: <strong>{code}</strong></p>}
  {message&&<p role="status" aria-live="polite">{message}</p>}
  <p className="set-desc">Bring your own agents and subscriptions. Your balance covers workspace running time.</p>
 </section>;
}
