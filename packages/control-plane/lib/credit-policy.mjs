// Credit policy: every threshold that changes what a user is told or allowed
// to do lives here. Amounts are US dollars, compared against
// credit_account.balance_usd. Balances are per user (credit_account.user_id);
// a workspace bills its owner, including time a shared member resumes.
//
// Reminders are a share of the account's alert base: the balance right after
// its last credit (credit_account.alert_base_usd).
//
//   balance <  MIN_START_USD  nothing can be created, started, resumed or
//                             resized until credit is added
//   balance <= 30% of base    pct30   reminder email, in-app warning
//   balance <= 15% of base    pct15   reminder email, in-app warning
//   balance <=  5% of base    pct5    final reminder before deletion
//   balance <= CUTOFF_USD     paused  every workspace is permanently deleted:
//                                     compute, disks, snapshots and files
//
// The account, sign-in and ledger are untouched. The MIN_START_USD floor applies
// in notify and enforce. Deletion applies only with
// CANOPY_CREDIT_ENFORCEMENT=enforce (enforcementMode below; the default is notify).
// See docs/credits.md.
// Default "below" for the admin low-balance list. Not a reminder threshold.
export const LOW_USD=5;
export const ZERO_USD=0;
export const CUTOFF_USD=0;
// The balance needed to create or start anything.
export const MIN_START_USD=5;
export const ALERT_SHARES=Object.freeze({pct30:0.30,pct15:0.15,pct5:0.05});
export const CREDIT_POLICY=Object.freeze({lowUsd:LOW_USD,zeroUsd:ZERO_USD,finalUsd:CUTOFF_USD,cutoffUsd:CUTOFF_USD,minimumUsd:MIN_START_USD});
// Running time is debited in five-minute intervals (metering.mjs). A start
// must leave room for one of them above the cutoff, so a workspace that starts
// is never deleted by its very first debit (assertComputeAllowed).
export const BILLING_INTERVAL_SECONDS=300;
// Most severe last. Each notice is sent once per crossing and re-armed when the
// balance recovers past it (credit-enforcement.mjs).
export const NOTICE_LEVELS=Object.freeze(['pct30','pct15','pct5','paused']);
// Levels from before percentage alerts. Rows may remain; they only ever close.
export const RETIRED_NOTICE_LEVELS=Object.freeze(['low','zero','final']);
// Actions that create or start compute. Stop and delete are never blocked.
export const COMPUTE_ACTIONS=Object.freeze(['resume','retry','resize','grow-storage']);

const number=value=>{const n=typeof value==='number'?value:Number(value);if(!Number.isFinite(n))throw Error('Invalid balance');return n;};
// The base can trail the balance (an unrecorded credit): never measure against
// less than what the account holds now.
const alertBase=(balance,baseUsd)=>Math.max(balance,baseUsd==null?0:number(baseUsd));
/** Every notice level that applies at this balance, least severe first. */
export function noticeLevels(balanceUsd,baseUsd=null){
 const b=number(balanceUsd),base=alertBase(b,baseUsd);
 const shares=base>0?Object.entries(ALERT_SHARES).filter(([,share])=>b<=base*share).map(([level])=>level):[];
 return b<=CUTOFF_USD?[...shares,'paused']:shares;
}
// Desktops know these status names, so a percentage level maps onto them.
const STATUS=Object.freeze({pct30:'low',pct15:'low',pct5:'final',paused:'paused'});
/** 'ok' | 'low' | 'final' | 'paused' */
export function creditStatus(balanceUsd,baseUsd=null){return STATUS[noticeLevels(balanceUsd,baseUsd).at(-1)]??'ok';}
/** The policy one account sees: its own dollar thresholds for the desktop. */
export function accountPolicy(balanceUsd,baseUsd=null){
 const base=alertBase(number(balanceUsd),baseUsd);
 return {...CREDIT_POLICY,lowUsd:base*ALERT_SHARES.pct30,finalUsd:base*ALERT_SHARES.pct5};
}
export function computeAllowed(balanceUsd){return number(balanceUsd)>CUTOFF_USD;}
/** The lowest balance that may start a workspace billed at `usdPerHour`: the
 * floor, or one billing interval above the cutoff for a plan that costs more. */
export function startMinimumUsd(usdPerHour){const rate=Number(usdPerHour);return Math.max(MIN_START_USD,Number.isFinite(rate)&&rate>0?CUTOFF_USD+rate*BILLING_INTERVAL_SECONDS/3600:0);}
export function startAllowed(balanceUsd,usdPerHour=null){const b=number(balanceUsd);return b>CUTOFF_USD&&b>=startMinimumUsd(usdPerHour);}
/** How much must be added to reach the balance that creates or starts anything. */
export function amountToRestoreUsd(balanceUsd){const owed=MIN_START_USD-number(balanceUsd);return owed>0?(Math.ceil(owed*100-1e-6)/100).toFixed(2):'0.00';}

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

// Rollout switch. `notify` (the default) records notices, sends the reminder
// emails and applies the MIN_START_USD floor, but deletes nothing. `enforce` also
// deletes workspaces at the cutoff. `off` disables all of it. Unset or unknown
// values mean `notify`: deletion runs only after an operator sets
// CANOPY_CREDIT_ENFORCEMENT=enforce on purpose.
export function enforcementMode(env=process.env){
 const value=String(env.CANOPY_CREDIT_ENFORCEMENT??'notify').trim().toLowerCase();
 return ['enforce','notify','off'].includes(value)?value:'notify';
}

/** Raised instead of creating or starting compute below the floor.
 * `code` is the HTTP status the API handlers already pass through. */
export class CreditExhaustedError extends Error{
 constructor(balanceUsd,{shared=false,minimumUsd=MIN_START_USD}={}){
  // Rounded up to the cent, so the amount shown is always enough.
  const minimum=Math.ceil(Number(minimumUsd)*100-1e-6)/100;
  // A member resuming a shared workspace is told the owner must add credit,
  // without the owner's balance.
  super(shared?'This shared workspace can’t start because its owner’s Canopy balance is too low. Ask the owner to add credit.'
   :`Your Canopy balance is ${formatUsd(balanceUsd)}. You need at least ${formatUsd(minimum)} to create or start a workspace. Add credit first.`);
  this.code=402;this.reason='credit_exhausted';this.shared=shared;this.balanceUsd=shared?null:String(balanceUsd);this.cutoffUsd=String(CUTOFF_USD);
  this.minimumUsd=shared?null:minimum.toFixed(2);
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
 if(!COMPUTE_ACTIONS.includes(action)||enforcementMode(env)==='off')return null;
 const row=(await client.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1 FOR UPDATE',[ownerId])).rows[0];
 const balance=row?.balance??'0';
 const rate=typeof usdPerHour==='function'?await usdPerHour():usdPerHour;
 if(!startAllowed(balance,rate))throw new CreditExhaustedError(balance,{shared,minimumUsd:startMinimumUsd(rate)});
 return balance;
}

export function formatUsd(value){
 const n=number(value);const abs=Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return `${n<0&&Number(abs.replace(/,/g,''))>0?'−':''}$${abs}`;
}
/** Refuse a new workspace below the floor. An account with no balance row holds
 * nothing, so it is refused too. */
export async function assertCanCreateWorkspace(client,ownerId,{env=process.env}={}){
 if(enforcementMode(env)==='off')return null;
 const row=(await client.query('SELECT balance_usd::text balance FROM credit_account WHERE user_id=$1 FOR UPDATE',[ownerId])).rows[0];
 const balance=row?.balance??'0';
 if(!startAllowed(balance))throw new CreditExhaustedError(balance);
 return balance;
}
