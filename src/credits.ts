import {invoke} from '@tauri-apps/api/core';
import {postAttention} from './attention';
import {subscribeWorkspaceList} from './remoteExecution/workspaceListCache';

/** Mirrors packages/control-plane/lib/credit-policy.mjs. The server's `policy`
 * wins when it sends one; these keep the app right against an older server. */
export const CREDIT_POLICY={lowUsd:5,zeroUsd:0,finalUsd:-5,cutoffUsd:-10};
export type CreditPolicy=typeof CREDIT_POLICY;
export type CreditStatus='ok'|'low'|'zero'|'final'|'paused';
const ORDER:CreditStatus[]=['ok','low','zero','final','paused'];
export type CreditDebit={occurred_at:string;amount_usd:string;workspace_id:string|null;workspace_name:string|null;description?:string;quantity?:string|null};
export type CreditSession={id:string;workspace_id:string;workspace_name:string;started_at:string;ended_at:string|null;metered_seconds:string|number;consumed_usd:string};
export type WorkspaceUsage={workspace_id:string|null;workspace_name:string|null;usd:string;last_at:string};
/** Add funds (Stripe Checkout) limits, sent when the server supports it. */
export type PurchaseOptions={enabled:boolean;currency?:string;presetsUsd:number[];minUsd:number;maxUsd:number};
/** A credited payment; `reference` is the checkout id. */
export type CreditPurchase={reference:string;amount_usd:string;occurred_at:string};
/** GET /api/credits. Everything after `paymentsEnabled` is newer than some
 * deployed servers, so each field is optional. `paymentsEnabled` is true only
 * when the server has Add funds configured. */
export type Credits={balanceUsd?:string;assignedUsd?:string;balance?:string;paymentsEnabled?:boolean;purchase?:PurchaseOptions;purchases?:CreditPurchase[];status?:CreditStatus;policy?:CreditPolicy;computeAllowed?:boolean;amountToRestoreUsd?:string;enforcement?:'enforce'|'notify'|'off';recentDebits?:CreditDebit[];usageByWorkspace?:WorkspaceUsage[];sessions?:CreditSession[];lastCreditRequestAt?:string|null;creditRequestsEnabled?:boolean};

export const balanceOf=(credits:Credits|null|undefined)=>{if(!credits)return null;const value=credits.balanceUsd??(credits.balance==null?null:Number(credits.balance)/100);const n=value==null||value===''?NaN:Number(value);return Number.isFinite(n)?n:null;};
export function creditStatus(balance:number,policy:CreditPolicy=CREDIT_POLICY):CreditStatus{
 if(balance<=policy.cutoffUsd)return 'paused';if(balance<=policy.finalUsd)return 'final';if(balance<=policy.zeroUsd)return 'zero';if(balance<policy.lowUsd)return 'low';return 'ok';
}
export function statusOf(credits:Credits|null|undefined):CreditStatus|null{
 const balance=balanceOf(credits);if(balance==null)return null;
 return credits?.status&&ORDER.includes(credits.status)?credits.status:creditStatus(balance,credits?.policy??CREDIT_POLICY);
}
/** Smallest cent amount that lifts the balance above the cutoff. */
export function amountToRestore(balance:number,policy:CreditPolicy=CREDIT_POLICY){const owed=policy.cutoffUsd-balance;return owed<0?0:(Math.floor(owed*100+1e-6)+1)/100;}
// A true minus sign, matching the control plane's emails and errors.
export const usd=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value).replace(/^-/,'−');

export type CreditBanner={tone:'warn'|'error';title:string;body:string};
export function creditBanner(credits:Credits|null|undefined):CreditBanner|null{
 const balance=balanceOf(credits),status=statusOf(credits);if(balance==null||!status||status==='ok')return null;
 const policy=credits?.policy??CREDIT_POLICY,cutoff=usd(policy.cutoffUsd),left=usd(Math.max(0,balance-policy.cutoffUsd));
 const more=credits?.paymentsEnabled===true?'Add funds':'Request more credit';
 if(status==='paused'){const restore=Number(credits?.amountToRestoreUsd??amountToRestore(balance,policy));return {tone:'error',title:'Workspaces paused',body:`Your balance is past the ${cutoff} limit, so running workspaces were stopped and new starts are blocked. Add at least ${usd(restore)} to start them again. Your files and settings are kept.`};}
 if(status==='final')return {tone:'error',title:'Final notice',body:`Workspaces pause at ${cutoff}, in about ${left} of running time. ${more} to keep working.`};
 if(status==='zero')return {tone:'warn',title:'Out of credit',body:`You have about ${left} of running time before workspaces pause at ${cutoff}.`};
 return {tone:'warn',title:'Balance running low',body:`Workspaces keep running. They pause if the balance reaches ${cutoff}.`};
}

/** `minimumUsd`: the balance a start needs (the cutoff plus one billing
 * interval), sent when the balance is above the cutoff but too close to it. */
export type CreditExhausted={message:string;balanceUsd:number|null;cutoffUsd:number;shared:boolean;minimumUsd?:number|null};
/** Recognises the control plane's refusal to start compute. Works with a
 * `detailedErrors` response ({code:'credit_exhausted', status:402, ...}), a
 * server that only passes the status, and the plain message. */
