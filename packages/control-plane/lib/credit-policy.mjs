// Credit policy: every threshold that changes what a user is told or allowed
// to do lives here. Amounts are US dollars, compared against
// credit_account.balance_usd. Balances are per user (credit_account.user_id);
// a workspace bills its owner, including time a shared member resumes.
//
//   balance <  LOW_USD     "running low"   reminder email, in-app warning
//   balance <= ZERO_USD    "out of credit" reminder email, in-app warning
//   balance <= FINAL_USD   "final notice"  last email before compute pauses
//   balance <= CUTOFF_USD  "paused"        no workspace starts, resumes or
//                                          resizes; running workspaces are
//                                          hibernated (files kept); email
//
// Pausing only blocks compute. Files, snapshots, settings, the account and
// sign-in are untouched, and nothing is ever deleted for an unpaid balance.
// Blocking and pausing apply only with CANOPY_CREDIT_ENFORCEMENT=enforce
// (enforcementMode below; the default is notify).
// See docs/credits.md.
export const LOW_USD=5;
export const ZERO_USD=0;
export const FINAL_USD=-5;
export const CUTOFF_USD=-10;
export const CREDIT_POLICY=Object.freeze({lowUsd:LOW_USD,zeroUsd:ZERO_USD,finalUsd:FINAL_USD,cutoffUsd:CUTOFF_USD});
// Running time is debited in five-minute intervals (metering.mjs). A start
// must leave room for one of them above the cutoff, so a workspace that starts
// is never paused by its very first debit (assertComputeAllowed).
export const BILLING_INTERVAL_SECONDS=300;
// Most severe last. Each notice is sent once per crossing and re-armed when the
// balance recovers past it (credit-enforcement.mjs).
export const NOTICE_LEVELS=Object.freeze(['low','zero','final','paused']);
// Actions that create or start compute. Stop and delete are never blocked.
export const COMPUTE_ACTIONS=Object.freeze(['resume','retry','resize','grow-storage']);

const number=value=>{const n=typeof value==='number'?value:Number(value);if(!Number.isFinite(n))throw Error('Invalid balance');return n;};
/** Every notice level that applies at this balance, least severe first. */
export function noticeLevels(balanceUsd){
 const b=number(balanceUsd);
 return [b<LOW_USD&&'low',b<=ZERO_USD&&'zero',b<=FINAL_USD&&'final',b<=CUTOFF_USD&&'paused'].filter(Boolean);
}
/** 'ok' | 'low' | 'zero' | 'final' | 'paused' */
export function creditStatus(balanceUsd){return noticeLevels(balanceUsd).at(-1)??'ok';}
export function computeAllowed(balanceUsd){return number(balanceUsd)>CUTOFF_USD;}
/** The lowest balance that may start a workspace billed at `usdPerHour`: the
 * cutoff plus one billing interval of running time. A plan that is not charged
 * (no rate) only needs to be above the cutoff. */
export function startMinimumUsd(usdPerHour){const rate=Number(usdPerHour);return Number.isFinite(rate)&&rate>0?CUTOFF_USD+rate*BILLING_INTERVAL_SECONDS/3600:CUTOFF_USD;}
export function startAllowed(balanceUsd,usdPerHour){const b=number(balanceUsd),minimum=startMinimumUsd(usdPerHour);return b>CUTOFF_USD&&b>=minimum;}
/** How much must be added to bring the balance back above the cutoff. */
export function amountToRestoreUsd(balanceUsd){const owed=CUTOFF_USD-number(balanceUsd);return owed>=0?((Math.floor(owed*100+1e-6)+1)/100).toFixed(2):'0.00';}

/** What saved storage (snapshots and retained disks) costs while an account is
 * paused for credit. `charge` (the default) keeps charging it: it is the cost of
 * keeping the user's files. `hold` stops charging it for as long as the account
 * is paused; the time is not billed later. Set with CANOPY_PAUSED_STORAGE_BILLING. */
export function pausedStorageBilling(env=process.env){
 return String(env.CANOPY_PAUSED_STORAGE_BILLING??'charge').trim().toLowerCase()==='hold'?'hold':'charge';
}

const on=value=>['1','true','yes','on'].includes(String(value??'').trim().toLowerCase());
/** Add funds (Stripe Checkout, credit-purchase.mjs) is offered only when it is
 * switched on and both Stripe secrets are configured. Otherwise users are
 * pointed at "Request more credit". */
