// Add funds: Stripe Checkout for workspace credit. Pure functions; the API
// handlers (api/credits/checkout.ts, api/stripe/webhook.ts) pass in a Stripe
// client, so this module has no dependency on the stripe package.
//
// A purchase is credited only by the signed webhook, never by the browser
// returning from Checkout. The amount credited is what Stripe says was paid
// (amount_total), and the checkout session id is the ledger request key, so a
// webhook delivered twice (or both completed and async_payment_succeeded)
// credits once. See docs/credits.md.
import {grantCredit} from './credit-enforcement.mjs';
import {invitationPublicOrigin} from './invitation-url.mjs';
import {purchaseEnabled} from './credit-policy.mjs';
export {purchaseEnabled};

export const PURCHASE_PRESETS_USD=Object.freeze([10,25,50,100]);
export const PURCHASE_MIN_USD=5;
export const PURCHASE_MAX_USD=500;
// Marks sessions this service created; other Checkout sessions on the same
// Stripe account are ignored by the webhook.
export const PURCHASE_PURPOSE='canopy-credit';
const CREDIT_EVENTS=new Set(['checkout.session.completed','checkout.session.async_payment_succeeded']);

/** What GET /api/credits tells the desktop about adding funds. */
export function purchaseOptions(env=process.env){return {enabled:purchaseEnabled(env),currency:'USD',presetsUsd:[...PURCHASE_PRESETS_USD],minUsd:PURCHASE_MIN_USD,maxUsd:PURCHASE_MAX_USD};}

/** Whole cents from a dollar amount (number or string, at most two decimals)
 * within the purchase limits. */
export function purchaseCents(amountUsd){
 const text=typeof amountUsd==='number'?String(amountUsd):typeof amountUsd==='string'?amountUsd.trim():'';
 if(!/^\d{1,4}(?:\.\d{1,2})?$/.test(text))throw Object.assign(Error(`Choose an amount between $${PURCHASE_MIN_USD} and $${PURCHASE_MAX_USD}`),{code:400});
 const cents=Math.round(Number(text)*100);
 if(cents<PURCHASE_MIN_USD*100||cents>PURCHASE_MAX_USD*100)throw Object.assign(Error(`Choose an amount between $${PURCHASE_MIN_USD} and $${PURCHASE_MAX_USD}`),{code:400});
 return cents;
}

/** Parameters for stripe.checkout.sessions.create. Stripe emails the receipt
 * (receipt_email) and hosts the payment page; the user returns to the
 * workspaces page, and the desktop notices the credit by polling. */
export function checkoutSessionParams({user,cents,origin=invitationPublicOrigin()}){
 if(!user?.id||!user.email)throw Object.assign(Error('Sign in first'),{code:401});
 const metadata={purpose:PURCHASE_PURPOSE,canopy_user_id:String(user.id)};
 return {
  mode:'payment',submit_type:'pay',
  client_reference_id:String(user.id),customer_email:user.email,
  line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:cents,product_data:{name:'Canopy workspace credit',description:'Added to your Canopy balance. Workspace running time and storage are charged from it.'}}}],
  metadata,payment_intent_data:{receipt_email:user.email,description:'Canopy workspace credit',metadata},
  success_url:new URL('/workspaces?funds=added',origin).href,
  cancel_url:new URL('/workspaces?funds=cancelled',origin).href,
 };
}

/** Create a Checkout Session for the signed-in user. Returns the hosted
 * payment page URL to open in the browser. */
export async function createCreditCheckout(stripe,{user,amountUsd,origin,env=process.env}){
 if(!purchaseEnabled(env))throw Object.assign(Error('Adding funds is not available yet. Request more credit instead.'),{code:503,reason:'purchase_unavailable'});
 const cents=purchaseCents(amountUsd);
 const session=await stripe.checkout.sessions.create(checkoutSessionParams({user,cents,origin}));
 if(!session?.url||!session.id)throw Object.assign(Error('Checkout could not be started'),{code:502});
 return {url:session.url,sessionId:session.id,amountUsd:(cents/100).toFixed(2),expiresAt:session.expires_at?new Date(session.expires_at*1000).toISOString():null};
}

/** Apply one verified webhook event. Call inside a transaction. Credits a paid
 * Canopy checkout once; everything else is acknowledged and ignored. */
export async function applyCheckoutEvent(client,event,{log=console}={}){
 if(!CREDIT_EVENTS.has(event?.type))return {handled:false};
 const session=event.data?.object??{};
 if(session.metadata?.purpose!==PURCHASE_PURPOSE)return {handled:false,reason:'not-canopy-credit'};
 // An asynchronous payment method completes later with async_payment_succeeded.
 if(session.mode!=='payment'||session.payment_status!=='paid')return {handled:true,applied:false,reason:'not-paid'};
 if(String(session.currency).toLowerCase()!=='usd'||!Number.isInteger(session.amount_total)||session.amount_total<=0){log?.warn?.('Stripe checkout with an unexpected amount',session.id);return {handled:true,applied:false,reason:'unexpected-amount'};}
 const userId=session.metadata.canopy_user_id??session.client_reference_id;
 try{
  const result=await grantCredit(client,{userId,amountUsd:(session.amount_total/100).toFixed(2),reason:`Stripe payment ${session.payment_intent??session.id}`,actor:`stripe:${event.id}`,requestKey:session.id,source:'purchase'});
  return {handled:true,applied:result.applied,userId,balanceUsd:result.balanceUsd,sessionId:session.id};
 }catch(error){
  // A deleted account can't be credited; acknowledge so Stripe stops retrying
  // and leave the payment to be refunded from the Stripe dashboard.
  if(error?.code===404){log?.warn?.('Stripe checkout for an unknown user',session.id);return {handled:true,applied:false,reason:'unknown-user'};}
  throw error;
 }
}

/** HTTP status and JSON body for a checkout request, shared by
 * POST /api/credits/checkout and POST /api/credits {action:'checkout'}.
 * `stripe` is the client, or null when no key is configured. */
export async function checkoutResponse(stripe,{user,amountUsd,env=process.env,log=console}){
 try{return {status:200,body:await createCreditCheckout(stripe,{user,amountUsd,env})};}
 catch(error){
  const known=typeof error?.code==='number';
  if(!known)log?.error?.('Checkout failed',error?.message);
  return {status:known?error.code:502,body:{error:known?error.message:'Checkout could not be started. Try again.',...(error?.reason?{code:error.reason}:{})}};
 }
}