export function creditExhaustedFromError(error:unknown):CreditExhausted|null{
 const text=error instanceof Error?error.message:String(error);
 let detail:Record<string,unknown>|null=null;try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object')detail=parsed;}catch{/* plain message */}
 const message=typeof detail?.error==='string'?detail.error:text;
 const matched=detail?.code==='credit_exhausted'||detail?.reason==='credit_exhausted'||detail?.status===402||/Workspaces pause at|past the .{1,12} limit/.test(message);
 if(!matched)return null;
 const balance=Number(detail?.balanceUsd);const cutoff=Number(detail?.cutoffUsd);const minimum=Number(detail?.minimumUsd);
 return {message,balanceUsd:detail?.balanceUsd!=null&&Number.isFinite(balance)?balance:null,cutoffUsd:Number.isFinite(cutoff)&&detail?.cutoffUsd!=null?cutoff:CREDIT_POLICY.cutoffUsd,shared:detail?.shared===true||/owner/.test(message),...(detail?.minimumUsd!=null&&Number.isFinite(minimum)?{minimumUsd:minimum}:{})};
}

const request=<T,>(route:string,body?:unknown)=>invoke<T>('canopy_account_request',{route,body:body??null});
export const openAccountSettings=()=>window.dispatchEvent(new CustomEvent('canopy:open-settings',{detail:{tab:'account'}}));
/** Ask Canopy support for more credit. The server rate-limits to one a day and
 * answers a repeat with the open request. */
export async function requestMoreCredit(note?:string){
 return request<{requested:boolean;duplicate?:boolean;requestedAt?:string;emailed?:boolean}>('/api/credits',{action:'request-credit',...(note?.trim()?{note:note.trim().slice(0,1000)}:{})});
}

export type CheckoutStart={url:string;sessionId:string;amountUsd:string;expiresAt?:string|null};
/** Start a Stripe Checkout for `amountUsd`. The server answers 503 when Add
 * funds isn't configured; the balance is credited by its webhook, not here. */
export async function startCheckout(amountUsd:number){
 return request<CheckoutStart>('/api/credits',{action:'checkout',amountUsd:amountUsd.toFixed(2)});
}
/** Read the balance until the checkout `sessionId` shows up as a credited
 * purchase. Resolves with the credits that include it, or null when `signal`
 * aborts or `timeoutMs` passes (the payment may still arrive later). */
export async function waitForPurchase(sessionId:string,{signal,intervalMs=3000,timeoutMs=15*60_000,onCredits}:{signal?:AbortSignal;intervalMs?:number;timeoutMs?:number;onCredits?:(credits:Credits)=>void}={}){
 const deadline=Date.now()+timeoutMs;
 while(!signal?.aborted&&Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,intervalMs));if(signal?.aborted)break;
  try{const credits=await request<Credits>('/api/credits');onCredits?.(credits);if(credits.purchases?.some(p=>p.reference===sessionId))return credits;}
  catch{/* Offline for a moment; keep waiting. */}
 }
 return null;
}

// Non-blocking in-app warning, once per crossing into a worse level. The level
// last warned about is remembered so a restart doesn't repeat it, and resets
// when the balance recovers so the next crossing warns again.
const warnedKey='canopy.credit-warned-status';
function lastWarned():CreditStatus{try{const v=localStorage.getItem(warnedKey) as CreditStatus|null;return v&&ORDER.includes(v)?v:'ok';}catch{return 'ok';}}
function rememberWarned(status:CreditStatus){try{localStorage.setItem(warnedKey,status);}catch{/* Storage is optional. */}}
export function observeCredits(credits:Credits|null|undefined){
 const status=statusOf(credits);if(!status)return;
 const previous=lastWarned();
 if(ORDER.indexOf(status)<=ORDER.indexOf(previous)){if(status!==previous)rememberWarned(status);return;}
 rememberWarned(status);
 const banner=creditBanner(credits);if(!banner)return;
 postAttention({kind:'fyi',tone:banner.tone==='error'?'error':'warn',title:banner.title,body:`Balance ${usd(balanceOf(credits) as number)}. ${banner.body}`,source:'app',dedupeKey:'canopy-credit-status'});
}

// While managed workspaces are in use, check the balance every few minutes so
// the warning reaches people who never open Settings → Account.
const CHECK_MS=5*60_000;let lastCheck=0,checking=false;
async function check(){
 if(checking||Date.now()-lastCheck<CHECK_MS)return;checking=true;lastCheck=Date.now();
 try{observeCredits(await request<Credits>('/api/credits'));}catch{/* Signed out or offline; the account page reports it. */}
 finally{checking=false;}
}
export function startCreditWatcher(){
 const unsubscribe=subscribeWorkspaceList(snapshot=>{if(snapshot.workspaces.some(w=>w.provider==='lightsail'))void check();});
 const changed=()=>{lastCheck=0;try{localStorage.removeItem(warnedKey);}catch{/* optional */}};
 window.addEventListener('canopy:account-changed',changed);
 return()=>{unsubscribe();window.removeEventListener('canopy:account-changed',changed);};
}