export function purchaseEnabled(env=process.env){return on(env.CANOPY_CREDIT_PURCHASE_ENABLED)&&Boolean(env.STRIPE_SECRET_KEY)&&Boolean(env.STRIPE_WEBHOOK_SECRET);}

// Rollout switch. `notify` (the default) only records notices and sends the
// low, zero and final emails; `enforce` also blocks starts and pauses compute
// at the cutoff; `off` disables both. Unset or unknown values mean `notify`:
// accounts already below the cutoff are paused only after an operator grants
// credit and sets CANOPY_CREDIT_ENFORCEMENT=enforce on purpose.
export function enforcementMode(env=process.env){
 const value=String(env.CANOPY_CREDIT_ENFORCEMENT??'notify').trim().toLowerCase();
 return ['enforce','notify','off'].includes(value)?value:'notify';
}

/** Raised instead of starting compute for an account at or below the cutoff.
 * `code` is the HTTP status the API handlers already pass through. */
export class CreditExhaustedError extends Error{
 constructor(balanceUsd,{shared=false,minimumUsd=null}={}){
  // Above the cutoff but short of one billing interval: the start would be
  // paused by its first debit, so it is refused with the amount it needs.
  const short=minimumUsd!=null&&number(balanceUsd)>CUTOFF_USD;
  // Rounded up to the cent, so the amount shown is always enough.
  const minimum=minimumUsd==null?null:Math.ceil(Number(minimumUsd)*100-1e-6)/100;
  // A member resuming a shared workspace is told the owner must add credit,
  // without the owner's balance.
  super(shared?`This shared workspace is paused because its owner's Canopy balance is ${short?'too close to':'past'} the ${formatUsd(CUTOFF_USD)} limit. Ask the owner to add credit. Files are kept.`
   :short?`Your Canopy balance is ${formatUsd(balanceUsd)}. Workspaces pause at ${formatUsd(CUTOFF_USD)}, and starting this one needs at least ${formatUsd(minimum)} so it can run its first ${BILLING_INTERVAL_SECONDS/60} minutes. Add credit to start it. Your files are kept.`
   :`Your Canopy balance is ${formatUsd(balanceUsd)}. Workspaces pause at ${formatUsd(CUTOFF_USD)}, so this workspace can't start until credit is added. Your files are kept.`);
  this.code=402;this.reason='credit_exhausted';this.shared=shared;this.balanceUsd=shared?null:String(balanceUsd);this.cutoffUsd=String(CUTOFF_USD);
  this.minimumUsd=shared||minimum==null?null:minimum.toFixed(2);
 }
 /** Body for the JSON error response: the plain `error` plus machine fields. */
 toJSON(){return {error:this.message,code:this.reason,balanceUsd:this.balanceUsd,cutoffUsd:this.cutoffUsd,shared:this.shared,...(this.minimumUsd==null?{}:{minimumUsd:this.minimumUsd})};}
}

/** Lock the owner's credit account and refuse compute that the balance can't
 * pay for: at or below the cutoff, or (for a charged plan) less than one
 * billing interval above it. `usdPerHour` is the plan's rate, or a function
 * returning it (only called in enforce mode, so other modes add no query).
 * Call inside the caller's transaction after the workspace row is locked: the
 * order workspace -> credit_account matches usage metering, so this cannot
 * deadlock with a debit, and a debit that crosses the cutoff is either seen
 * here or sees the operation this creates (and hibernates it). */
export async function assertComputeAllowed(client,ownerId,action,{env=process.env,shared=false,usdPerHour=null}={}){
 if(!COMPUTE_ACTIONS.includes(action)||enforcementMode(env)!=='enforce')return null;
 const row=(await client.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1 FOR UPDATE',[ownerId])).rows[0];
 const balance=row?.balance??'0';
 if(!computeAllowed(balance))throw new CreditExhaustedError(balance,{shared});
 const rate=typeof usdPerHour==='function'?await usdPerHour():usdPerHour;
 if(!startAllowed(balance,rate))throw new CreditExhaustedError(balance,{shared,minimumUsd:startMinimumUsd(rate)});
 return balance;
}

export function formatUsd(value){
 const n=number(value);const abs=Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return `${n<0&&Number(abs.replace(/,/g,''))>0?'−':''}$${abs}`;
}
