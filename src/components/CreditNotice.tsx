import {useEffect,useRef,useState} from 'react';
import {Button} from './ui';
import {openInOsBrowser} from '../links';
import {creditBanner,openAccountSettings,requestMoreCredit,startCheckout,usd,waitForPurchase,type CreditExhausted,type Credits,type PurchaseOptions} from '../credits';

/** "Request more credit": emails Canopy support from the account. Offered when
 * the server has no Add funds configured, and beside it while the balance is
 * low. */
export function RequestCreditButton({variant='default',lastRequestedAt}:{variant?:'default'|'accent';lastRequestedAt?:string|null}){
 const recent=lastRequestedAt&&Date.now()-new Date(lastRequestedAt).getTime()<86_400_000;
 const [state,setState]=useState<'idle'|'busy'|'sent'|'duplicate'|'error'>(recent?'duplicate':'idle'),[error,setError]=useState('');
 async function send(){
  setState('busy');setError('');
  try{const result=await requestMoreCredit();setState(result.duplicate?'duplicate':'sent');}
  catch(reason){setError(String(reason instanceof Error?reason.message:reason));setState('error');}
 }
 return <div className="credit-request">
  <Button size="sm" variant={variant} disabled={state==='busy'||state==='sent'||state==='duplicate'} onClick={()=>void send()}>{state==='busy'?'Sending…':state==='sent'||state==='duplicate'?'Credit requested':'Request more credit'}</Button>
  {state==='sent'&&<small role="status">Request sent. Canopy support will reply by email.</small>}
  {state==='duplicate'&&<small role="status">You asked in the last day. Canopy support will reply by email.</small>}
  {state==='error'&&<small role="alert">Couldn’t send the request: {error}</small>}
 </div>;
}

/** "Add funds": pick an amount, pay on Stripe's page in the browser, and the
 * balance updates here when the payment is credited (the account page also
 * refreshes on focus). */
export function AddFunds({options,onCredits}:{options:PurchaseOptions;onCredits?:(credits:Credits)=>void}){
 const presets=options.presetsUsd.length?options.presetsUsd:[10,25,50,100];
 const [choice,setChoice]=useState<number|'custom'>(presets[1]??presets[0]),[custom,setCustom]=useState('');
 const [state,setState]=useState<'idle'|'opening'|'waiting'|'done'|'slow'|'error'>('idle'),[note,setNote]=useState('');
 const waiting=useRef<AbortController|null>(null);
 useEffect(()=>()=>waiting.current?.abort(),[]);
 const amount=choice==='custom'?Number(custom):choice;
 const valid=Number.isFinite(amount)&&amount>=options.minUsd&&amount<=options.maxUsd&&Math.round(amount*100)===amount*100;
 async function pay(){
  if(!valid)return;
  waiting.current?.abort();const controller=new AbortController();waiting.current=controller;
  setState('opening');setNote('');
  try{
   const checkout=await startCheckout(amount);if(controller.signal.aborted)return;
   openInOsBrowser(checkout.url);setState('waiting');
   const credited=await waitForPurchase(checkout.sessionId,{signal:controller.signal,onCredits});
   if(controller.signal.aborted)return;
   if(credited){setState('done');setNote(`${usd(Number(checkout.amountUsd))} added. Stripe emailed your receipt.`);}
   else setState('slow');
  }catch(reason){if(!controller.signal.aborted){setState('error');setNote(String(reason instanceof Error?reason.message:reason));}}
 }
 const busy=state==='opening'||state==='waiting';
 return <div className="credit-add-funds" role="group" aria-label="Add funds">
  <div className="credit-add-funds-amounts">
   {presets.map(value=><Button key={value} size="sm" variant={choice===value?'accent':'default'} aria-pressed={choice===value} disabled={busy} onClick={()=>setChoice(value)}>{usd(value)}</Button>)}
   <Button size="sm" variant={choice==='custom'?'accent':'default'} aria-pressed={choice==='custom'} disabled={busy} onClick={()=>setChoice('custom')}>Other</Button>
   {choice==='custom'&&<label className="credit-add-funds-custom"><span>Amount in USD</span><input type="number" inputMode="decimal" min={options.minUsd} max={options.maxUsd} step="0.01" value={custom} disabled={busy} onChange={event=>setCustom(event.target.value)} aria-invalid={custom!==''&&!valid}/></label>}
  </div>
  <Button size="sm" variant="accent" disabled={busy||!valid} onClick={()=>void pay()}>{state==='opening'?'Opening checkout…':valid?`Add ${usd(amount)}`:'Add funds'}</Button>
  {choice==='custom'&&custom!==''&&!valid&&<small role="alert">Choose an amount from {usd(options.minUsd)} to {usd(options.maxUsd)}.</small>}
  {state==='waiting'&&<small role="status">Finish paying in your browser. Your balance updates here when the payment arrives. <button type="button" className="credit-link-button" onClick={()=>{waiting.current?.abort();setState('idle');}}>Cancel</button></small>}
  {state==='done'&&<small role="status">{note}</small>}
  {state==='slow'&&<small role="status">We haven’t received the payment yet. If you paid, your balance updates within a few minutes.</small>}
  {state==='error'&&<small role="alert">Couldn’t start checkout: {note}</small>}
 </div>;
}

export function CreditBanner({credits}:{credits:Credits|null}){
 const banner=creditBanner(credits);if(!banner)return null;
 return <div className={`credit-banner credit-banner-${banner.tone}`} role={banner.tone==='error'?'alert':'status'}><strong>{banner.title}</strong><p>{banner.body}</p></div>;
}

/** Shown in place of a generic startup error when the control plane refuses
 * to start compute for an exhausted balance. */
export function CreditExhaustedNotice({detail}:{detail:CreditExhausted}){
 return <div className="credit-banner credit-banner-error" role="alert">
  <strong>{detail.shared?'Workspace paused by its owner’s balance':'Workspace paused: out of credit'}</strong>
  <p>{detail.shared?detail.message:detail.minimumUsd!=null&&detail.balanceUsd!=null&&detail.balanceUsd>detail.cutoffUsd?`Your balance is ${usd(detail.balanceUsd)}. Workspaces pause at ${usd(detail.cutoffUsd)}, so starting needs at least ${usd(detail.minimumUsd)} to cover the first few minutes. Your files and settings are kept.`:`Your balance is ${detail.balanceUsd==null?'past the limit':usd(detail.balanceUsd)}. Workspaces can’t start at or below ${usd(detail.cutoffUsd)}. Your files and settings are kept.`}</p>
  {!detail.shared&&<div className="credit-banner-actions"><RequestCreditButton variant="accent"/><Button size="sm" variant="ghost" onClick={openAccountSettings}>Add funds or view balance</Button></div>}
 </div>;
}
